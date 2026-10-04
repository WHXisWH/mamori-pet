// 出典：docs/04-backend-api.md「エンドポイント詳細定義 › 内部エンドポイント」「リアルタイム音声プロトコル」「内部イベントと Agent ツール」

import type { HelpResource, PetAction } from './common.js';
import type {
  Channel,
  ConsultChoice,
  CrisisCategory,
  Expression,
  PetRequestType,
  RiskLevel,
} from './enums.js';

// POST /internal/turns（api → pet-agent）
export type TurnReq = { childId: string; sessionId: string; messageId: string };
export type TurnChunk =
  | { type: 'delta'; text: string }
  | { type: 'action'; action: PetAction }
  | { type: 'done'; replyMessageId: string }
  // ペットが escalate_crisis を呼んだ場合。このターンはここで終了し、api が crisis.detected を発行して子どもに定型文を返す
  | { type: 'crisis'; crisisId: string };

// POST /internal/tools/{toolName}（voice-relay → pet-agent）
export type ToolCallReq = {
  childId: string;
  sessionId: string;
  operationId?: string;
  args: Record<string, unknown>;
};
export type ToolCallRes = { result: unknown };

// POST /internal/assess（Pub/Sub プッシュ signal.extracted → risk-engine）
export type AssessReq = { childId: string; domains: string[]; explicit: boolean };

// リアルタイム音声プロトコル：テキストフレーム
export type VoiceClientMessage =
  { type: 'start'; sessionId?: string; sampleRateHz: 16000 } | { type: 'stop' };

export type VoiceServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'child_transcript'; text: string; final: boolean }
  | { type: 'pet_transcript'; text: string }
  | { type: 'interrupted' }
  | { type: 'action'; action: PetAction }
  | { type: 'crisis'; message: string; resources: HelpResource[] }
  | { type: 'end'; reason: 'stop' | 'timeout' | 'crisis' | 'error' };

// Pub/Sub イベントのペイロード：ID だけを渡し、内容は渡さない
export type MessageCreatedEvent = {
  familyId: string;
  childId: string;
  sessionId: string;
  messageId: string;
  channel: Channel;
};
export type ArtworkCreatedEvent = {
  childId: string;
  artworkId: string;
  type: 'drawing' | 'story' | 'island' | 'self_portrait';
};

// 自発ターン
// POST /internal/proactive-turns/dispatch（Cloud Scheduler → api）
export type ProactiveSlot = 'morning' | 'after_school' | 'bedtime';
export type ProactiveDispatchReq = { slot: ProactiveSlot };
// POST /internal/proactive-turns（Cloud Tasks → pet-agent）
export type ProactiveTurnReq = { childId: string; slot: ProactiveSlot; localDate: string };
export type ProactiveTurnRes = {
  greeting: { text: string; expression: Expression };
  petRequest?: { requestId: string; type: PetRequestType };
  fallback: boolean;
};
export type CheckinCreatedEvent = { childId: string; kind: 'mood' | 'home'; checkinId: string };
export type SignalExtractedEvent = { childId: string; domains: string[]; explicit: boolean };
export type RiskLevelChangedEvent = {
  childId: string;
  assessmentId: string;
  from: RiskLevel;
  to: RiskLevel;
};
export type CrisisDetectedEvent = {
  childId: string;
  crisisId: string;
  familyHarmSuspected: boolean;
};
export type ConsultationResolvedEvent = {
  childId: string;
  consultationId: string;
  choice: ConsultChoice;
};
export type DataDeletionRequestedEvent = {
  familyId: string;
  childId?: string;
  scope: 'child' | 'family';
};

export const PUBSUB_TOPICS = [
  'message.created',
  'artwork.created',
  'checkin.created',
  'signal.extracted',
  'risk.level_changed',
  'crisis.detected',
  'consultation.resolved',
  'data.deletion_requested',
] as const;
export type PubSubTopic = (typeof PUBSUB_TOPICS)[number];

// escalate_crisis ツールの reason 引数
export type CrisisReason = Exclude<CrisisCategory, 'none'>;
