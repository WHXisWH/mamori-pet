// 出典：docs/04-backend-api.md「エンドポイント詳細定義 › 子ども側」

import type {
  CrisisPayload,
  HelpResource,
  ISODateTime,
  LocalDate,
  Page,
  PetAction,
  TypingMetrics,
} from './common.js';
import type {
  BodySticker,
  CharacterId,
  ConsultChoice,
  DataSource,
  Expression,
  GameType,
  GradeBand,
  MoodWeather,
  PetRequestType,
  RitualKind,
} from './enums.js';

// POST /v1/child/pair（ログイン不要）  エラー：PAIRING_CODE_EXPIRED、INVALID_ARGUMENT
export type PairReq = { code: string };
export type PairRes = { customToken: string; childId: string; needsAssent: boolean };

// POST /v1/child/assent
export type AssentReq = { documentVersion: string; dataSources: Record<DataSource, boolean> };
export type AssentRes = { consentId: string };

// GET /v1/child/help-resources（ログイン不要）
export type HelpResourcesRes = { version: string; resources: HelpResource[] };

// GET /v1/child/home  エラー：ASSENT_REQUIRED
export type ChildHomeRes = {
  gradeBand: GradeBand;
  pet: { petId: string; characterId: CharacterId; hiddenVariantId?: string; petName?: string };
  greeting: { text: string; expression: Expression; source?: 'agent' | 'template' };
  todayMood?: MoodWeather;
  showHomeCheckin: boolean;
  // 互換性のために残す。島のホームでは petRequests を使う
  games: GameType[];
  island?: IslandSummary;
  rituals?: DailyRituals;
  petRequests?: PetRequest[];
  pendingConsultation?: { consultationId: string };
};

// ペットの島
export type IslandSummary = {
  visitDays: number;
  stage: number;
  season: string;
  decorationCount: number;
};
export type DailyRituals = {
  morningMood: boolean;
  bodySticker?: BodySticker;
  okaeri: boolean;
  goodThing: boolean;
  watered: boolean;
};
export type PetRequest = {
  requestId: string;
  type: PetRequestType;
  promptId: string;
  promptText: string;
  options?: { id: string; text: string }[];
  rewardItemId: string;
  offeredAt: ISODateTime;
  expiresAt: ISODateTime;
};

// GET /v1/child/island
export type IslandCatalogItem = {
  catalogId: string;
  category: string;
  label: string;
  spriteUrl: string;
  locked: boolean;
};
export type IslandStateRes = {
  items: IslandItem[];
  selfFigureId?: string;
  decorations: { artworkId: string; thumbnailUrl: string }[];
  unlockedItems: string[];
  catalog: IslandCatalogItem[];
  visitDays: number;
  stage: number;
  season: string;
  goodThingCount: number;
};

// PUT /v1/child/island  エラー：INVALID_ARGUMENT（selfFigureId が items にない）
export type IslandPutReq = {
  items: IslandItem[];
  selfFigureId?: string;
  narrative?: { mode: 'typed' | 'voice_transcript'; text: string };
};
export type IslandPutRes = { sceneId: string; replyMessageId?: string; crisis?: CrisisPayload };

// GET /v1/child/pet-requests
export type PetRequestsRes = { items: PetRequest[] };

// POST /v1/child/pet-requests/{requestId}/complete  エラー：INVALID_ARGUMENT、NOT_FOUND
export type PetRequestCompleteReq =
  | { type: 'drawing'; artworkId: string }
  | {
      type: 'story';
      artworkId?: string;
      ending?: { mode: 'typed' | 'voice_transcript' | 'option'; text: string };
    }
  | { type: 'pet_worry'; optionId: string };
export type PetRequestCompleteRes = {
  rewardItemId: string;
  replyMessageId?: string;
  petReply: string;
  crisis?: CrisisPayload;
};

// POST /v1/child/pet-requests/{requestId}/decline
export type PetRequestDeclineRes = { ok: true };

// POST /v1/child/rituals
export type RitualReq = { kind: RitualKind; localDate: LocalDate };
export type RitualRes = { rituals: DailyRituals; goodThingCount: number };

// GET /v1/characters
export type CharactersRes = {
  items: {
    characterId: CharacterId;
    displayName: string;
    archetype: string;
    palette: { main: string; sub: string };
    voicePreviewUrl: string;
  }[];
};

// POST /v1/child/pets  エラー：INVALID_ARGUMENT
export type ChoosePetReq = { characterId: CharacterId; petName?: string; carryMemoryFrom?: string };
export type ChoosePetRes = { petId: string; characterId: CharacterId; hiddenVariantId?: string };

// GET、PUT /v1/child/preferences
export type ChildPreferencesBody = {
  gradeBand: GradeBand;
  nickname?: string;
  ttsEnabled?: boolean;
};

// POST /v1/child/chat/sessions
export type StartSessionRes = { sessionId: string; openingMessage: string };

// GET /v1/child/chat/sessions
export type SessionsRes = Page<{
  sessionId: string;
  channel: 'text' | 'voice';
  startedAt: ISODateTime;
  preview: string;
}>;

// POST /v1/child/chat/sessions/{sessionId}/messages → text/event-stream
export type SendMessageReq = {
  text: string;
  inputMode: 'typed' | 'quick_reply';
  typing?: TypingMetrics;
  clientSentAt: ISODateTime;
};
export type SseEvent =
  | { event: 'meta'; data: { messageId: string; safeMode: boolean } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'action'; data: PetAction }
  | { event: 'crisis'; data: { crisisId: string; message: string; resources: HelpResource[] } }
  | { event: 'done'; data: { replyMessageId: string } };

// GET /v1/child/chat/sessions/{sessionId}/messages
export type MessagesRes = Page<{
  messageId: string;
  role: 'child' | 'pet';
  text: string;
  createdAt: ISODateTime;
}>;

// POST /v1/child/voice/tickets  エラー：DATA_SOURCE_DISABLED
export type VoiceTicketRes = { ticket: string; wsUrl: string; expiresAt: ISODateTime };

// POST /v1/child/mood
export type MoodReq = { weather: MoodWeather };
export type MoodRes = { checkinId: string; petReply: string };

// POST /v1/child/home-checkins  エラー：DATA_SOURCE_DISABLED
export type HomeCheckinReq = { atHome: boolean; method: 'geo' | 'manual' };
export type HomeCheckinRes = { checkinId: string; greeting: string };

// GET /v1/child/games/story-prompt
export type StoryPromptRes = { promptId: string; text: string; imageUrl?: string };

// POST /v1/child/artworks（multipart/form-data）  エラー：INVALID_ARGUMENT
export type ArtworkFormFields = {
  type: 'drawing' | 'story' | 'self_portrait';
  promptId?: string;
  requestId?: string;
  narrativeText?: string;
  narrativeMode: 'typed' | 'voice_transcript';
  save: 'true' | 'false';
};
// お話が危機検知に一致したときは crisis を付ける。クライアントはセーフモードに入る
export type ArtworkRes = { artworkId: string; petPrompt: string; crisis?: CrisisPayload };

// POST /v1/child/island-scenes（互換性のために残す。PUT /v1/child/island に統合済み）  エラー：INVALID_ARGUMENT
export type IslandItem = {
  id: string;
  catalogId: string;
  category: string;
  x: number;
  y: number;
  rotation: number;
  layer: number;
};
export type IslandReq = {
  selfFigureId?: string;
  items: IslandItem[];
  narrative?: { mode: 'typed' | 'voice_transcript'; text: string };
};
export type IslandRes = { sceneId: string; petPrompt: string; crisis?: CrisisPayload };

// GET /v1/child/memories
export type MemoriesRes = Page<{
  memoryId: string;
  text: string;
  category: string;
  createdAt: ISODateTime;
}>;

// GET、PUT /v1/child/data-sources
export type DataSourcesBody = { dataSources: Record<DataSource, boolean> };

// POST /v1/child/tell-adult
export type TellAdultRes =
  { consultationId: string; crisis?: never } | { crisis: CrisisPayload; consultationId?: never };

// POST /v1/child/consultations/{consultationId}/choice  エラー：NOT_FOUND、INVALID_ARGUMENT
export type ChoiceReq = { choice: ConsultChoice; summary?: { text: string; confirmed: boolean } };
export type ChoiceRes = {
  notificationQueued: boolean;
  coachingScript?: string[];
  crisis?: CrisisPayload;
};

// GET /v1/child/consultations/{consultationId}; no risk level is exposed.
export type ConsultationRes = {
  consultationId: string;
  status: 'pending' | 'answered';
  choices: ConsultChoice[];
  choice?: ConsultChoice;
  offeredAt: ISODateTime;
  followUpAt?: ISODateTime;
  notificationQueued: boolean;
  coachingScript?: string[];
  crisis?: CrisisPayload;
};

// GET /v1/child/memory-proposals
export type MemoryProposalsRes = Page<{
  proposalId: string;
  text: string;
  category: string;
  expiresAt: ISODateTime;
}>;

// POST /v1/child/memory-proposals/{id}/decision
export type MemoryProposalDecisionReq = { decision: 'accept' | 'reject' };
export type MemoryProposalDecisionRes = { status: 'saved' | 'rejected'; memoryId?: string };

// GET /v1/child/followups; POST /v1/child/followups/{id}/answer
export type FollowupsRes = {
  items: {
    followupId: string;
    kind: 'consultation' | 'crisis';
    dueAt: ISODateTime;
    consultationId?: string;
    crisisId?: string;
  }[];
};
export type FollowupAnswerReq = { answer: 'talked' | 'need_help' | 'not_now' };
export type FollowupAnswerRes = { status: 'answered'; consultationId?: string };

// POST /v1/child/data-deletion-requests
export type DeletionRes = { requestId: string; status: 'accepted' };
