import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FsKbSource, Kb } from '@ijime/kb-loader';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildCrisisPayload } from './crisis.js';
import { loadTemplate } from './deps.js';
import {
  channelsOf,
  firstCrisisRecipients,
  planDeliveries,
  type GuardianContact,
} from './recipients.js';
import { emailOf, fill, fillTemplate, parseTemplate, TemplateError } from './templates.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
let kb: Kb;
beforeAll(async () => {
  kb = await Kb.load(new FsKbSource(KB_DIR));
});

describe('templates', () => {
  it('renders the crisis template word for word', async () => {
    const p = await buildCrisisPayload({ kb }, 'はな');
    expect(p).toEqual({
      title: '今すぐはなさんのそばにいてください',
      changes: [],
      meaning: 'このサービスは緊急通報サービスではなく、人による見守りは行っていません。',
      suggestions: {
        try: [
          'すぐにお子さんのそばに行き、ひとりにしないでください。',
          '命や体に危険があるときは、119 または 110 に電話してください。',
          '落ち着いて話を聞いてください。問い詰めないでください。',
        ],
        avoid: [],
      },
      childSummary: null,
      resources: [
        expect.objectContaining({ id: 'emergency', phone: '110 / 119' }),
        expect.objectContaining({ id: 'sos_dial' }),
      ],
      reason: { domains: [], days: 0 },
    });
  });

  it('prepends the fixed delay line only for a crisis found on recheck', async () => {
    const p = await buildCrisisPayload({ kb }, 'はな', { delayed: true });
    expect(p.meaning).toBe(
      [
        'システムの一時的な不具合のため、このお知らせは少し遅れて届いています。',
        'このサービスは緊急通報サービスではなく、人による見守りは行っていません。',
      ].join('\n'),
    );
  });

  it('keeps push copy fixed and free of the nickname', async () => {
    const t = fillTemplate(await loadTemplate(kb, 'crisis'), { nickname: 'はな' });
    expect(t.pushTitle).toBe('緊急：お子さんの安全に関するお知らせ');
    expect(t.pushBody).toBe('新しいお知らせがあります。アプリで確認してください。');
    expect(t.pushTitle + t.pushBody).not.toContain('はな');
  });

  it('parses labeled lines of the care hint fallback', async () => {
    const t = fillTemplate(await loadTemplate(kb, 'care_hint'), { nickname: 'はな', days: 7 });
    expect(t.title).toBe('はなさんからの相談');
    expect(t.labeled['声かけの例']).toBe(
      '「話したいときに聞くよ」と声をかける、落ち着いて話せる時間を一緒に決める',
    );
    expect(t.labeled['避けたいこと']).toBe('問い詰める、すぐに学校へ電話する');
    expect(t.paragraphs[0]).toBe('記録上、この7日ほど、いつもと違う傾向が見られました。');
  });

  it('refuses unfilled variables and templates without a title', () => {
    expect(() => fill('{nickname}さん', {})).toThrow(TemplateError);
    expect(() => parseTemplate('no title here')).toThrow(TemplateError);
  });
});

describe('planDeliveries', () => {
  const g1: GuardianContact = {
    guardianId: 'g1',
    email: 'a@example.com',
    phoneE164: '+819012345678',
    notifyChannels: ['webpush', 'email'],
    fcmTokens: ['t1'],
  };
  const g2: GuardianContact = {
    guardianId: 'g2',
    email: 'b@example.com',
    notifyChannels: ['email'],
    fcmTokens: [],
  };

  it('crisis goes to every guardian on every reachable channel', () => {
    const d = planDeliveries('crisis', [g1, g2]);
    expect(d).toEqual([
      { guardianId: 'g1', channels: ['webpush', 'email', 'sms'] },
      { guardianId: 'g2', channels: ['email'] },
    ]);
    expect(channelsOf(d)).toEqual(['webpush', 'email', 'sms']);
  });

  it('nobody is notified when family harm is suspected', () => {
    expect(planDeliveries('crisis', [g1, g2], { familyHarmSuspected: true })).toEqual([]);
  });

  it('non-crisis follows personal settings and never uses sms', () => {
    const g = { ...g1, notifyChannels: ['webpush', 'sms'] as GuardianContact['notifyChannels'] };
    expect(planDeliveries('content_free_alert', [g, g2])).toEqual([
      { guardianId: 'g1', channels: ['webpush'] },
      { guardianId: 'g2', channels: ['email'] },
    ]);
  });

  it('keeps a guardian with no reachable channel so the gap is visible', () => {
    const none: GuardianContact = { guardianId: 'g3', notifyChannels: [], fcmTokens: [] };
    expect(planDeliveries('crisis', [none])).toEqual([{ guardianId: 'g3', channels: [] }]);
  });
});

describe('emailOf', () => {
  it('uses the crisis email lines and the link, with no child content', async () => {
    const t = fillTemplate(await loadTemplate(kb, 'crisis'), { nickname: 'はな' });
    const email = emailOf(t, 'https://g.example/notifications/n1');
    expect(email.subject).toBe('【緊急】お子さんの安全に関するお知らせ');
    expect(email.body.split('\n\n')).toEqual([
      t.labeled['メール本文'],
      'https://g.example/notifications/n1',
      t.labeled['メール末尾'],
    ]);
    expect(JSON.stringify(email)).not.toContain('はな');
  });

  it('falls back to the push text for templates without email lines', () => {
    const t = parseTemplate('プッシュ通知タイトル：T\nプッシュ通知本文：B\n**title**');
    expect(emailOf(t)).toEqual({ subject: 'T', body: 'B' });
  });
});

describe('firstCrisisRecipients', () => {
  const g = (guardianId: string, role?: 'primary' | 'secondary'): GuardianContact => ({
    guardianId,
    ...(role ? { role } : {}),
    notifyChannels: [],
    fcmTokens: [],
  });

  it('keeps only the primary guardian', () => {
    expect(firstCrisisRecipients([g('a', 'secondary'), g('b', 'primary')])).toEqual([
      g('b', 'primary'),
    ]);
  });

  it('notifies everyone when no guardian is marked primary', () => {
    expect(firstCrisisRecipients([g('a', 'secondary'), g('b')])).toHaveLength(2);
    expect(firstCrisisRecipients([])).toEqual([]);
  });
});
