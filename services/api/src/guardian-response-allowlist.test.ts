import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import type {
  ConsentsRes,
  ContextEvent,
  HelpResource,
  MeRes,
  NotificationDetail,
  NotificationFeedback,
  NotificationSummary,
  NotifySettingsReq,
  WeeklyReportRes,
} from '@ijime/api-types';
import { EnvelopeCipher, LocalKeyWrapper, LocalPseudonymizer } from '@ijime/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// 保護者側レスポンスのフィールド許可リスト（保護者側の API は会話の原文、リスクレベル、作品の解釈を返さない）：
// データベースにはリスクレベル、原文の暗号文、根拠の抜粋、作品の解釈などのフィールドが一緒に入っている。保護者側の各読み取り API のレスポンスには
// api-types で宣言したフィールドしか出してはならず、入れ子のオブジェクトも同じである。フィールドを1つ足すだけでそれらが漏れうるため、
// 既知の危険なフィールド名をいくつか調べるのではなく、型に沿って階層ごとに照合する。

// ある型のキーをすべて列挙する。足りなくても多すぎても型エラーになるため、api-types を変えたらここも合わせて変える
const keysOf =
  <T>() =>
  <const K extends readonly (keyof T)[]>(
    ...keys: K & ([keyof T] extends [K[number]] ? unknown : never)
  ) =>
    keys as readonly string[];

type Shape = { keys: readonly string[]; nested?: Record<string, Shape> };

const helpResource: Shape = {
  keys: keysOf<HelpResource>()('id', 'name', 'phone', 'url', 'hours', 'audience'),
};
const notificationSummary: Shape = {
  keys: keysOf<NotificationSummary>()(
    'id',
    'childId',
    'kind',
    'title',
    'createdAt',
    'acknowledgedAt',
  ),
};
const notificationDetail: Shape = {
  keys: keysOf<NotificationDetail>()(
    'id',
    'childId',
    'kind',
    'title',
    'createdAt',
    'acknowledgedAt',
    'changes',
    'meaning',
    'suggestions',
    'childSummary',
    'resources',
    'reason',
    'feedback',
  ),
  nested: {
    suggestions: { keys: keysOf<NotificationDetail['suggestions']>()('try', 'avoid') },
    resources: helpResource,
    reason: { keys: keysOf<NotificationDetail['reason']>()('domains', 'days') },
    feedback: { keys: keysOf<NotificationFeedback>()('action', 'updatedAt') },
  },
};
const weeklyReport: Shape = {
  keys: keysOf<WeeklyReportRes>()('weekId', 'vitality', 'summaryText'),
  nested: {
    vitality: {
      keys: keysOf<WeeklyReportRes['vitality']>()('mood', 'activeDays', 'lateNightDays'),
      nested: {
        mood: {
          keys: keysOf<WeeklyReportRes['vitality']['mood']>()('sunny', 'cloudy', 'rainy', 'stormy'),
        },
      },
    },
  },
};
const contextEvent: Shape = {
  keys: keysOf<ContextEvent>()('eventId', 'childIds', 'category', 'startDate', 'endDate', 'source'),
};
const page = (item: Shape): Shape => ({
  keys: ['items', 'nextPageToken'],
  nested: { items: item },
});
const me: Shape = {
  keys: keysOf<MeRes>()('guardian', 'family', 'children'),
  nested: {
    guardian: { keys: keysOf<MeRes['guardian']>()('guardianId', 'role', 'email', 'displayName') },
    family: { keys: keysOf<MeRes['family']>()('familyId', 'termsVersion', 'consentComplete') },
    children: {
      keys: keysOf<MeRes['children'][number]>()(
        'childId',
        'nickname',
        'gradeBand',
        'paired',
        'assentComplete',
      ),
    },
  },
};
const consents: Shape = {
  keys: keysOf<ConsentsRes>()('items'),
  nested: {
    items: {
      keys: keysOf<ConsentsRes['items'][number]>()(
        'consentId',
        'type',
        'documentVersion',
        'subjectChildId',
        'verificationMethod',
        'grantedAt',
        'revokedAt',
      ),
    },
  },
};
const notifySettings: Shape = { keys: keysOf<NotifySettingsReq>()('channels', 'phoneE164') };

// レスポンスのうち許可リストにないフィールドのパスをすべて返す。形を宣言していない位置にはプリミティブ値しか置けない
function violations(value: unknown, shape: Shape | undefined, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => violations(v, shape, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  if (!shape) return [`${path} is an undeclared object`];
  return Object.entries(value).flatMap(([key, v]) =>
    shape.keys.includes(key)
      ? violations(v, shape.nested?.[key], `${path}.${key}`)
      : [`${path}.${key}`],
  );
}

// データベースに埋めておく機微な内容：この目印がレスポンスに現れたら、内容が漏れている
const SECRET = 'SENSITIVE_FIXTURE_7c1e';
const sensitive = {
  riskLevel: 'l4',
  level: 'l3',
  contentEnc: Buffer.from(SECRET),
  transcript: SECRET,
  evidenceSpan: SECRET,
  interpretation: SECRET,
  storyOutcome: 'negative',
  features: { selfSize: 0.1, note: SECRET },
};

let db: Firestore;
let app: ReturnType<typeof createApp>;
const suffix = randomUUID().replaceAll('-', '');
const familyId = `f_${suffix}`;
const guardianId = `g_${suffix}`;
const childId = `c_${suffix}`;
const headers = { 'X-Dev-Guardian-Id': guardianId };

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-guardian-allowlist-${Date.now()}` });
  const auth = { allowDevHeader: true };
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    guardian: async () => ({ db, auth }),
    accounts: async () => ({
      db,
      auth,
      cipher: new EnvelopeCipher(new LocalKeyWrapper(Buffer.alloc(32, 7))),
      pseudonymizer: new LocalPseudonymizer(),
      now: () => new Date(),
    }),
  });

  const root = db.doc(`families/${familyId}`);
  await root.set({
    familyId,
    status: 'active',
    termsVersion: 'v1',
    consentComplete: true,
    primaryGuardianId: guardianId,
    ...sensitive,
  });
  await root
    .collection('guardians')
    .doc(guardianId)
    .set({
      guardianId,
      role: 'primary',
      email: 'fixture@example.invalid',
      notifyChannels: ['webpush'],
      ...sensitive,
    });
  const child = root.collection('children').doc(childId);
  await child.set({
    childId,
    familyId,
    status: 'active',
    nickname: 'テスト',
    gradeBand: 'high',
    pseudoId: `p_${suffix}`,
    ...sensitive,
  });
  await root
    .collection('consents')
    .doc('k1')
    .set({
      type: 'guardian_terms',
      actorId: guardianId,
      documentVersion: 'v1',
      verificationMethod: 'fixture',
      grantedAt: new Date(),
      ...sensitive,
    });
  const payload = {
    title: 'お知らせ',
    changes: ['変化がありました'],
    meaning: '意味',
    suggestions: { try: ['声をかける'], avoid: ['問い詰める'], ...sensitive },
    childSummary: null,
    resources: [{ id: 'childline', name: 'チャイルドライン', audience: 'child', ...sensitive }],
    reason: { domains: ['a'], days: 7, ...sensitive },
    ...sensitive,
  };
  for (const [id, kind] of [
    ['n_care', 'care_hint'],
    ['n_free', 'content_free_alert'],
    ['n_crisis', 'crisis'],
  ] as const) {
    await root
      .collection('notifications')
      .doc(id)
      .set({
        childId,
        recipientIds: [guardianId],
        kind,
        status: 'sent',
        payload,
        createdAt: new Date(),
        feedback: { action: 'talked', updatedAt: new Date(), ...sensitive },
        ...sensitive,
      });
  }
  await child
    .collection('weeklyReports')
    .doc('2026-W40')
    .set({
      weekStart: '2026-09-28',
      vitality: {
        mood: { sunny: 2, cloudy: 1, rainy: 1, stormy: 0, ...sensitive },
        activeDays: 4,
        lateNightDays: 0,
        ...sensitive,
      },
      summaryText: '元気に過ごせた週でした',
      ...sensitive,
    });
  await root
    .collection('contextEvents')
    .doc('ctx_1')
    .set({
      childIds: [childId],
      category: 'school_event',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      source: 'manual',
      createdBy: guardianId,
      ...sensitive,
    });
});

afterAll(() => db?.terminate());

describe('guardian responses carry only declared fields', () => {
  it.each([
    ['/v1/notifications', page(notificationSummary)],
    ['/v1/notifications/n_care', notificationDetail],
    ['/v1/notifications/n_free', notificationDetail],
    ['/v1/notifications/n_crisis', notificationDetail],
    [`/v1/children/${childId}/weekly-reports`, weeklyReport],
    [
      `/v1/children/${childId}/weekly-reports?weeks=4`,
      { keys: ['items'], nested: { items: weeklyReport } },
    ],
    [`/v1/context-events?childId=${childId}`, page(contextEvent)],
    ['/v1/guardians/me/notify-settings', notifySettings],
    ['/v1/me', me],
    ['/v1/consents', consents],
  ] as const)('%s', async (path, shape) => {
    const res = await app.request(path, { headers });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(violations(JSON.parse(text), shape)).toEqual([]);
    expect(text).not.toContain(SECRET);
  });

  it('the checker itself rejects undeclared and nested fields', () => {
    expect(violations({ id: 'n', riskLevel: 'l4' }, notificationSummary)).toEqual(['$.riskLevel']);
    expect(
      violations({ reason: { domains: [], days: 0, level: 'l3' } }, notificationDetail),
    ).toEqual(['$.reason.level']);
    expect(violations({ items: [{ id: 'n', x: {} }] }, page(notificationSummary))).toEqual([
      '$.items[0].x',
    ]);
    expect(violations({ changes: [{ text: 'x' }] }, notificationDetail)).toEqual([
      '$.changes[0] is an undeclared object',
    ]);
  });
});
