import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import { loadEnv } from '@ijime/config';
import { KmsKeyWrapper, TokenVault, kmsKeyPath } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { GoogleCalendarApi, Logger } from '@ijime/service-kit';

import type { CalendarSyncDeps } from './deps.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export async function createRuntime(
  overrides: Partial<CalendarSyncDeps> = {},
): Promise<CalendarSyncDeps> {
  const env = loadEnv();
  const prod = env.NODE_ENV === 'production';
  const kb =
    overrides.kb ?? (await Kb.load(new FsKbSource(resolve(env.KB_LOCAL_DIR ?? 'kb/v0.1.0'))));
  const db = overrides.db ?? new Firestore({ projectId: env.GCP_PROJECT_ID ?? 'demo-ijime' });
  let vault = overrides.vault;
  if (!vault) {
    if (prod) {
      const { KeyManagementServiceClient } = await import('@google-cloud/kms');
      const keyName = kmsKeyPath({
        projectId: env.GCP_PROJECT_ID!,
        location: env.GCP_REGION,
        keyRing: env.KMS_KEY_RING,
        key: 'tokens',
      });
      vault = new TokenVault(new KmsKeyWrapper(new KeyManagementServiceClient() as never, keyName));
    } else {
      vault = TokenVault.dev();
    }
  }
  return {
    db,
    kb,
    vault,
    calendar:
      overrides.calendar ??
      new GoogleCalendarApi({
        clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
        clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
        redirectUri: required('CALENDAR_OAUTH_REDIRECT_URI'),
      }),
    logger: overrides.logger ?? new Logger('calendar-sync'),
    now: overrides.now ?? (() => new Date()),
  };
}
