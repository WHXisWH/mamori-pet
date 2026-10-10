// 出典：docs/04-backend-api.md「エンドポイント詳細定義 › 共通型」

import type { Expression, GameType } from './enums.js';

export type ISODateTime = string;
export type LocalDate = string;

export type Page<T> = { items: T[]; nextPageToken?: string };

export type HelpResource = {
  id: string;
  name: string;
  phone?: string;
  url?: string;
  hours?: string;
  audience: string;
};

export type PetAction =
  | {
      type: 'memory_proposal';
      proposalId: string;
      text: string;
      category: 'like' | 'event' | 'person' | 'other';
    }
  | {
      type: 'offer_tell_adult';
      consultationId: string;
      openingLine?: string;
      source?: 'restored_followup';
    }
  | { type: 'show_help_resources' }
  | { type: 'suggest_game'; game: GameType; requestId?: string }
  | { type: 'quick_replies'; options: string[] }
  | { type: 'set_expression'; expression: Expression };

export type TypingMetrics = {
  keyCount: number;
  deleteCount: number;
  composeMs: number;
  longPauseCount: number;
};

export type CrisisPayload = { crisisId: string; message: string; resources: HelpResource[] };
