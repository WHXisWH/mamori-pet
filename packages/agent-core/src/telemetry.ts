import { getLogger, setLogger } from '@google/adk';

export const ADK_CONTENT_CAPTURE_ENV = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';

export function disableAdkContentCapture(env: NodeJS.ProcessEnv = process.env): void {
  env[ADK_CONTENT_CAPTURE_ENV] = 'false';
}

export function isAdkContentCaptureDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ADK_CONTENT_CAPTURE_ENV] === 'false' || env[ADK_CONTENT_CAPTURE_ENV] === '0';
}

export function assertAdkContentCaptureDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isAdkContentCaptureDisabled(env)) {
    throw new Error(
      `${ADK_CONTENT_CAPTURE_ENV} must be "false": ADK would otherwise write prompts and replies into Cloud Trace spans`,
    );
  }
}

// ADK の既定のログには、モデルが返したツール名などが出力される。止めるのは agent-core 自身が import している ADK でなければならない。
// スクリプトから require.resolve で取得するのは CommonJS 版で、ここの ESM 版とは別のインスタンスになる
export function silenceAdkLogger(): void {
  setLogger(null);
}

export function isAdkLoggerSilenced(): boolean {
  return getLogger().constructor.name === 'NoOpLogger';
}
