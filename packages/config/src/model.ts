import type { ModelPurpose } from './values.js';

export const MODEL_ENV: Record<ModelPurpose, string> = {
  petChat: 'GEMINI_MODEL_PET_CHAT',
  petVoice: 'GEMINI_MODEL_PET_VOICE',
  crisisScreen: 'GEMINI_MODEL_CRISIS_SCREEN',
  crisisReview: 'GEMINI_MODEL_CRISIS_REVIEW',
  signalExtract: 'GEMINI_MODEL_SIGNAL_EXTRACT',
  artworkFeature: 'GEMINI_MODEL_ARTWORK_FEATURE',
  notificationWriter: 'GEMINI_MODEL_NOTIFICATION_WRITER',
  evalJudge: 'GEMINI_MODEL_EVAL_JUDGE',
};

export function resolveModelId(
  purpose: ModelPurpose,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = MODEL_ENV[purpose];
  const value = env[key]?.trim();
  if (!value || !/^gemini-[a-z0-9.-]+$/.test(value) || /latest/.test(value)) {
    throw new Error(`${key} must name an explicitly verified Gemini model version`);
  }
  return value;
}
