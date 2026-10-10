// 出典：docs/04-backend-api.md「エンドポイント詳細定義 › 保護者側」

import type { HelpResource, ISODateTime, LocalDate, Page } from './common.js';
import type {
  ContextCategory,
  GradeBand,
  MoodWeather,
  NotificationKind,
  NotifyChannel,
} from './enums.js';

// GET /v1/me
export type MeRes = {
  guardian: {
    guardianId: string;
    role: 'primary' | 'secondary';
    email: string;
    displayName?: string;
  };
  family: { familyId: string; termsVersion: string; consentComplete: boolean };
  children: {
    childId: string;
    nickname: string;
    gradeBand: GradeBand;
    paired: boolean;
    assentComplete: boolean;
  }[];
};

// POST /v1/families  エラー：ALREADY_EXISTS
export type CreateFamilyReq = { displayName?: string };
export type CreateFamilyRes = { familyId: string };

// POST /v1/consents  エラー：INVALID_ARGUMENT
export type ConsentReq = {
  type: 'guardian_terms' | 'guardian_sensitive';
  documentVersion: string;
  subjectChildId?: string;
  scope?: Record<string, boolean>;
  verification?: Record<string, string>;
};
export type ConsentRes = { consentId: string; grantedAt: ISODateTime };

export type ConsentsRes = {
  items: {
    consentId: string;
    type: 'guardian_terms' | 'guardian_sensitive';
    documentVersion: string;
    subjectChildId?: string;
    verificationMethod: string;
    grantedAt: ISODateTime;
    revokedAt?: ISODateTime;
  }[];
};

// POST /v1/children  エラー：CONSENT_REQUIRED、INVALID_ARGUMENT
export type CreateChildReq = { nickname: string; gradeBand: GradeBand };
export type CreateChildRes = { childId: string };

// POST /v1/children/{childId}/pairing-codes
export type PairingCodeRes = { code: string; qrPayload: string; expiresAt: ISODateTime };

// GET /v1/children/{childId}/weekly-reports?week=  エラー：NOT_FOUND
export type WeeklyReportRes = {
  weekId: string;
  vitality: { mood: Record<MoodWeather, number>; activeDays: number; lateNightDays: number };
  summaryText: string;
};

export type WeeklyReportsRes = { items: WeeklyReportRes[] };

// GET /v1/children/{childId}/shared-artworks
export type SharedArtworksRes = Page<{
  artworkId: string;
  type: 'self_portrait' | 'story';
  imageUrl: string;
  sharedAt: ISODateTime;
}>;

// GET /v1/notifications?status=unacknowledged
export type NotificationSummary = {
  id: string;
  childId: string;
  kind: NotificationKind;
  title: string;
  createdAt: ISODateTime;
  acknowledgedAt?: ISODateTime;
};
export type NotificationsRes = Page<NotificationSummary>;

// GET /v1/notifications/{notificationId}  エラー：NOT_FOUND
export type NotificationDetail = NotificationSummary & {
  changes: string[];
  meaning: string;
  suggestions: { try: string[]; avoid: string[] };
  childSummary: string | null;
  resources: HelpResource[];
  reason: { domains: string[]; days: number };
  feedback?: NotificationFeedback;
};

export type NotificationFeedback = {
  action: 'talked' | 'planned' | 'need_help';
  updatedAt: ISODateTime;
};
// PUT /v1/notifications/{notificationId}/feedback; separate from acknowledgement.
export type NotificationFeedbackReq = Pick<NotificationFeedback, 'action'>;
export type NotificationFeedbackRes = { feedback: NotificationFeedback };

// POST /v1/notifications/{notificationId}/ack
export type AckRes = { acknowledgedAt: ISODateTime };

// GET /v1/context-events?childId=  ·  POST /v1/context-events  ·  DELETE /v1/context-events/{eventId}
export type ContextEvent = {
  eventId: string;
  childIds: string[];
  category: ContextCategory;
  startDate: LocalDate;
  endDate: LocalDate;
  source: 'calendar' | 'manual';
};
export type CreateContextEventReq = {
  childIds: string[];
  category: ContextCategory;
  startDate: LocalDate;
  endDate: LocalDate;
};

// POST /v1/calendar/connect
export type CalendarConnectRes = { authUrl: string };

// GET /v1/calendar/calendars
export type CalendarsRes = { items: { calendarId: string; name: string; selected: boolean }[] };

// PUT /v1/calendar/connection
export type CalendarSelectReq = { calendarIds: string[] };

// POST /v1/guardians/invitations  エラー：ALREADY_EXISTS
export type InviteReq = { email: string };
export type InviteRes = { invitationId: string; expiresAt: ISODateTime };

// POST /v1/guardians/invitations/{invitationId}/accept  エラー：NOT_FOUND、INVITATION_EXPIRED
export type AcceptInviteRes = { familyId: string };

// POST /v1/devices
export type DeviceReq = { fcmToken: string; platform: 'ios_pwa' | 'android' | 'desktop' };
export type DeviceRes = { deviceId: string };

// PUT /v1/guardians/me/notify-settings  エラー：INVALID_ARGUMENT
export type NotifySettingsReq = { channels: NotifyChannel[]; phoneE164?: string };

// GET /v1/guides（P1）
export type GuidesRes = {
  items: { guideId: string; title: string; body: string; tags: string[] }[];
};

// GET /v1/children/{childId}/evidence-export（P2）  エラー：CONSENT_REQUIRED
export type EvidenceExportRes = { downloadUrl: string; expiresAt: ISODateTime };
