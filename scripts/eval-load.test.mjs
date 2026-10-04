import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  EvalDataError,
  SUITE_NAMES,
  SUITES,
  parseSuite,
  toLabeledRows,
  validateRecord,
} from './eval-common.mjs';
import { parseArgs, runLoad, validateAll } from './eval-load.mjs';

const script = fileURLToPath(new URL('./eval-load.mjs', import.meta.url));
const meta = (suite) =>
  JSON.stringify({
    kind: 'meta',
    suite,
    status: 'DRAFT',
    source: 'synthetic',
    kb_version: '0.1.0',
    labeler: 'synthetic-adult-author',
  });
const crisisRecord = {
  id: 'crisis-x01',
  text: 'synthetic text',
  grade_band: 'low',
  expected_hit: false,
  expected_category: 'none',
  expected_family_harm: false,
  tags: ['ordinary'],
  source: 'synthetic',
  labeler: 'synthetic-adult-author',
};
const lines = (suite, ...records) =>
  [meta(suite), ...records.map((r) => JSON.stringify(r))].join('\n') + '\n';
const MINIMUM = { crisis: 60, signal: 55, artwork: 30, pet: 30 };

test('arguments default to every suite and reject unknown values', () => {
  assert.deepEqual(parseArgs([]).suites, SUITE_NAMES);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.deepEqual(parseArgs(['--suite', 'crisis,pet', '--suite=crisis']).suites, [
    'crisis',
    'pet',
  ]);
  for (const args of [['--suite', 'unknown'], ['--suite'], ['--region=global'], ['--project']]) {
    assert.throws(() => parseArgs(args), /invalid_arguments/);
  }
});

test('the committed evaluation sets validate, cover every grade band and are synthetic only', async () => {
  const { loadedSuites, summaries, kbCheck } = await validateAll(parseArgs(['--dry-run']));
  assert.equal(kbCheck, 'ok');
  assert.equal(loadedSuites.length, SUITE_NAMES.length);
  for (const summary of summaries) {
    assert.ok(summary.count >= MINIMUM[summary.suite], `${summary.suite} has ${summary.count}`);
    assert.equal(summary.status, 'DRAFT');
    for (const band of ['low', 'high', 'jhs']) assert.ok(summary.byGrade[band] > 0);
  }
  const crisis = summaries.find((s) => s.suite === 'crisis');
  assert.ok(crisis.byLabel.expected_hit.true >= 25 && crisis.byLabel.expected_hit.false >= 25);
  for (const loaded of loadedSuites) {
    assert.ok(loaded.records.every((r) => r.source === 'synthetic'));
  }
  const signal = loadedSuites.find((s) => s.suite === 'signal');
  for (const category of [
    'verbal',
    'exclusion',
    'physical',
    'extortion',
    'property',
    'coercion',
    'cyber',
  ]) {
    for (const band of ['low', 'high', 'jhs']) {
      const n = signal.records.filter(
        (r) => r.grade_band === band && r.expected_categories.includes(category),
      ).length;
      assert.ok(n >= 2, `${category}/${band} has ${n}`);
    }
  }
  assert.ok(signal.records.filter((r) => r.expected_categories.length === 0).length >= 15);
});

test('records with missing, unknown or inconsistent fields are rejected with a location', () => {
  assert.equal(validateRecord('crisis', crisisRecord), crisisRecord);
  const bad = [
    { ...crisisRecord, text: undefined },
    { ...crisisRecord, expected_category: 'family_harm' },
    { ...crisisRecord, source: 'pilot' },
    { ...crisisRecord, grade_band: 'adult' },
    { ...crisisRecord, tags: ['Dup Tag'] },
    { ...crisisRecord, extra: 1 },
    { ...crisisRecord, expected_hit: true },
    { ...crisisRecord, expected_family_harm: true },
  ];
  for (const record of bad) {
    assert.throws(
      () => validateRecord('crisis', record, 'f.jsonl', 7),
      (error) => {
        assert.ok(error instanceof EvalDataError);
        assert.match(error.message, /^f\.jsonl:7: /);
        return true;
      },
    );
  }
  const pet = {
    id: 'pet-x01',
    grade_band: 'jhs',
    character_id: 'moko',
    turns: ['a'],
    must_not: ['remember_real_name'],
    tags: [],
    source: 'synthetic',
    labeler: 'x',
  };
  assert.throws(() => validateRecord('pet', pet), /real_names/);
  assert.ok(validateRecord('pet', { ...pet, real_names: ['仮名'] }));
  assert.throws(() => validateRecord('pet', { ...pet, local_time: '25:00' }), /local_time/);
});

test('files need a meta line, unique prefixed ids and valid JSON', () => {
  const ok = parseSuite('crisis', lines('crisis', crisisRecord));
  assert.equal(ok.records.length, 1);
  assert.throws(() => parseSuite('crisis', JSON.stringify(crisisRecord) + '\n'), /meta/);
  assert.throws(() => parseSuite('crisis', lines('signal', crisisRecord)), /meta/);
  assert.throws(
    () => parseSuite('crisis', lines('crisis', crisisRecord, crisisRecord)),
    /duplicate/,
  );
  assert.throws(
    () => parseSuite('crisis', lines('crisis', { ...crisisRecord, id: 'signal-x01' })),
    /must start with crisis-/,
  );
  assert.throws(() => parseSuite('crisis', meta('crisis') + '\n{bad\n'), /invalid JSON/);
});

test('BigQuery rows follow eval.labeled_items and never carry the source text', () => {
  const loaded = parseSuite('crisis', lines('crisis', crisisRecord));
  const [row] = toLabeledRows(loaded);
  assert.deepEqual(Object.keys(row).sort(), [
    'expert_label',
    'grade_band',
    'item_id',
    'kb_version',
    'labeler',
    'source',
  ]);
  assert.equal(row.item_id, 'crisis-x01');
  assert.equal(row.kb_version, '0.1.0');
  const label = JSON.parse(row.expert_label);
  assert.equal(label.suite, 'crisis');
  assert.equal(label.expected_category, 'none');
  for (const field of SUITES.crisis.textFields) assert.equal(field in label, false);
  assert.equal(JSON.stringify(row).includes('synthetic text'), false);
});

test('write mode needs a real Tokyo project and inserts through the injected client', async () => {
  await assert.rejects(runLoad(['--suite', 'artwork'], {}), /project_required/);
  await assert.rejects(
    runLoad(['--suite', 'artwork'], { GCP_PROJECT_ID: 'demo-ijime' }),
    /project_required/,
  );
  await assert.rejects(
    runLoad(['--suite', 'artwork'], {
      GCP_PROJECT_ID: 'synthetic-eval',
      GCP_REGION: 'us-central1',
    }),
    /tokyo_required/,
  );
  let seen;
  const result = await runLoad(
    ['--suite', 'artwork'],
    { GCP_PROJECT_ID: 'synthetic-eval', GCP_REGION: 'asia-northeast1' },
    {
      insert: async (project, rows) => {
        seen = { project, rows };
        return rows.length;
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(seen.project, 'synthetic-eval');
  assert.equal(result.report.inserted, seen.rows.length);
  assert.ok(seen.rows.every((row) => row.source === 'synthetic'));
});

test('the CLI dry-run prints statistics and exits 0 without any project configuration', () => {
  const child = spawnSync(process.execPath, [script, '--dry-run'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.suites.length, SUITE_NAMES.length);
  assert.equal(report.inserted, undefined);
});
