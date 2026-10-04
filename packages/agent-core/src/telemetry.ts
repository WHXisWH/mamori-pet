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
