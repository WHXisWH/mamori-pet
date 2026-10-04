// Probes search_skill against the published Firestore kbChunks vector index (read-only: it never
// creates, embeds into or deletes kbChunks; publishing is scripts/kb-publish.mjs).
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(FILE), '..');
const REGION = 'asia-northeast1';
const KB_ROOT = join(ROOT, 'kb/v0.1.0');
export const LIMITS = Object.freeze({
  workerMs: 25_000,
  requestMs: 18_000,
  embedCalls: 1,
  queryCalls: 1,
});
const blocked = new Set([
  'opt_in_required',
  'configuration_only',
  'project_required',
  'tokyo_required',
  'kb_unapproved',
  'adc_missing',
  'build_required',
  'unauthenticated',
  'permission_denied',
  'model_unavailable',
  'quota_exhausted',
  'chunks_empty',
  'vector_unsupported',
]);
const failed = new Set([
  'invalid_arguments',
  'kb_invalid',
  'timeout',
  'provider_error',
  'worker_failed',
  'request_rejected',
  'vector_not_observed',
  'call_budget',
  'source_mismatch',
]);
const outcome = (category) => ({
  status: category === 'verified' ? 'pass' : blocked.has(category) ? 'blocked' : 'fail',
  category:
    category === 'verified' || blocked.has(category) || failed.has(category)
      ? category
      : 'provider_error',
});
class ProbeError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}
const demand = (condition, category) => {
  if (!condition) throw new ProbeError(category);
};

export function classify(error) {
  if (error instanceof ProbeError) return outcome(error.category);
  if (error?.name === 'VectorSearchUnsupportedError') return outcome('vector_unsupported');
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return outcome('timeout');
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code))
    return outcome('build_required');
  const grpc = { 7: 'permission_denied', 8: 'quota_exhausted', 16: 'unauthenticated' };
  if (typeof error?.code === 'number' && grpc[error.code]) return outcome(grpc[error.code]);
  return outcome(
    {
      400: 'request_rejected',
      401: 'unauthenticated',
      403: 'permission_denied',
      404: 'model_unavailable',
      429: 'quota_exhausted',
    }[error?.status ?? error?.response?.status] ?? 'provider_error',
  );
}

export function sanitize(value) {
  const safe = outcome(value?.category);
  return safe.category === value?.category && safe.status === value?.status
    ? safe
    : outcome('worker_failed');
}

// Local inspection only. Never refresh credentials or print their contents here.
export function preflight(env, io = { existsSync, readFileSync }) {
  try {
    demand(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.GCP_PROJECT_ID ?? ''), 'project_required');
    demand(env.GCP_REGION === REGION, 'tokyo_required');
    let manifest;
    try {
      manifest = JSON.parse(io.readFileSync(join(KB_ROOT, 'manifest.json'), 'utf8'));
    } catch {
      throw new ProbeError('kb_invalid');
    }
    demand(
      manifest.approvedBy?.length > 0 && manifest.reviewStatus === 'expert_approved',
      'kb_unapproved',
    );
    const adcPath =
      env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(
        env.CLOUDSDK_CONFIG || join(env.HOME || homedir(), '.config/gcloud'),
        'application_default_credentials.json',
      );
    demand(io.existsSync(adcPath), 'adc_missing');
    return { ...outcome('configuration_only'), adcPath };
  } catch (error) {
    return classify(error);
  }
}

// Exercises the production search adapter; only a verified public KB heading is queried.
export async function probe(env, kb, createSkillSearch, deps, maxPassages) {
  demand(
    kb.manifest.approvedBy.length > 0 && kb.manifest.reviewStatus === 'expert_approved',
    'kb_unapproved',
  );
  const skillPaths = kb
    .paths('skills/')
    .filter((path) => path.endsWith('.md') && !path.endsWith('/README.md'));
  const expectedPath = skillPaths[0];
  demand(expectedPath, 'kb_invalid');
  const publicQuery = (await kb.text(expectedPath)).split('\n')[0].replace(/^#\s+/, '');
  let embedCalls = 0;
  let queryCalls = 0;
  let hits = 0;
  let unsupported = false;
  let verifiedHits = 0;
  const embedder = {
    model: deps.embedder.model,
    dimension: deps.embedder.dimension,
    embed: async (texts, task) => {
      demand(++embedCalls <= LIMITS.embedCalls, 'call_budget');
      demand(task === 'RETRIEVAL_QUERY' && texts.length === 1, 'request_rejected');
      demand(
        texts[0].split(' ').every((term) => publicQuery.normalize('NFKC').includes(term)),
        'request_rejected',
      );
      return deps.embedder.embed(texts, task);
    },
  };
  const chunks = {
    nearest: async (input) => {
      demand(++queryCalls <= LIMITS.queryCalls, 'call_budget');
      demand(input.kbVersion === kb.version && input.limit <= maxPassages, 'request_rejected');
      let result;
      try {
        result = await deps.chunks.nearest(input);
      } catch (error) {
        if (error?.name === 'VectorSearchUnsupportedError') unsupported = true;
        throw error;
      }
      hits = result.length;
      for (const hit of result) {
        const path = `skills/${hit.skillId}.md`;
        if (
          skillPaths.includes(path) &&
          typeof hit.text === 'string' &&
          hit.text.trim().length > 0 &&
          (await kb.text(path)).includes(hit.text)
        )
          verifiedHits++;
      }
      return result;
    },
  };
  const search = await createSkillSearch(
    kb,
    { ...env, NODE_ENV: 'production' },
    { embedder, chunks },
  );
  const results = await search(publicQuery);
  demand(!unsupported, 'vector_unsupported');
  demand(embedCalls === 1 && queryCalls === 1, 'vector_not_observed');
  demand(hits > 0, 'chunks_empty');
  demand(verifiedHits > 0, 'source_mismatch');
  demand(results.length > 0 && results.length <= maxPassages, 'vector_not_observed');
  const passages = results.map((item) => JSON.parse(item));
  for (const passage of passages) {
    demand(
      passage.kind === 'reference' &&
        passage.kbVersion === kb.version &&
        skillPaths.includes(passage.path) &&
        passage.text === (await kb.text(passage.path)),
      'source_mismatch',
    );
  }
  return outcome('verified');
}

async function worker(env) {
  const config = preflight(env);
  if (config.category !== 'configuration_only') return sanitize(config);
  try {
    const { Kb, FsKbSource } = await import('../packages/kb-loader/dist/index.js');
    let kb;
    try {
      kb = await Kb.load(new FsKbSource(KB_ROOT));
    } catch {
      throw new ProbeError('kb_invalid');
    }
    const { createSkillSearch, VertexEmbedder, FirestoreKbChunkStore } =
      await import('../services/pet-agent/dist/skills.js');
    const { agent } = await import('../packages/config/dist/index.js');
    const require = createRequire(join(ROOT, 'services/pet-agent/package.json'));
    const { Firestore } = require('@google-cloud/firestore');
    const { GoogleAuth } = createRequire(join(ROOT, 'packages/service-kit/package.json'))(
      'google-auth-library',
    );
    let client;
    const http = {
      request: async (request) => {
        if (!client) {
          client = await new GoogleAuth({
            keyFilename: config.adcPath,
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          }).getClient();
        }
        const headers = await client.getRequestHeaders(request.url);
        headers.set('Content-Type', 'application/json');
        const response = await fetch(request.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(request.body),
          redirect: 'error',
          signal: AbortSignal.timeout(LIMITS.requestMs),
        });
        if (!response.ok) throw { status: response.status };
        return response.json();
      },
    };
    const db = new Firestore({ projectId: env.GCP_PROJECT_ID, keyFilename: config.adcPath });
    try {
      return await probe(
        env,
        kb,
        createSkillSearch,
        {
          embedder: new VertexEmbedder(env.GCP_PROJECT_ID, http, env.EMBEDDING_MODEL),
          chunks: new FirestoreKbChunkStore(db),
        },
        agent.searchSkillMaxPassages,
      );
    } finally {
      await db.terminate().catch(() => {});
    }
  } catch (error) {
    return classify(error);
  }
}

export function runBounded(env, adcPath, launch = fork, timeoutMs = LIMITS.workerMs) {
  return new Promise((resolveResult) => {
    const keys = ['PATH', 'HOME', 'TMPDIR', 'GCP_PROJECT_ID', 'GCP_REGION', 'EMBEDDING_MODEL'];
    const child = launch(FILE, ['--vertex'], {
      cwd: ROOT,
      env: {
        ...Object.fromEntries(
          keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
        ),
        GOOGLE_APPLICATION_CREDENTIALS: adcPath,
        NODE_ENV: 'production',
        SMOKE_RAG_WORKER: '1',
        ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
        OTEL_SDK_DISABLED: 'true',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      resolveResult(value);
    };
    child.on('message', (message) => {
      result = sanitize(message);
    });
    child.once('error', () => {
      child.kill('SIGKILL');
      finish(outcome('worker_failed'));
    });
    child.once('exit', (code) =>
      finish(
        timedOut ? outcome('timeout') : code === 0 && result ? result : outcome('worker_failed'),
      ),
    );
  });
}

export async function runSmoke(args, env = process.env, io, launch = fork) {
  if (args.length === 0) return outcome('opt_in_required');
  if (args.length !== 1 || !['--check', '--vertex'].includes(args[0]))
    return outcome('invalid_arguments');
  const config = preflight(env, io);
  if (args[0] === '--check' || config.category !== 'configuration_only') return sanitize(config);
  return runBounded(env, config.adcPath, launch);
}

async function main() {
  if (process.env.SMOKE_RAG_WORKER === '1' && process.send) {
    demand(process.argv.length === 3 && process.argv[2] === '--vertex', 'opt_in_required');
    process.once('disconnect', () => process.exit(1));
    const result = await worker(process.env);
    process.send(sanitize(result), () => process.exit(0));
    return;
  }
  const result = await runSmoke(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'blocked' ? 2 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(outcome('worker_failed'))}\n`);
    process.exitCode = 1;
  });
}
