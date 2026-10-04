import { ERROR_CODES, type ApiError, type ErrorCode } from '@ijime/api-types';

export class ApiHttpError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = ERROR_CODES[code];
  }

  toBody(requestId: string): ApiError {
    return { error: { code: this.code, message: this.message, requestId } };
  }
}

export function internalErrorBody(requestId: string): ApiError {
  return {
    error: { code: 'MODEL_UNAVAILABLE', message: 'サーバー内部でエラーが発生しました', requestId },
  };
}
