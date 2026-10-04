import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGION = 'asia-northeast1';
export const KB_DIR = 'kb/v0.1.0';
export const EVAL_DIR = `${KB_DIR}/eval`;
export const LABELED_ITEMS_TABLE = { dataset: 'eval', table: 'labeled_items' };
export const RUNS_TABLE = { dataset: 'eval', table: 'runs' };

export const GRADE_BANDS = ['low', 'high', 'jhs'];
export const CRISIS_CATEGORIES = ['none', 'suicidal', 'self_harm', 'violence', 'extortion'];
export const STORY_OUTCOMES = ['positive', 'compensated', 'negative', 'unclear'];
export const CHARACTER_IDS = ['moko', 'pokke', 'togemaru', 'nami', 'hoshi', 'hidden'];
export const ARTWORK_TYPES = ['story', 'island'];
export const SIGNAL_CATEGORIES = [
  'verbal',
  'exclusion',
  'physical',
  'extortion',
  'property',
  'coercion',
  'cyber',
];
export const MUST_NOT = {
  lecture: 1,
  claim_human: 2,
  promise_secrecy: 3,
  only_me: 4,
  teach_harm: 5,
  diagnose_label: 6,
  keep_up_late: 7,
  multiple_questions: 8,
  remember_real_name: 10,
  support_jargon: 11,
  probe_worries: 12,
  romance: null,
};
export const PET_TOOLS = [
  'get_child_context',
  'search_skill',
  'record_mood',
  'remember',
  'recall',
  'set_expression',
  'offer_quick_replies',
  'show_help_resources',
  'suggest_game',
  'start_tell_adult',
  'escalate_crisis',
];
const META_STATUSES = ['DRAFT', 'expert_approved'];
const ID_PATTERN = /^[a-z]+-[a-z0-9][a-z0-9-]*$/;
const TAG_PATTERN = /^[a-z][a-z0-9_]*$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const SUITES = {
  crisis: {
    file: 'crisis_redteam.jsonl',
    textFields: ['text'],
    labelFields: ['expected_hit', 'expected_category', 'expected_family_harm', 'tags'],
  },
  signal: {
    file: 'signal_extraction.jsonl',
    textFields: ['text'],
    labelFields: ['expected_categories', 'expected_signal_ids', 'expected_explicit', 'tags'],
  },
  artwork: {
    file: 'artwork_narratives.jsonl',
    textFields: ['text'],
    labelFields: ['artwork_type', 'expected_story_outcome', 'expected_explicit_harm', 'tags'],
  },
  pet: {
    file: 'pet_scenarios.jsonl',
    textFields: ['turns', 'real_names'],
    labelFields: ['character_id', 'must_not', 'expected_tools', 'local_time', 'tags'],
  },
};
export const SUITE_NAMES = Object.keys(SUITES);

export class EvalDataError extends Error {
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.file = file;
    this.line = line;
  }
}

const isText = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isBool = (v) => typeof v === 'boolean';
const isEnum = (list) => (v) => list.includes(v);
const isList =
  (check, { min = 0, max = 32 } = {}) =>
  (v) =>
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every(check) &&
    new Set(v).size === v.length;
const isTags = isList((t) => typeof t === 'string' && TAG_PATTERN.test(t));

const COMMON = {
  id: (v) => typeof v === 'string' && ID_PATTERN.test(v) && v.length <= 64,
  source: (v) => v === 'synthetic',
  grade_band: isEnum(GRADE_BANDS),
  labeler: (v) => isText(v, 64),
};
const FIELDS = {
  crisis: {
    required: {
      ...COMMON,
      text: (v) => isText(v),
      expected_hit: isBool,
      expected_category: isEnum(CRISIS_CATEGORIES),
      expected_family_harm: isBool,
      tags: isTags,
    },
    optional: {},
    cross: (r) =>
      r.expected_hit === (r.expected_category !== 'none') &&
      (!r.expected_family_harm || r.expected_hit),
    crossMessage: 'expected_category must be none exactly when expected_hit is false',
  },
  signal: {
    required: {
      ...COMMON,
      text: (v) => isText(v),
      expected_categories: isList(isEnum(SIGNAL_CATEGORIES), { max: SIGNAL_CATEGORIES.length }),
      expected_signal_ids: isList((s) => typeof s === 'string' && /^[A-Z]-[A-Z]+-\d{3}$/.test(s)),
      expected_explicit: isBool,
      tags: isTags,
    },
    optional: {},
    cross: (r) => r.expected_categories.length > 0 || r.expected_signal_ids.length === 0,
    crossMessage: 'expected_signal_ids requires a category',
  },
  artwork: {
    required: {
      ...COMMON,
      text: (v) => isText(v),
      artwork_type: isEnum(ARTWORK_TYPES),
      expected_story_outcome: isEnum(STORY_OUTCOMES),
      expected_explicit_harm: isBool,
      tags: isTags,
    },
    optional: {},
    cross: () => true,
    crossMessage: '',
  },
  pet: {
    required: {
      ...COMMON,
      character_id: isEnum(CHARACTER_IDS),
      turns: isList((t) => isText(t, 300), { min: 1, max: 8 }),
      must_not: isList(isEnum(Object.keys(MUST_NOT)), { min: 1 }),
      tags: isTags,
    },
    optional: {
      expected_tools: isList(isEnum(PET_TOOLS), { min: 1 }),
      local_time: (v) => typeof v === 'string' && TIME_PATTERN.test(v),
      real_names: isList((t) => isText(t, 40), { min: 1, max: 5 }),
    },
    cross: (r) => !r.must_not.includes('remember_real_name') || Array.isArray(r.real_names),
    crossMessage: 'remember_real_name requires real_names',
  },
};

function validateMeta(suite, meta, file) {
  const ok =
    meta &&
    typeof meta === 'object' &&
    meta.kind === 'meta' &&
    meta.suite === suite &&
    META_STATUSES.includes(meta.status) &&
    meta.source === 'synthetic' &&
    /^\d+\.\d+\.\d+$/.test(meta.kb_version ?? '') &&
    isText(meta.labeler, 64) &&
    (meta.note === undefined || isText(meta.note, 1000));
  if (!ok) throw new EvalDataError(file, 1, 'first line must be a valid meta record');
  return meta;
}

export function validateRecord(suite, record, file = SUITES[suite].file, line = 0) {
  const spec = FIELDS[suite];
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new EvalDataError(file, line, 'record must be an object');
  for (const key of Object.keys(record)) {
    if (!(key in spec.required) && !(key in spec.optional))
      throw new EvalDataError(file, line, `unknown field ${key}`);
  }
  for (const [key, check] of Object.entries(spec.required)) {
    if (!check(record[key])) throw new EvalDataError(file, line, `invalid field ${key}`);
  }
  for (const [key, check] of Object.entries(spec.optional)) {
    if (record[key] !== undefined && !check(record[key]))
      throw new EvalDataError(file, line, `invalid field ${key}`);
  }
  if (!spec.cross(record)) throw new EvalDataError(file, line, spec.crossMessage);
  return record;
}

export function parseSuite(suite, content, file = SUITES[suite].file) {
  if (!SUITES[suite]) throw new Error(`unknown suite ${suite}`);
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 2) throw new EvalDataError(file, 1, 'file needs a meta line and records');
  const parse = (text, line) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new EvalDataError(file, line, 'invalid JSON');
    }
  };
  const meta = validateMeta(suite, parse(lines[0], 1), file);
  const records = [];
  const seen = new Set();
  lines.slice(1).forEach((text, index) => {
    const line = index + 2;
    const record = validateRecord(suite, parse(text, line), file, line);
    if (!record.id.startsWith(`${suite}-`))
      throw new EvalDataError(file, line, `id must start with ${suite}-`);
    if (seen.has(record.id)) throw new EvalDataError(file, line, `duplicate id ${record.id}`);
    seen.add(record.id);
    records.push(record);
  });
  return { suite, file, meta, records };
}

export async function loadSuite(suite, kbDir = join(ROOT, KB_DIR)) {
  const file = SUITES[suite].file;
  const content = await readFile(join(kbDir, 'eval', file), 'utf8');
  return parseSuite(suite, content, file);
}

export function summarize(loaded) {
  const byGrade = Object.fromEntries(GRADE_BANDS.map((g) => [g, 0]));
  const byLabel = {};
  const bump = (key, value) => {
    const bucket = (byLabel[key] ??= {});
    bucket[String(value)] = (bucket[String(value)] ?? 0) + 1;
  };
  for (const r of loaded.records) {
    byGrade[r.grade_band]++;
    if (loaded.suite === 'crisis') {
      bump('expected_hit', r.expected_hit);
      bump('expected_category', r.expected_category);
      for (const t of r.tags) bump('tags', t);
    } else if (loaded.suite === 'signal') {
      bump('has_signal', r.expected_categories.length > 0);
      for (const c of r.expected_categories) bump('expected_categories', c);
      for (const id of r.expected_signal_ids) bump('expected_signal_ids', id);
    } else if (loaded.suite === 'artwork') {
      bump('expected_story_outcome', r.expected_story_outcome);
      bump('expected_explicit_harm', r.expected_explicit_harm);
      bump('artwork_type', r.artwork_type);
    } else {
      for (const m of r.must_not) bump('must_not', m);
      for (const t of r.expected_tools ?? []) bump('expected_tools', t);
    }
  }
  return {
    suite: loaded.suite,
    file: loaded.file,
    status: loaded.meta.status,
    kbVersion: loaded.meta.kb_version,
    count: loaded.records.length,
    byGrade,
    byLabel,
  };
}

export function toLabeledRows(loaded) {
  const { labelFields } = SUITES[loaded.suite];
  return loaded.records.map((r) => {
    const label = { suite: loaded.suite };
    for (const key of labelFields) if (r[key] !== undefined) label[key] = r[key];
    return {
      item_id: r.id,
      source: r.source,
      grade_band: r.grade_band,
      expert_label: JSON.stringify(label),
      labeler: r.labeler,
      kb_version: loaded.meta.kb_version,
    };
  });
}

export function assertNoSourceText(loaded, output) {
  const serialized = typeof output === 'string' ? output : JSON.stringify(output);
  for (const r of loaded.records) {
    for (const field of SUITES[loaded.suite].textFields) {
      const values = Array.isArray(r[field]) ? r[field] : r[field] === undefined ? [] : [r[field]];
      for (const v of values) {
        if (v.length >= 4 && serialized.includes(v))
          throw new Error(`output leaks source text of ${r.id}`);
      }
    }
  }
}

export async function importLocal(path) {
  return import(pathToFileURL(join(ROOT, path)).href);
}

export async function bigqueryInsert(project, table, rows, insertIdFor, { client } = {}) {
  let bigquery = client;
  if (!bigquery) {
    const notifierRequire = createRequire(join(ROOT, 'services/notifier/package.json'));
    const { BigQuery } = await import(
      pathToFileURL(notifierRequire.resolve('@google-cloud/bigquery')).href
    );
    bigquery = new BigQuery({ projectId: project, location: REGION });
  }
  const payload = rows.map((row) => ({ insertId: insertIdFor(row), json: row }));
  await bigquery.dataset(table.dataset).table(table.table).insert(payload, { raw: true });
  return rows.length;
}

export async function loadKb(kbDir = join(ROOT, KB_DIR)) {
  const loader = await importLocal('packages/kb-loader/dist/index.js');
  return { loader, kb: await loader.Kb.load(new loader.FsKbSource(kbDir)) };
}

export async function loadSignalDefinitions(kb, loader) {
  const defs = [];
  for (const path of kb.paths('signals/').filter((p) => p.endsWith('.yaml'))) {
    defs.push(await kb.yaml(path, loader.signalDefinitionSchema));
  }
  return defs;
}
