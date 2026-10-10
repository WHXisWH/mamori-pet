#!/usr/bin/env node
// 日次ジョブの負荷試験用の合成データ（シナリオ 4）：Firestore に N 人の合成の子どもと当日のシグナルを直接書き込み、
// Cloud Run Job risk-engine-daily（TARGET_DATE は同じ日）を実行して、report.mjs job で実行時間を読む。
//
//   seed     families/f_load_<run>_<i>/children/c_load_<run>_<i>、pseudoId p_load_<run>_<i>、1 人あたり --signals 件のシグナル
//   cleanup  これらの家庭のサブツリー全体を削除する。クラウド環境ではさらに BigQuery からこれらの pseudo_id の特徴量の行を削除する
//
// 日次ジョブが読むのは child の childId、pseudoId、gradeBand、status、createdAt / baselineReadyAt と signals だけで、
// 何も復号しないため、合成の子どもにはデータ鍵が要らない。子どものドキュメントには識別しやすいよう synthetic: true を付ける。
// ローカル：先に Firestore エミュレータを起動して FIRESTORE_EMULATOR_HOST を設定し、--project は demo-ijime、--no-bigquery を付ける。
import { pathToFileURL } from 'node:url';

import {
  SYNTHETIC_PREFIX,
  addDays,
  deleteFeatureRows,
  firestore,
  googleClient,
  intOption,
  parseArgs,
  requireOption,
  runLabel,
  tokyoDate,
} from './lib.mjs';

const GRADE_BANDS = ['low', 'high', 'jhs'];

export function syntheticIds(run, index) {
  const tag = `${SYNTHETIC_PREFIX}_${run.replaceAll('-', '_')}_${index}`;
  return { familyId: `f_${tag}`, childId: `c_${tag}`, pseudoId: `p_${tag}` };
}

// signal-worker が書き込む構造と同じ（services/signal-worker/src/store.ts）。ルールシグナルの計測値だけを使う
export function syntheticSignals(date, index, count) {
  const base = { explicit: false, scoring: 'score', value: 0, localDate: date, kbVersion: 'load' };
  const out = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 3;
    if (kind === 0)
      out.push({
        ...base,
        domain: 'i',
        signalDefId: 'load-i',
        metric: { name: 'i_message_hour', value: 16 + ((index + i) % 6) },
      });
    else if (kind === 1)
      out.push({
        ...base,
        domain: 'k',
        signalDefId: 'load-k',
        metric: { name: 'k_delete_ratio', value: 0.05 + ((index + i) % 5) / 100 },
      });
    else
      out.push({
        ...base,
        domain: 'a',
        signalDefId: 'load-a',
        metric: { name: 'a_valence', value: 0.1 + ((index + i) % 4) / 10 },
      });
  }
  return out;
}

async function seed(options) {
  const run = runLabel(options);
  const project = requireOption(options, 'project');
  const count = intOption(options, 'count', 500);
  const signals = intOption(options, 'signals', 6);
  const date = options.date ?? addDays(tokyoDate(), -1);
  const db = firestore(project);
  const writer = db.bulkWriter();
  const now = new Date();
  const dayStart = new Date(`${date}T03:00:00Z`);
  for (let index = 0; index < count; index++) {
    const { familyId, childId, pseudoId } = syntheticIds(run, index);
    const child = `families/${familyId}/children/${childId}`;
    writer.set(db.doc(child), {
      childId,
      familyId,
      pseudoId,
      gradeBand: GRADE_BANDS[index % GRADE_BANDS.length],
      status: 'active',
      synthetic: true,
      createdAt: new Date(dayStart.getTime() - 60 * 86_400_000),
      baselineReadyAt: new Date(dayStart.getTime() - 30 * 86_400_000),
    });
    syntheticSignals(date, index, signals).forEach((signal, i) =>
      writer.set(db.doc(`${child}/signals/load-${i}`), {
        ...signal,
        sourceRef: `${child}/sessions/load/messages/load-${i}`,
        extractedBy: 'rule',
        createdAt: now,
        expireAt: new Date(now.getTime() + 7 * 86_400_000),
      }),
    );
  }
  await writer.close();
  console.log(JSON.stringify({ run, project, date, children: count, signalsPerChild: signals }));
}

async function cleanup(options) {
  const run = runLabel(options);
  const project = requireOption(options, 'project');
  const count = intOption(options, 'count', 500);
  const db = firestore(project);
  const ids = Array.from({ length: count }, (_, i) => syntheticIds(run, i));
  for (const { familyId } of ids) await db.recursiveDelete(db.doc(`families/${familyId}`));
  const bigquery = options['no-bigquery']
    ? 'skipped'
    : await deleteFeatureRows(
        await googleClient(project),
        project,
        ids.map((i) => i.pseudoId),
      );
  console.log(JSON.stringify({ run, project, families: ids.length, bigquery }));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'seed') await seed(options);
  else if (command === 'cleanup') await cleanup(options);
  else {
    console.error(
      'usage: node scripts/load/seed-daily.mjs <seed|cleanup> --project P --run R [--count 500] [--signals 6] [--date YYYY-MM-DD] [--no-bigquery]',
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
