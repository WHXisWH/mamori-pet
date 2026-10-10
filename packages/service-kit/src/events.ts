import {
  CHANNELS,
  CONSULT_CHOICES,
  CRISIS_HIT_CATEGORIES,
  DOMAINS,
  RISK_LEVELS,
  type PubSubTopic,
} from '@ijime/api-types';
import { z } from 'zod';

const id = z.string().min(1).max(128);

export const eventSchemas = {
  'message.created': z.strictObject({
    familyId: id,
    childId: id,
    sessionId: id,
    messageId: id,
    channel: z.enum(CHANNELS),
  }),
  'artwork.created': z.strictObject({
    childId: id,
    artworkId: id,
    type: z.enum(['self_portrait', 'story', 'island']),
  }),
  'checkin.created': z.strictObject({
    childId: id,
    kind: z.enum(['mood', 'home']),
    checkinId: id,
  }),
  'signal.extracted': z.strictObject({
    childId: id,
    domains: z.array(z.enum(DOMAINS)),
    explicit: z.boolean(),
  }),
  'risk.level_changed': z.strictObject({
    childId: id,
    assessmentId: id,
    from: z.enum(RISK_LEVELS),
    to: z.enum(RISK_LEVELS),
  }),
  'crisis.detected': z.strictObject({
    childId: id,
    crisisId: id,
    // 省略可：ローリングデプロイ中は旧バージョンの発行元が category を付けない。フィールドの欠落より危機イベントの破棄のほうが危険
    category: z.enum(CRISIS_HIT_CATEGORIES).optional(),
    familyHarmSuspected: z.boolean(),
    // 再審査でのヒット：保護者への通知に「検知遅延」を明記する
    delayed: z.boolean().optional(),
  }),
  'consultation.resolved': z.strictObject({
    childId: id,
    consultationId: id,
    choice: z.enum(CONSULT_CHOICES),
  }),
  'data.deletion_requested': z.strictObject({
    familyId: id,
    childId: id.optional(),
    scope: z.enum(['child', 'family']),
  }),
} satisfies Record<PubSubTopic, z.ZodType>;

export type EventPayload<T extends PubSubTopic> = z.infer<(typeof eventSchemas)[T]>;
