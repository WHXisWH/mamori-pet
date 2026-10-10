import type { NotificationKind } from '@ijime/api-types';

// kb/templates/notifications/*.ja.md の定型テンプレート。モデルを経由しない
export type ParsedTemplate = {
  pushTitle: string;
  pushBody: string;
  resourceIds: string[];
  title: string;
  paragraphs: string[];
  bullets: string[];
  labeled: Record<string, string>;
};

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export const TEMPLATE_FILES: Record<NotificationKind, string> = {
  crisis: 'templates/notifications/crisis.ja.md',
  content_free_alert: 'templates/notifications/content_free_alert.ja.md',
  care_hint: 'templates/notifications/care_hint.ja.md',
  weekly_report: 'templates/notifications/weekly_report.ja.md',
};

const DEFAULT_PUSH = { title: 'お知らせ', body: '新しいお知らせがあります。' };
const LABEL = /^([^\s：]{1,12})：(.*)$/;

export function parseTemplate(source: string): ParsedTemplate {
  const out: ParsedTemplate = {
    pushTitle: DEFAULT_PUSH.title,
    pushBody: DEFAULT_PUSH.body,
    resourceIds: [],
    title: '',
    paragraphs: [],
    bullets: [],
    labeled: {},
  };
  const body = source.replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === 'アプリ内：') continue;
    const bold = /^\*\*(.+)\*\*$/.exec(line);
    if (bold) {
      out.title = bold[1]!;
      continue;
    }
    if (line.startsWith('- ')) {
      out.bullets.push(line.slice(2).trim());
      continue;
    }
    const label = LABEL.exec(line);
    if (label) {
      const [, key, value] = label as unknown as [string, string, string];
      if (key === 'プッシュ通知タイトル') out.pushTitle = value.trim();
      else if (key === 'プッシュ通知本文') out.pushBody = value.trim();
      else if (key === '相談先')
        out.resourceIds = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      else out.labeled[key] = value.trim();
      continue;
    }
    out.paragraphs.push(line);
  }
  if (!out.title) throw new TemplateError('template has no title line');
  return out;
}

export function fill(text: string, vars: Record<string, string | number>): string {
  const filled = text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  const left = /\{(\w+)\}/.exec(filled);
  if (left) throw new TemplateError(`unfilled variable ${left[1]}`);
  return filled;
}

export function fillTemplate(
  t: ParsedTemplate,
  vars: Record<string, string | number>,
): ParsedTemplate {
  const labeled: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.labeled)) labeled[k] = fill(v, vars);
  return {
    pushTitle: fill(t.pushTitle, vars),
    pushBody: fill(t.pushBody, vars),
    resourceIds: t.resourceIds,
    title: fill(t.title, vars),
    paragraphs: t.paragraphs.map((p) => fill(p, vars)),
    bullets: t.bullets.map((b) => fill(b, vars)),
    labeled,
  };
}

// メールはテンプレートの定型文と保護者側リンクだけで構成する。メール専用行のないテンプレートはプッシュ通知の文言をそのまま使う
export function emailOf(t: ParsedTemplate, link?: string): { subject: string; body: string } {
  const body = [t.labeled['メール本文'] ?? t.pushBody, link, t.labeled['メール末尾']].filter(
    (line): line is string => !!line,
  );
  return { subject: t.labeled['メール件名'] ?? t.pushTitle, body: body.join('\n\n') };
}
