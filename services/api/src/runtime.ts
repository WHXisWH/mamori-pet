import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import {
  LocalChildDirectory,
  FirestoreChildDirectory,
  FirestoreSessionService,
  type ChildDirectory,
} from '@ijime/agent-core';
import { loadEnv, models } from '@ijime/config';
import {
  EnvelopeCipher,
  KmsKeyWrapper,
  KmsPseudonymizer,
  LocalKeyWrapper,
  LocalPseudonymizer,
  TokenVault,
  kmsKeyPath,
  type KeyWrapper,
  type Pseudonymizer,
} from '@ijime/crypto';
import {
  childRepliesSchema,
  FsKbSource,
  Kb,
  loadGames,
  openingsSchema,
  petRequestRepliesSchema,
} from '@ijime/kb-loader';
import type { PubSubTopic } from '@ijime/api-types';
import {
  GoogleCalendarApi,
  Logger,
  PubSubRestPublisher,
  type OAuthClientConfig,
} from '@ijime/service-kit';

import { GcsArtworkImages, MemoryArtworkImages, signalWorkerClientFromEnv } from './artwork-io.js';
import type { ChatDeps } from './chat.js';
import { createRuntimeDetector, loadSafeModeCopy } from '@ijime/crisis-detector';
import { petAgentClientFromEnv, type PetAgentClient } from './pet-agent-client.js';
import type { CalendarRoutesDeps } from './routes/calendar.js';
import { loadHelpResources } from './routes/help-resources.js';
import type { NotificationRoutesDeps } from './routes/notifications.js';
import type { SubmissionDeps } from './routes/submissions.js';
import type { AccountDeps } from './routes/accounts.js';
import { emailReauthConsentVerifier, identityPlatformIssuer } from './issuer.js';

export type ApiRuntime = {
  kb: Kb;
  chat: ChatDeps;
  submissions: SubmissionDeps;
  guardian: NotificationRoutesDeps;
  accounts: AccountDeps;
  // Google OAuth クライアントが未設定のとき（ローカル開発）は空
  calendar?: CalendarRoutesDeps;
};

function oauthClient(prod: boolean): OAuthClientConfig | undefined {
  const names = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'CALENDAR_OAUTH_REDIRECT_URI',
  ] as const;
  const [clientId, clientSecret, redirectUri] = names.map((n) => process.env[n]);
  if (clientId && clientSecret && redirectUri) return { clientId, clientSecret, redirectUri };
  // 一部だけ設定されているのはデプロイの誤り。1つも設定されていなければカレンダーを無効にする（保護者用の Google OAuth クライアントは任意）
  if (prod && (clientId || clientSecret || redirectUri))
    throw new Error(`missing env ${names.join(' / ')}`);
  return undefined;
}

async function createCalendarDeps(
  env: ReturnType<typeof loadEnv>,
  db: Firestore,
  logger: Logger,
): Promise<CalendarRoutesDeps | undefined> {
  const prod = env.NODE_ENV === 'production';
  const client = oauthClient(prod);
  if (!client) {
    if (prod) logger.warn('calendar.disabled', { reason: 'oauth_client_not_configured' });
    return undefined;
  }
  let vault = TokenVault.dev();
  if (prod) {
    const { KeyManagementServiceClient } = await import('@google-cloud/kms');
    const keyName = kmsKeyPath({
      projectId: env.GCP_PROJECT_ID!,
      location: env.GCP_REGION,
      keyRing: env.KMS_KEY_RING,
      key: 'tokens',
    });
    vault = new TokenVault(new KmsKeyWrapper(new KeyManagementServiceClient() as never, keyName));
  }
  const stateSecret = process.env['CALENDAR_OAUTH_STATE_SECRET'];
  if (prod && !stateSecret) throw new Error('missing env CALENDAR_OAUTH_STATE_SECRET');
  return {
    db,
    auth: { allowDevHeader: !prod },
    calendar: new GoogleCalendarApi(client),
    vault,
    stateSecret: stateSecret ?? 'dev-calendar-state-secret',
    guardianWebOrigin: process.env['GUARDIAN_WEB_ORIGIN'] ?? 'http://localhost:3001',
    logger,
    now: () => new Date(),
  };
}

async function readCoaching(kb: Kb): Promise<ChatDeps['coaching']> {
  const read = async (g: string) =>
    (await kb.text(`templates/coaching/${g}.ja.txt`))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  return { low: await read('low'), high: await read('high'), jhs: await read('jhs') };
}

export async function createApiRuntime(
  overrides: Partial<ChatDeps> &
    Partial<Pick<SubmissionDeps, 'images' | 'artworkFeatures' | 'now'>> & {
      kb?: Kb;
      accounts?: Partial<AccountDeps>;
    } = {},
): Promise<ApiRuntime> {
  const env = loadEnv();
  const logger = overrides.logger ?? new Logger('api');
  const kb =
    overrides.kb ?? (await Kb.load(new FsKbSource(resolve(env.KB_LOCAL_DIR ?? 'kb/v0.1.0'))));
  const db = overrides.db ?? new Firestore({ projectId: env.GCP_PROJECT_ID ?? 'demo-ijime' });

  let wrapper: KeyWrapper = new LocalKeyWrapper(Buffer.alloc(32, 7));
  let pseudonymizer: Pseudonymizer = new LocalPseudonymizer(Buffer.alloc(32, 8));
  if (env.NODE_ENV === 'production') {
    const { KeyManagementServiceClient } = await import('@google-cloud/kms');
    const client = new KeyManagementServiceClient();
    wrapper = new KmsKeyWrapper(
      client as never,
      kmsKeyPath({
        projectId: env.GCP_PROJECT_ID!,
        location: env.GCP_REGION,
        keyRing: env.KMS_KEY_RING,
        key: 'content',
      }),
    );
    const pseudoKeyVersion = process.env['PSEUDO_KMS_KEY_VERSION'];
    pseudonymizer = pseudoKeyVersion
      ? new KmsPseudonymizer(client as never, pseudoKeyVersion)
      : {
          pseudonymize: async () => {
            throw new Error('pseudonymizer_not_configured');
          },
        };
  }
  let directory: ChildDirectory | undefined = overrides.directory;
  if (!directory) {
    if (env.NODE_ENV === 'production') {
      directory = new FirestoreChildDirectory(db, wrapper);
    } else {
      directory = new LocalChildDirectory(db, wrapper);
    }
  }

  const sessions = overrides.sessions ?? new FirestoreSessionService(db, directory);
  const detector = overrides.detector ?? (await createRuntimeDetector(kb));
  const petAgent: PetAgentClient =
    overrides.petAgent ?? petAgentClientFromEnv(env.NODE_ENV === 'production');
  const openings =
    overrides.openings ?? (await kb.yaml('prompts/openings.yaml', openingsSchema)).openings;
  const safeModeCopy = overrides.safeModeCopy ?? (await loadSafeModeCopy(kb));
  const hotlines = overrides.hotlines ?? (await loadHelpResources(kb)).resources;
  const coaching = overrides.coaching ?? (await readCoaching(kb));
  let publish = overrides.publish;
  if (!publish) {
    if (env.GCP_PROJECT_ID && (env.NODE_ENV === 'production' || env.PUBSUB_EMULATOR_HOST)) {
      const publisher = PubSubRestPublisher.fromEnv(env.GCP_PROJECT_ID);
      publish = (topic, payload) => publisher.publish(topic as PubSubTopic, payload as never);
    } else {
      publish = async (topic, payload) => {
        logger.info('pubsub.publish_skipped', { topic, keys: Object.keys(payload) });
      };
    }
  }
  const auth = overrides.auth ?? { allowDevHeader: env.NODE_ENV !== 'production' };

  const calendar = await createCalendarDeps(env, db, logger);

  const prod = env.NODE_ENV === 'production';
  const bucket = process.env['ARTWORKS_BUCKET'];
  if (prod && !bucket) throw new Error('missing env ARTWORKS_BUCKET');
  const games = await loadGames(kb);
  // 作品特徴のリトライは最大1回。そこにネットワークの余裕を少し足す
  const featureTimeoutMs = (models.artworkFeature.timeoutMs ?? 30000) * 2 + 10_000;

  const submissions: SubmissionDeps = {
    db,
    sessions,
    directory,
    detector,
    safeModeCopy,
    hotlines,
    auth,
    logger,
    publish,
    replies: await kb.yaml('templates/child_replies.ja.yaml', childRepliesSchema),
    petRequestReplies: (await kb.yaml('templates/child_replies.ja.yaml', petRequestRepliesSchema))
      .pet_request,
    games,
    images: overrides.images ?? (bucket ? new GcsArtworkImages(bucket) : new MemoryArtworkImages()),
    artworkFeatures: overrides.artworkFeatures ?? signalWorkerClientFromEnv(prod, featureTimeoutMs),
    now: overrides.now ?? (() => new Date()),
  };

  return {
    kb,
    accounts: {
      db,
      auth,
      cipher: new EnvelopeCipher(wrapper),
      pseudonymizer,
      ...(env.NODE_ENV !== 'production'
        ? {
            issuer: {
              developmentOnly: true,
              setGuardianClaims: async () => {},
              issueChildToken: async (claims: { childId: string }) =>
                `local-demo:${claims.childId}`,
            },
          }
        : env.GCP_PROJECT_ID
          ? {
              issuer: identityPlatformIssuer(env.GCP_PROJECT_ID),
              verifyConsent: emailReauthConsentVerifier(overrides.now),
            }
          : {}),
      now: overrides.now ?? (() => new Date()),
      ...overrides.accounts,
    },
    submissions,
    guardian: { db, auth },
    ...(calendar ? { calendar } : {}),
    chat: {
      db,
      sessions,
      directory,
      detector,
      petAgent,
      openings,
      safeModeCopy,
      hotlines,
      coaching,
      auth,
      logger,
      publish,
    },
  };
}
