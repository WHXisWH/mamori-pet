// 負荷試験スクリプトの共通部品。合成アカウントと合成テキストだけを扱い、実在の子どものデータは一切読み書きしない。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REGION = 'asia-northeast1';
export const SYNTHETIC_PREFIX = 'load';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`invalid_arguments: unexpected ${arg}`);
    const eq = arg.indexOf('=');
    if (eq > 0) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) options[arg.slice(2)] = true;
    else {
      options[arg.slice(2)] = next;
      i++;
    }
  }
  return { command, options };
}

export function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`invalid_arguments: --${name} is required`);
  return value;
}

export function intOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`invalid_arguments: --${name} must be a positive integer`);
  return value;
}

// 実行ラベルに使えるのは小文字、数字、ハイフンだけ。ドキュメント ID とメールアドレスに組み込まれる
export function runLabel(options) {
  const run = options.run ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  if (!/^[a-z0-9-]{1,24}$/.test(run))
    throw new Error('invalid_arguments: --run must match [a-z0-9-]{1,24}');
  return run;
}

export function artifactDir(run) {
  const dir = join(ROOT, 'artifacts', `load-${run}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function tokyoDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ローカルの ADC（gcloud auth application-default login）で Google API を呼ぶ。新しい依存は増やさず、service-kit の google-auth-library を借りる
export async function googleClient(project) {
  const require = createRequire(join(ROOT, 'packages/service-kit/package.json'));
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  return async (url, { method = 'GET', body } = {}) => {
    const { token } = await client.getAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-goog-user-project': project,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `google_api_${res.status}: ${new URL(url).pathname} ${errorMessage(text)}`.trim(),
      );
    return text ? JSON.parse(text) : {};
  };
}

// 日次ジョブが合成の子どもについて BigQuery に書いた行を pseudo_id で削除する
const FEATURE_TABLES = ['daily_features', 'baselines', 'risk_levels_daily', 'anomalies'];
export async function deleteFeatureRows(google, project, pseudoIds, dataset = 'features_deid') {
  if (pseudoIds.length === 0) return [];
  const results = [];
  for (const table of FEATURE_TABLES) {
    try {
      const res = await google(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,
        {
          method: 'POST',
          body: {
            query: `DELETE FROM \`${project}.${dataset}.${table}\` WHERE pseudo_id IN UNNEST(@ids)`,
            useLegacySql: false,
            location: REGION,
            timeoutMs: 60_000,
            queryParameters: [
              {
                name: 'ids',
                parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
                parameterValue: { arrayValues: pseudoIds.map((value) => ({ value })) },
              },
            ],
          },
        },
      );
      results.push({ table, deleted: Number(res.numDmlAffectedRows ?? 0) });
    } catch (error) {
      results.push({ table, error: error.message });
    }
  }
  return results;
}

// Google API とこのプロジェクトの API のエラーボディはどちらもエラーコードと固定文言だけで、子どもの内容は含まない
export function errorMessage(text) {
  try {
    const body = JSON.parse(text);
    return body?.error?.message ?? body?.error?.code ?? body?.code ?? '';
  } catch {
    return '';
  }
}

export function firestore(projectId) {
  const require = createRequire(join(ROOT, 'services/risk-engine/package.json'));
  const { Firestore } = require('@google-cloud/firestore');
  return new Firestore({ projectId });
}
