export const FORBIDDEN_LOG_KEYS = new Set([
  'text',
  'content',
  'contentEnc',
  'narrative',
  'narrativeText',
  'summary',
  'transcript',
  'message',
  'evidenceSpan',
  'prompt',
  'instruction',
  'reply',
]);

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export class ForbiddenLogFieldError extends Error {
  constructor(readonly key: string) {
    super(`log field "${key}" may contain child input and is not allowed`);
    this.name = 'ForbiddenLogFieldError';
  }
}

export function assertLoggable(fields: LogFields, path = ''): void {
  for (const [k, v] of Object.entries(fields)) {
    const full = path ? `${path}.${k}` : k;
    if (FORBIDDEN_LOG_KEYS.has(k)) throw new ForbiddenLogFieldError(full);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error)) {
      assertLoggable(v as LogFields, full);
    }
  }
}

type Sink = (line: string) => void;

export class Logger {
  constructor(
    private readonly service: string,
    private readonly sink: Sink = (line) => process.stdout.write(line + '\n'),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  debug(event: string, fields: LogFields = {}): void {
    this.write('debug', 'DEBUG', event, fields);
  }
  info(event: string, fields: LogFields = {}): void {
    this.write('info', 'INFO', event, fields);
  }
  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', 'WARNING', event, fields);
  }
  error(event: string, fields: LogFields = {}): void {
    this.write('error', 'ERROR', event, fields);
  }

  private write(level: LogLevel, severity: string, event: string, fields: LogFields): void {
    assertLoggable(fields);
    const entry: Record<string, unknown> = {
      severity,
      level,
      time: this.now(),
      service: this.service,
      event,
      ...serializeErrors(fields),
    };
    this.sink(JSON.stringify(entry));
  }
}

function serializeErrors(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, errorMessage: v.message } : v;
  }
  return out;
}
