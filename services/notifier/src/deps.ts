import type { BaseLlm } from '@google/adk';
import type { Firestore } from '@google-cloud/firestore';
import type { HelpResource, NotificationKind } from '@ijime/api-types';
import { hotlinesSchema, type Kb } from '@ijime/kb-loader';
import type { Logger, TaskQueue } from '@ijime/service-kit';

import type { ChannelSenders } from './channels.js';
import { parseTemplate, TEMPLATE_FILES, type ParsedTemplate } from './templates.js';
import type { DailyFeatureSource } from './weekly-source.js';

export type NotifierDeps = {
  db: Firestore;
  kb: Kb;
  // 気づかいのお知らせ（care_hint）の通知文作成 Agent だけが使う。危機、内容を含まないお知らせ、週次レポートはモデルを経由しない
  model: string | BaseLlm;
  tasks: TaskQueue;
  senders: ChannelSenders;
  logger: Logger;
  // notifier 自身の URL。Cloud Tasks のコールバックに使う
  selfUrl: string;
  guardianWebOrigin?: string;
  // 週次レポートは BigQuery の daily_features を読む（読み取り専用）
  features: DailyFeatureSource;
  now: () => Date;
};

export async function loadTemplate(kb: Kb, kind: NotificationKind): Promise<ParsedTemplate> {
  return parseTemplate(await kb.text(TEMPLATE_FILES[kind]));
}

export function templateId(kb: Kb, kind: NotificationKind): string {
  return `${TEMPLATE_FILES[kind]}@${kb.version}`;
}

export async function loadResources(kb: Kb, ids: readonly string[]): Promise<HelpResource[]> {
  const { resources } = await kb.yaml('resources/hotlines.yaml', hotlinesSchema);
  return ids.flatMap((id) => {
    const r = resources.find((x) => x.id === id);
    if (!r) return [];
    const out: HelpResource = { id: r.id, name: r.name, audience: r.audience };
    if (r.phone !== undefined) out.phone = r.phone;
    if (r.url !== undefined) out.url = r.url;
    if (r.hours !== undefined) out.hours = r.hours;
    return [out];
  });
}
