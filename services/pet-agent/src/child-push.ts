import type { Firestore } from '@google-cloud/firestore';
import type { ChildDirectory } from '@ijime/agent-core';
import type { ProactiveTurnReq } from '@ijime/api-types';
import { agent } from '@ijime/config';
import type { Kb } from '@ijime/kb-loader';
import { AdcGoogleHttp, GoogleHttpError, type GoogleHttp } from '@ijime/service-kit';
import { z } from 'zod';

import { jstParts } from './context.js';

export type ChildPushResult = {
  status: 'sent' | 'skipped' | 'failed';
  sent: number;
  removed: number;
  failed: number;
};
export interface ChildPushSender {
  send(task: ProactiveTurnReq & { turnId: string }): Promise<ChildPushResult>;
}

const copySchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(240),
});

function staleToken(error: unknown): boolean {
  if (!(error instanceof GoogleHttpError) || ![400, 404].includes(error.status)) return false;
  try {
    const body = JSON.parse(error.responseText) as {
      error?: { details?: { '@type'?: string; errorCode?: string }[] };
    };
    return (
      body.error?.details?.some(
        (detail) =>
          detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
          ['UNREGISTERED', 'INVALID_ARGUMENT'].includes(detail.errorCode ?? ''),
      ) === true
    );
  } catch {
    return false;
  }
}

export async function createChildPushSender(options: {
  db: Firestore;
  directory: ChildDirectory;
  kb: Kb;
  env?: NodeJS.ProcessEnv;
  http?: GoogleHttp;
  now?: () => Date;
}): Promise<ChildPushSender | undefined> {
  const env = options.env ?? process.env;
  if (env['CHILD_PUSH_ENABLED'] !== 'true') return undefined;
  const project = env['GCP_PROJECT_ID'];
  let origin: URL;
  try {
    origin = new URL(env['CHILD_WEB_ORIGIN'] ?? '');
  } catch {
    throw new Error('child_push_origin_required');
  }
  if (!project || !/^[a-z][a-z0-9-]+$/.test(project))
    throw new Error('child_push_project_required');
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('child_push_https_origin_required');
  const copy = await options.kb.yaml('prompts/child_push.yaml', copySchema);
  const http = options.http ?? new AdcGoogleHttp();
  const now = options.now ?? (() => new Date());

  return {
    async send(task) {
      const result: ChildPushResult = { status: 'skipped', sent: 0, removed: 0, failed: 0 };
      if (
        !/^[a-zA-Z0-9_-]+$/.test(task.childId) ||
        task.turnId !== `${task.localDate}-${task.slot}`
      )
        return result;
      const child = await options.directory.lookup(task.childId);
      if (!child) return result;
      const family = options.db.doc(`families/${child.familyId}`);
      const ownerRef = family.collection('children').doc(task.childId);
      const allowed = async () => {
        const at = jstParts(now());
        if (at.date !== task.localDate || at.hour >= 23 || at.hour < 5) return false;
        const owner = await ownerRef.get();
        const household = await family.get();
        const slots = owner.get('proactiveSlots');
        if (
          household.get('status') !== 'active' ||
          owner.get('status') !== 'active' ||
          owner.get('assentComplete') !== true ||
          owner.get('proactiveEnabled') === false ||
          (Array.isArray(slots) && !slots.includes(task.slot))
        )
          return false;
        const crises = await ownerRef
          .collection('crisisEvents')
          .where('status', '==', 'open')
          .limit(1)
          .get();
        return crises.empty;
      };
      if (!(await allowed())) return result;
      const devices = await family.collection('devices').where('ownerId', '==', task.childId).get();
      for (const device of devices.docs) {
        if (!(await allowed())) break;
        // Re-read so revocation or an account switch after listing cannot send to the old owner.
        const current = await device.ref.get();
        const token: unknown = current.get('fcmToken');
        if (
          current.get('ownerType') !== 'child' ||
          current.get('ownerId') !== task.childId ||
          typeof token !== 'string' ||
          !token
        )
          continue;
        try {
          await http.request({
            method: 'POST',
            url: `https://fcm.googleapis.com/v1/projects/${project}/messages:send`,
            retry: false,
            timeoutMs: agent.childPushTimeoutMs,
            body: {
              message: {
                token,
                data: {
                  kind: 'child_greeting',
                  deviceId: device.id,
                  title: copy.title,
                  body: copy.body,
                  url: origin.href,
                },
                webpush: { headers: { TTL: '0', Urgency: 'normal' } },
              },
            },
          });
          result.sent++;
        } catch (error) {
          if (staleToken(error)) {
            const removed = await options.db.runTransaction(async (tx) => {
              const saved = await tx.get(device.ref);
              if (
                saved.get('ownerType') === 'child' &&
                saved.get('ownerId') === task.childId &&
                saved.get('fcmToken') === token
              ) {
                tx.delete(device.ref);
                return true;
              }
              return false;
            });
            if (removed) result.removed++;
          } else result.failed++;
        }
      }
      result.status = result.failed ? 'failed' : result.sent ? 'sent' : 'skipped';
      return result;
    },
  };
}
