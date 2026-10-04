// 出典：docs/03-database.md「列挙型の定義」。Firestore・BigQuery・API で共用し、値はすべて英小文字にする。

export const GRADE_BANDS = ['low', 'high', 'jhs'] as const;
export type GradeBand = (typeof GRADE_BANDS)[number];

export const GUARDIAN_ROLES = ['primary', 'secondary'] as const;
export type GuardianRole = (typeof GUARDIAN_ROLES)[number];

export const CHARACTER_IDS = ['moko', 'pokke', 'togemaru', 'nami', 'hoshi', 'hidden'] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

export const CHANNELS = ['text', 'voice'] as const;
export type Channel = (typeof CHANNELS)[number];

export const DOMAINS = ['a', 'v', 'k', 'd', 'm', 'i', 'x'] as const;
export type Domain = (typeof DOMAINS)[number];

export const RISK_LEVELS = ['l0', 'l1', 'l2', 'l3', 'l4'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// drawing が標準の値。self_portrait は互換性のために残し、drawing と同じに扱う
export const ARTWORK_TYPES = ['drawing', 'story', 'island', 'self_portrait'] as const;
export type ArtworkType = (typeof ARTWORK_TYPES)[number];

export const STORY_OUTCOMES = ['positive', 'compensated', 'negative', 'unclear'] as const;
export type StoryOutcome = (typeof STORY_OUTCOMES)[number];

export const MOOD_WEATHERS = ['sunny', 'cloudy', 'rainy', 'stormy'] as const;
export type MoodWeather = (typeof MOOD_WEATHERS)[number];

export const CONTEXT_CATEGORIES = [
  'exam',
  'long_vacation',
  'school_event',
  'sick',
  'travel',
  'class_change',
  'other',
] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

export const CONSULT_CHOICES = ['self', 'proxy', 'not_now'] as const;
export type ConsultChoice = (typeof CONSULT_CHOICES)[number];

export const NOTIFY_CHANNELS = ['webpush', 'email', 'sms'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const NOTIFY_STATUSES = ['queued', 'sent', 'delivered', 'acknowledged', 'failed'] as const;
export type NotifyStatus = (typeof NOTIFY_STATUSES)[number];

export const CRISIS_STATUSES = ['open', 'guardian_acknowledged', 'closed'] as const;
export type CrisisStatus = (typeof CRISIS_STATUSES)[number];

export const DATA_SOURCES = [
  'voice',
  'typing',
  'artwork_save',
  'home_checkin',
  'calendar',
] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

export const CONSENT_TYPES = ['guardian_terms', 'guardian_sensitive', 'child_assent'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const NOTIFICATION_KINDS = [
  'weekly_report',
  'care_hint',
  'content_free_alert',
  'crisis',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const CRISIS_CATEGORIES = [
  'none',
  'suicidal',
  'self_harm',
  'violence',
  'extortion',
] as const;
export type CrisisCategory = (typeof CRISIS_CATEGORIES)[number];

export const EXPRESSIONS = [
  'happy',
  'caring',
  'sleepy',
  'together',
  'celebrate',
  'worried',
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

// ペットのお願い：絵を1枚かざる、おはなしリレー、ペットのなやみ。self_portrait / island は互換性のために残す
export const GAME_TYPES = ['drawing', 'story', 'pet_worry', 'self_portrait', 'island'] as const;
export type GameType = (typeof GAME_TYPES)[number];
export const PET_REQUEST_TYPES = ['drawing', 'story', 'pet_worry'] as const;
export type PetRequestType = (typeof PET_REQUEST_TYPES)[number];
export const PET_REQUEST_STATUSES = ['offered', 'completed', 'declined', 'expired'] as const;
export type PetRequestStatus = (typeof PET_REQUEST_STATUSES)[number];

// シグナルをリスク計算に使うかどうか
export const SIGNAL_SCORINGS = ['score', 'observe'] as const;
export type SignalScoring = (typeof SIGNAL_SCORINGS)[number];

// 毎日の小さな習慣（回数だけを記録する）
export const RITUAL_KINDS = ['watered', 'good_thing'] as const;
export type RitualKind = (typeof RITUAL_KINDS)[number];
export const BODY_STICKERS = ['fine', 'sleepy', 'stomach', 'headache', 'tired'] as const;
export type BodySticker = (typeof BODY_STICKERS)[number];
