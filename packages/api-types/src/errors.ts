// 出典：docs/04-backend-api.md「危機対応経路とエラーコード」

export const ERROR_CODES = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  CONSENT_REQUIRED: 403,
  ASSENT_REQUIRED: 403,
  DATA_SOURCE_DISABLED: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PAIRING_CODE_EXPIRED: 410,
  INVITATION_EXPIRED: 410,
  RATE_LIMITED: 429,
  MODEL_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export type ApiError = {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
};
