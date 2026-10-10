import { GRADE_BANDS } from '@ijime/api-types';
import { z } from 'zod';

import type { Kb } from './kb.js';

export const QUICK_REPLY_INTENTS = [
  'continue_topic',
  'listen_only',
  'practice_telling',
  'change_topic',
  'unsure',
  'pause',
] as const;

const labelsSchema = z
  .record(z.enum(QUICK_REPLY_INTENTS), z.string().trim().min(1).max(30))
  .refine((labels) => new Set(Object.values(labels)).size === QUICK_REPLY_INTENTS.length, {
    message: 'quick reply labels must be distinct',
  });

export const quickReplyCatalogSchema = z.record(z.enum(GRADE_BANDS), labelsSchema);
export type QuickReplyCatalog = z.infer<typeof quickReplyCatalogSchema>;
export const QUICK_REPLY_CATALOG_PATH = 'templates/quick_replies.ja.yaml';

export function loadQuickReplyCatalog(kb: Kb): Promise<QuickReplyCatalog> {
  return kb.yaml(QUICK_REPLY_CATALOG_PATH, quickReplyCatalogSchema);
}
