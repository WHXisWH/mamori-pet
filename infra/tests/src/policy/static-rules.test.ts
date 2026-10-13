import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 必ず守るルールのうち、静的スキャンで守れるもの（第三者の分析 SDK を入れない、リージョンは東京だけ、文言をコードに直書きしない）
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const rel = (p: string) => relative(root, p);

function walk(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      if (['node_modules', 'dist', '.next', 'coverage', 'test-results'].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else if (accept(name)) out.push(p);
    }
  };
  visit(dir);
  return out;
}

const workspaces = ['apps', 'services', 'packages'].flatMap((top) =>
  readdirSync(join(root, top)).map((name) => join(root, top, name)),
);
const sourcesOf = (dirs: string[]) =>
  dirs.flatMap((d) => {
    try {
      return walk(join(d, 'src'), (n) => /\.(tsx?|mjs|js)$/.test(n) && !/\.test\./.test(n));
    } catch {
      return [];
    }
  });
const allSources = sourcesOf(workspaces);

describe('no third-party analytics, ads or error-reporting SDKs', () => {
  const banned =
    /^(@firebase\/analytics|@sentry\/.+|@segment\/.+|mixpanel.*|@amplitude\/.+|react-ga\d*|@vercel\/analytics|posthog.*|@datadog\/.+|newrelic|logrocket|hotjar.*|@google-analytics\/.+|react-gtm-module|@next\/third-parties)$/;

  it('no workspace depends on one', () => {
    for (const dir of [root, ...workspaces]) {
      const file = join(dir, 'package.json');
      let pkg: Record<string, Record<string, string> | undefined>;
      try {
        pkg = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const names = Object.keys({ ...pkg['dependencies'], ...pkg['devDependencies'] });
      expect(
        names.filter((n) => banned.test(n)),
        rel(file),
      ).toEqual([]);
    }
  });

  it('no source loads Firebase Analytics, gtag or Tag Manager', () => {
    const loads =
      /firebase\/analytics|getAnalytics\(|gtag\(|googletagmanager\.com|google-analytics\.com/;
    expect(allSources.length).toBeGreaterThan(100);
    for (const f of allSources) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(loads);
  });
});

describe('application code names no region other than Tokyo', () => {
  it('every GCP region literal is asia-northeast1', () => {
    const region =
      /['"`](?:us|europe|asia|australia|northamerica|southamerica|me|africa)-[a-z]+\d['"`]/g;
    for (const f of allSources) {
      const found = readFileSync(f, 'utf8').match(region) ?? [];
      expect(
        found.filter((r) => r.slice(1, -1) !== 'asia-northeast1'),
        rel(f),
      ).toEqual([]);
    }
  });
});

// プロンプトや通知テンプレートなどは kb/ から読み込む。バックエンドのコードにある長い日本語の文字列は、たいてい直書きされた定型文かプロンプトである。
// 今ある箇所は既知の例外として登録しておく（kb/ に移すかはまだ決まっていない）。
// 減るのはよいが増えるのは認めない。登録していないファイルに現れるか、登録済みファイルの件数が増えたらテストは失敗する。
describe('no new hardcoded Japanese copy in backend code', () => {
  const KNOWN: Record<string, number> = {
    // ツールの説明（モデル向け）。ツール宣言は agent-core に置くことになっている
    'packages/agent-core/src/tools.ts': 14,
    // API のエラーとフォールバックのメッセージ
    'services/api/src/model-budget.ts': 3,
    'services/api/src/routes/voice.ts': 2,
    'services/api/src/chat.ts': 2,
    'services/api/src/routes/consultations.ts': 2,
    'services/api/src/routes/context-events.ts': 1,
    'services/api/src/routes/calendar.ts': 1,
    'packages/service-kit/src/rate-limit.ts': 2,
    // 通知文を作成するモデルの入力に組み込む説明
    'services/notifier/src/writer.ts': 1,
  };
  const EXEMPT = [
    // フロントエンドのデザインシステムの画面文言。RuleCard は別途、実際のルールと1項目ずつ一致させる
    /^packages\/ui\//,
    // 未定値の登録表に付けた日本語のメモで、子ども向けの文言ではない
    /^packages\/config\/src\/pending\.ts$/,
    // モデルを使わないデモ用のスクリプトで、ローカルとテストでだけ使う
    /^packages\/agent-core\/src\/scripted-llm\.ts$/,
  ];
  const literal = /(['"`])((?:(?!\1)[^\\\n]|\\.){0,4000}?)\1/g;
  const japanese = /[぀-ヿ一-鿿]/g;

  it('long Japanese literals appear only in the registered files, never more of them', () => {
    const backend = allSources.filter((f) => /^(services|packages)\//.test(rel(f)));
    const counts: Record<string, number> = {};
    for (const f of backend) {
      const path = rel(f);
      if (EXEMPT.some((r) => r.test(path))) continue;
      let n = 0;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*')) continue;
        for (const m of line.matchAll(literal)) if ((m[2]!.match(japanese) ?? []).length >= 25) n++;
      }
      if (n > 0) counts[path] = n;
    }
    for (const [path, n] of Object.entries(counts))
      expect(
        n,
        `${path}: ${n} long Japanese literal(s); load copy and prompts from kb/`,
      ).toBeLessThanOrEqual(KNOWN[path] ?? 0);
  });
});
