import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  KB_DIR,
  LABELED_ITEMS_TABLE,
  REGION,
  ROOT,
  SUITE_NAMES,
  bigqueryInsert,
  loadKb,
  loadSignalDefinitions,
  loadSuite,
  summarize,
  toLabeledRows,
} from './eval-common.mjs';

export function parseArgs(args) {
  const options = { dryRun: false, suites: [], kbDir: join(ROOT, KB_DIR), project: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (name) => {
      const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
      const next = inline ?? args[++i];
      if (typeof next !== 'string' || next.length === 0 || next.startsWith('--'))
        throw new Error(`invalid_arguments: ${name} needs a value`);
      return next;
    };
    if (arg === '--help') return { help: true };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--suite' || arg.startsWith('--suite='))
      options.suites.push(...value('--suite').split(','));
    else if (arg === '--kb' || arg.startsWith('--kb=')) options.kbDir = resolve(value('--kb'));
    else if (arg === '--project' || arg.startsWith('--project='))
      options.project = value('--project');
    else throw new Error(`invalid_arguments: ${arg}`);
  }
  for (const suite of options.suites) {
    if (!SUITE_NAMES.includes(suite)) throw new Error(`invalid_arguments: unknown suite ${suite}`);
  }
  if (options.suites.length === 0) options.suites = [...SUITE_NAMES];
  options.suites = [...new Set(options.suites)];
  return options;
}

export async function checkSignalIds(loaded, kbDir) {
  const { kb, loader } = await loadKb(kbDir);
  const known = new Set((await loadSignalDefinitions(kb, loader)).map((d) => d.signal_id));
  for (const r of loaded.records) {
    for (const id of r.expected_signal_ids) {
      if (!known.has(id)) throw new Error(`${r.id}: unknown signal id ${id}`);
    }
  }
  if (loaded.meta.kb_version !== kb.version)
    throw new Error(`${loaded.file}: kb_version ${loaded.meta.kb_version} != ${kb.version}`);
  return known.size;
}

export async function validateAll(options, hooks = {}) {
  const loadedSuites = [];
  const summaries = [];
  const ids = new Set();
  let kbCheck = 'skipped';
  for (const suite of options.suites) {
    const loaded = await loadSuite(suite, options.kbDir);
    for (const r of loaded.records) {
      if (ids.has(r.id)) throw new Error(`duplicate item id across suites: ${r.id}`);
      ids.add(r.id);
    }
    if (suite === 'signal') {
      try {
        await (hooks.checkSignalIds ?? checkSignalIds)(loaded, options.kbDir);
        kbCheck = 'ok';
      } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND') kbCheck = 'build_required';
        else throw error;
      }
    }
    loadedSuites.push(loaded);
    summaries.push(summarize(loaded));
  }
  return { loadedSuites, summaries, kbCheck };
}

function requireProject(options, env) {
  const project = options.project ?? env.GCP_PROJECT_ID;
  if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || project.startsWith('demo'))
    throw new Error('project_required: set GCP_PROJECT_ID or --project to a real project');
  if ((env.GCP_REGION ?? REGION) !== REGION) throw new Error(`tokyo_required: ${REGION} only`);
  return project;
}

export function insertLabeledRows(project, rows, deps = {}) {
  return bigqueryInsert(
    project,
    LABELED_ITEMS_TABLE,
    rows,
    (row) => `${row.kb_version}:${row.item_id}`,
    deps,
  );
}

export async function runLoad(args, env = process.env, hooks = {}) {
  const options = parseArgs(args);
  if (options.help) return { help: true, exitCode: 0 };
  const { loadedSuites, summaries, kbCheck } = await validateAll(options, hooks);
  const rows = loadedSuites.flatMap(toLabeledRows);
  const report = {
    mode: options.dryRun ? 'dry-run' : 'write',
    syntheticOnly: rows.every((row) => row.source === 'synthetic'),
    kbCheck,
    table: `${LABELED_ITEMS_TABLE.dataset}.${LABELED_ITEMS_TABLE.table}`,
    rows: rows.length,
    suites: summaries,
  };
  if (!options.dryRun) {
    const project = requireProject(options, env);
    report.inserted = await (hooks.insert ?? insertLabeledRows)(project, rows);
  }
  return { report, exitCode: 0 };
}

const USAGE =
  'Usage: node scripts/eval-load.mjs [--dry-run] [--suite crisis,signal,artwork,pet] [--kb kb/v0.1.0] [--project ID]\n' +
  '--dry-run validates the jsonl files and prints statistics. Without it, rows are inserted into eval.labeled_items\n' +
  'through the BigQuery client with ADC; GCP_PROJECT_ID (real, not demo) and GCP_REGION=asia-northeast1 are required.\n' +
  'Only ids and labels are uploaded; source texts stay in kb.\n';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runLoad(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(result.help ? USAGE : `${JSON.stringify(result.report, null, 2)}\n`);
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'eval-load failed'}\n`);
      process.exitCode = 1;
    });
}
