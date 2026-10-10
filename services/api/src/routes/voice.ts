import { randomBytes } from 'node:crypto';

import type { VoiceTicketRes } from '@ijime/api-types';
import { childPath, remainingVoiceSeconds, voiceDisabled } from '@ijime/agent-core';
import { voice as voiceConfig } from '@ijime/config';
import {
  ApiHttpError,
  VOICE_TICKETS,
  tokenDigest,
  type ServiceApp,
  type ServiceEnv,
} from '@ijime/service-kit';
import type { Hono } from 'hono';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';

const VOICE_OFF =
  'いまは こえで はなせないよ。もじで はなしてね。困ったときの連絡先はいつでも開けるよ。';
const VOICE_LIMIT =
  'きょうの こえの おはなしは ここまで。もじなら つづけて はなせるよ。困ったときの連絡先はいつでも開けるよ。';

// 音声チケット：60 秒有効、1回限り、子どもに紐づく。voice-relay がトランザクションで消費する
export function registerVoice(
  app: ServiceApp,
  getDeps: () => Promise<ChatDeps>,
  wsUrl: string,
  now: () => Date = () => new Date(),
): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child/voice');
  r.use('*', async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.post('/tickets', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    const child = await deps.directory.lookup(childId);
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    const doc = (await deps.db.doc(childPath(child.familyId, childId)).get()).data();
    const sources = (doc?.['dataSources'] ?? {}) as Record<string, boolean>;
    if (sources['voice'] === false)
      throw new ApiHttpError(
        'DATA_SOURCE_DISABLED',
        'こえで はなす せっていが オフに なっています',
      );
    if (await voiceDisabled(deps.db)) throw new ApiHttpError('MODEL_UNAVAILABLE', VOICE_OFF);

    const issuedAt = now();
    if ((await remainingVoiceSeconds(deps.db, child, issuedAt)) <= 0)
      throw new ApiHttpError('RATE_LIMITED', VOICE_LIMIT);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(issuedAt.getTime() + voiceConfig.ticketTtlSeconds * 1000);
    await deps.db.collection(VOICE_TICKETS).doc(tokenDigest(ticket)).set({
      childId,
      familyId: child.familyId,
      createdAt: issuedAt,
      expiresAt,
    });
    const body: VoiceTicketRes = { ticket, wsUrl, expiresAt: expiresAt.toISOString() };
    return c.json(body);
  });
}
