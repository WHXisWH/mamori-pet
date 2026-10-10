#!/usr/bin/env node
// 負荷試験用の合成アカウント。
//
//   local    ローカルプレビュー：c_load_* のフィクスチャ ID を生成する。api は production 以外では X-Dev-Child-Id に応じて子どもを自動作成するため、API は呼ばない
//   create   クラウド環境：Identity Platform にメール確認済みの保護者を作成 → 家庭と 2 つの同意 → 子どもの作成 → ペアリング → 子どものトークン → インフォームドコンセント、ペットの選択
//   refresh  refreshToken で新しい ID トークンに交換する（ID トークンは 1 時間で期限切れ）
//   cleanup  accounts.json にある家庭（Firestore のサブツリー全体）、BigQuery の特徴量の行、Identity Platform のアカウントを削除する
//
// クラウド環境向けのコマンドにはローカルの ADC（gcloud auth application-default login）が必要。そのアカウントは Identity Platform のユーザー管理、Firestore の読み書き、BigQuery の実行ができること。
// accounts.json には合成アカウントのトークンが含まれる。artifacts/load-<run>/（gitignore 済み）に権限 600 で書く。
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SYNTHETIC_PREFIX,
  artifactDir,
  deleteFeatureRows,
  errorMessage,
  firestore,
  googleClient,
  intOption,
  parseArgs,
  readJson,
  requireOption,
  runLabel,
  writeJson,
} from './lib.mjs';

const GRADE_BANDS = ['low', 'high', 'jhs'];
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token';
const DOCUMENT_VERSION = 'v0.1';

export function localAccounts({ run, count, api, childOrigin }) {
  return {
    run,
    target: 'local',
    apiBase: api,
    childOrigin,
    createdAt: new Date().toISOString(),
    children: Array.from({ length: count }, (_, i) => ({
      childId: `c_${SYNTHETIC_PREFIX}_${run.replaceAll('-', '_')}_${i}`,
      devHeader: true,
    })),
  };
}

export async function apiCall(
  base,
  path,
  { method = 'GET', token, body, expect = [200, 201] } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!expect.includes(res.status)) {
    const error = new Error(`api_${res.status}: ${method} ${path} ${errorMessage(text)}`.trim());
    error.status = res.status;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

async function identityPost(path, key, body) {
  const res = await fetch(`${IDENTITY}/${path}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`identity_${res.status}: ${path} ${errorMessage(text)}`.trim());
  return JSON.parse(text);
}

export async function refreshIdToken(key, refreshToken) {
  const res = await fetch(`${SECURE_TOKEN}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`securetoken_${res.status}: ${errorMessage(text)}`.trim());
  const body = JSON.parse(text);
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + Number(body.expires_in) * 1000).toISOString(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ペアリングのエンドポイントには全体で 1 分あたりの上限がある（pairing-limiter）。超えたら次の分まで待つ
async function pair(api, code) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await apiCall(api, '/v1/child/pair', { method: 'POST', body: { code } });
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await sleep(61_000 - (Date.now() % 60_000));
    }
  }
  throw new Error('unreachable');
}

async function createOne({ google, project, api, key, run, index }) {
  const email = `${SYNTHETIC_PREFIX}-${run}-${index}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const created = await google(`${IDENTITY}/projects/${project}/accounts`, {
    method: 'POST',
    body: { email, password, emailVerified: true, displayName: `負荷テスト${index}` },
  });
  // ログイン直後で auth_time は現在：2 つの同意は consent.reauthMaxAgeSeconds 以内に済ませる
  const signIn = await identityPost('accounts:signInWithPassword', key, {
    email,
    password,
    returnSecureToken: true,
  });
  const { familyId } = await apiCall(api, '/v1/families', {
    method: 'POST',
    token: signIn.idToken,
    body: { displayName: '負荷テスト用の合成家庭' },
  });
  // 家庭を作るとサーバー側が role クレームを書き込むため、トークンを一度更新する
  const guardian = await refreshIdToken(key, signIn.refreshToken);
  for (const type of ['guardian_terms', 'guardian_sensitive'])
    await apiCall(api, '/v1/consents', {
      method: 'POST',
      token: guardian.idToken,
      body: {
        type,
        documentVersion: DOCUMENT_VERSION,
        scope: { service: true },
        verification: { guardianAttestation: 'legal_guardian_adult' },
      },
    });
  const gradeBand = GRADE_BANDS[index % GRADE_BANDS.length];
  const { childId } = await apiCall(api, '/v1/children', {
    method: 'POST',
    token: guardian.idToken,
    body: { nickname: `ロード${index}`, gradeBand },
  });
  const { code } = await apiCall(api, `/v1/children/${childId}/pairing-codes`, {
    method: 'POST',
    token: guardian.idToken,
    body: {},
  });
  const paired = await pair(api, code);
  const child = await identityPost('accounts:signInWithCustomToken', key, {
    token: paired.customToken,
    returnSecureToken: true,
  });
  await apiCall(api, '/v1/child/assent', {
    method: 'POST',
    token: child.idToken,
    body: {
      documentVersion: DOCUMENT_VERSION,
      dataSources: {
        voice: true,
        typing: true,
        artwork_save: false,
        home_checkin: false,
        calendar: false,
      },
    },
  });
  await apiCall(api, '/v1/child/pets', {
    method: 'POST',
    token: child.idToken,
    body: { characterId: 'moko', petName: '' },
  });
  return {
    childId,
    familyId,
    gradeBand,
    guardianUid: created.localId,
    idToken: child.idToken,
    refreshToken: child.refreshToken,
    expiresAt: new Date(Date.now() + Number(child.expiresIn) * 1000).toISOString(),
  };
}

async function create(options) {
  const run = runLabel(options);
  const project = requireOption(options, 'project');
  const api = requireOption(options, 'api').replace(/\/$/, '');
  const key = requireOption(options, 'web-api-key');
  const childOrigin = requireOption(options, 'child-origin');
  const count = intOption(options, 'count', 50);
  const google = await googleClient(project);
  const file = join(artifactDir(run), 'accounts.json');
  const accounts = {
    run,
    target: 'cloud',
    project,
    apiBase: api,
    childOrigin,
    createdAt: new Date().toISOString(),
    children: [],
    failures: [],
  };
  for (let index = 0; index < count; index++) {
    try {
      accounts.children.push(await createOne({ google, project, api, key, run, index }));
    } catch (error) {
      accounts.failures.push({ index, error: error.message });
    }
    // 1 件作るごとにディスクへ書き、途中で失敗しても cleanup できるようにする
    writeJson(file, accounts);
    process.stdout.write(`\r${accounts.children.length}/${count} created`);
  }
  process.stdout.write('\n');
  console.log(
    JSON.stringify({ file, created: accounts.children.length, failures: accounts.failures.length }),
  );
  if (accounts.failures.length > 0) process.exitCode = 1;
}

async function refresh(options) {
  const file = requireOption(options, 'file');
  const key = requireOption(options, 'web-api-key');
  const accounts = readJson(file);
  for (const child of accounts.children) {
    if (child.devHeader) continue;
    Object.assign(child, await refreshIdToken(key, child.refreshToken));
  }
  writeJson(file, accounts);
  console.log(JSON.stringify({ file, refreshed: accounts.children.length }));
}

async function cleanup(options) {
  const file = requireOption(options, 'file');
  const accounts = readJson(file);
  if (accounts.target !== 'cloud') {
    console.log(JSON.stringify({ file, skipped: 'local accounts live only in the emulator' }));
    return;
  }
  const project = options.project ?? accounts.project;
  const google = await googleClient(project);
  const db = firestore(project);
  const pseudoIds = [];
  for (const child of accounts.children) {
    const doc = await db.doc(`families/${child.familyId}/children/${child.childId}`).get();
    if (doc.exists && typeof doc.get('pseudoId') === 'string') pseudoIds.push(doc.get('pseudoId'));
  }
  const familyIds = [...new Set(accounts.children.map((c) => c.familyId))];
  for (const familyId of familyIds) await db.recursiveDelete(db.doc(`families/${familyId}`));
  const bigquery = await deleteFeatureRows(google, project, pseudoIds);
  const localIds = accounts.children.flatMap((c) => [c.guardianUid, c.childId]).filter(Boolean);
  for (let i = 0; i < localIds.length; i += 1000)
    await google(`${IDENTITY}/projects/${project}/accounts:batchDelete`, {
      method: 'POST',
      body: { localIds: localIds.slice(i, i + 1000), force: true },
    });
  console.log(
    JSON.stringify({ file, families: familyIds.length, users: localIds.length, bigquery }),
  );
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'local') {
    const run = runLabel(options);
    const accounts = localAccounts({
      run,
      count: intOption(options, 'count', 50),
      api: (options.api ?? 'http://127.0.0.1:8080').replace(/\/$/, ''),
      childOrigin: options['child-origin'] ?? 'http://localhost:3100',
    });
    const file = join(artifactDir(run), 'accounts.json');
    writeJson(file, accounts);
    console.log(JSON.stringify({ file, children: accounts.children.length }));
  } else if (command === 'create') await create(options);
  else if (command === 'refresh') await refresh(options);
  else if (command === 'cleanup') await cleanup(options);
  else {
    console.error(
      'usage: node scripts/load/accounts.mjs <local|create|refresh|cleanup> [--run R] [--count N] ...',
    );
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
