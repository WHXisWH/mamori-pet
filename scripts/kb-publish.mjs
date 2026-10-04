import { createRequire } from 'node:module';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(FILE), '..');
export const USAGE =
  'usage: node scripts/kb-publish.mjs <kb/vX.Y.Z> [--project=ID] [--environment=dev|staging|prod] [--embedder=vertex|fake] [--allow-draft] [--skip-gcs] [--dry-run]';
export const BATCH_SIZE = 400;
const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export class UsageError extends Error {}
export class RefusalError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

export function isProduction(environment) {
  return /^prod/.test(environment);
}

export function parseArgs(argv, env = {}) {
  const options = {
    dir: undefined,
    project: env.GCP_PROJECT_ID,
    environment: env.ENVIRONMENT ?? 'dev',
    embedder: 'vertex',
    allowDraft: false,
    skipGcs: false,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === '--allow-draft') options.allowDraft = true;
    else if (arg === '--skip-gcs') options.skipGcs = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--project=')) options.project = arg.slice('--project='.length);
    else if (arg.startsWith('--environment='))
      options.environment = arg.slice('--environment='.length);
    else if (arg.startsWith('--embedder=')) options.embedder = arg.slice('--embedder='.length);
    else if (arg.startsWith('--') || options.dir) throw new UsageError(USAGE);
    else options.dir = arg;
  }
  if (!options.dir || !/^v?\d+\.\d+\.\d+$/.test(basename(options.dir))) throw new UsageError(USAGE);
  if (!['vertex', 'fake'].includes(options.embedder)) throw new UsageError(USAGE);
  if (!/^[a-z][a-z-]*$/.test(options.environment)) throw new UsageError(USAGE);
  if (isProduction(options.environment)) {
    if (options.allowDraft) throw new UsageError('--allow-draft is not allowed in production');
    if (options.embedder === 'fake')
      throw new UsageError('--embedder=fake is not allowed in production');
  }
  if (options.project !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project))
    throw new UsageError('invalid --project');
  if (!options.dryRun && !options.project && (options.embedder === 'vertex' || !options.skipGcs))
    throw new UsageError('--project is required unless --embedder=fake with --skip-gcs');
  return options;
}

export function planReplacement(existingIds, nextIds) {
  const keep = new Set(nextIds);
  return existingIds.filter((id) => !keep.has(id)).sort();
}

export function objectName(version, path) {
  return `${version}/${path}`;
}

export function contentType(path) {
  return CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
}

export async function decideApproval(kb, verify, options) {
  let verified;
  try {
    verified = await verify(kb);
  } catch {
    verified = undefined;
  }
  const approved =
    verified !== undefined &&
    kb.manifest.approvedBy.length > 0 &&
    kb.manifest.reviewStatus === 'expert_approved' &&
    kb.manifest.approvedBy.every((name) => verified.reviewers.includes(name));
  if (approved) return { approved: true, reviewers: verified.reviewers };
  if (options.allowDraft && !isProduction(options.environment))
    return { approved: false, reviewers: [] };
  throw new RefusalError('kb_unapproved');
}

async function loadModules() {
  try {
    const [kbLoader, skills, serviceKit] = await Promise.all([
      import(pathToFileURL(resolve(ROOT, 'packages/kb-loader/dist/index.js')).href),
      import(pathToFileURL(resolve(ROOT, 'services/pet-agent/dist/skills.js')).href),
      import(pathToFileURL(resolve(ROOT, 'packages/service-kit/dist/index.js')).href),
    ]);
    const { runManifestCli } = await import(
      pathToFileURL(resolve(ROOT, 'packages/kb-loader/dist/cli.js')).href
    );
    return { ...kbLoader, ...skills, ...serviceKit, runManifestCli };
  } catch (error) {
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code))
      throw new RefusalError('build_required');
    throw error;
  }
}

function firestoreClient(project) {
  const require = createRequire(resolve(ROOT, 'services/pet-agent/package.json'));
  const { Firestore } = require('@google-cloud/firestore');
  return new Firestore({ projectId: project });
}

function gcsUploader(project) {
  const require = createRequire(resolve(ROOT, 'packages/service-kit/package.json'));
  const { GoogleAuth } = require('google-auth-library');
  const client = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
  }).getClient();
  const bucket = `${project}-kb`;
  return async (name, bytes, type) => {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('name', name);
    await (
      await client
    ).request({
      url: url.toString(),
      method: 'POST',
      headers: { 'Content-Type': type },
      body: bytes,
    });
  };
}

export async function publish(options, deps = {}) {
  const log =
    deps.log ??
    ((event, fields = {}) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`));
  const m = deps.modules ?? (await loadModules());
  const dir = resolve(ROOT, options.dir);
  if ((await m.runManifestCli([dir, '--check'])) !== 0) throw new RefusalError('kb_check_failed');
  const source = new m.FsKbSource(dir);
  const kb = await m.Kb.load(source);
  const { approved, reviewers } = await decideApproval(kb, m.verifyReviewSignatures, options);
  log('kb_publish_start', {
    version: kb.version,
    environment: options.environment,
    approved,
    reviewers: reviewers.length,
    dryRun: options.dryRun,
  });
  const skillPaths = kb
    .paths('skills/')
    .filter((path) => path.endsWith('.md') && !path.endsWith('/README.md'));
  const chunks = [];
  for (const path of skillPaths) chunks.push(...m.chunkSkill(path, await kb.text(path)));
  log('kb_publish_chunked', { skills: skillPaths.length, chunks: chunks.length });
  if (options.dryRun) return { version: kb.version, approved, chunks: chunks.length, dryRun: true };
  const embedder =
    deps.embedder ??
    (options.embedder === 'fake'
      ? new m.FakeEmbedder()
      : new m.VertexEmbedder(options.project, new m.AdcGoogleHttp(), process.env.EMBEDDING_MODEL));
  const vectors = [];
  for (const chunk of chunks) {
    const [vector] = await embedder.embed([chunk.embeddingInput], 'RETRIEVAL_DOCUMENT');
    vectors.push(vector);
  }
  log('kb_publish_embedded', { model: embedder.model, dimension: embedder.dimension });
  const db = deps.firestore ?? firestoreClient(options.project);
  const collection = db.collection(m.KB_CHUNKS_COLLECTION);
  const nextIds = chunks.map((chunk) => m.kbChunkId(kb.version, chunk.skillId, chunk.chunkIndex));
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (let j = i; j < Math.min(i + BATCH_SIZE, chunks.length); j++) {
      batch.set(
        collection.doc(nextIds[j]),
        m.kbChunkDocument(chunks[j], vectors[j], {
          kbVersion: kb.version,
          approved,
          embeddingModel: embedder.model,
        }),
      );
    }
    await batch.commit();
  }
  const existing = (await collection.select().get()).docs.map((doc) => doc.id);
  const stale = planReplacement(existing, nextIds);
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const id of stale.slice(i, i + BATCH_SIZE)) batch.delete(collection.doc(id));
    await batch.commit();
  }
  log('kb_publish_firestore', { written: nextIds.length, deleted: stale.length });
  let uploaded = 0;
  if (!options.skipGcs) {
    const upload = deps.upload ?? gcsUploader(options.project);
    for (const path of [...kb.paths(), m.MANIFEST_PATH]) {
      const bytes = path === m.MANIFEST_PATH ? await source.read(path) : await kb.bytes(path);
      await upload(objectName(kb.version, path), bytes, contentType(path));
      uploaded++;
    }
    log('kb_publish_gcs', { objects: uploaded });
  }
  return { version: kb.version, approved, chunks: chunks.length, deleted: stale.length, uploaded };
}

export function classify(error) {
  if (error instanceof UsageError) return { status: 'usage', category: 'invalid_arguments' };
  if (error instanceof RefusalError)
    return {
      status: error.category === 'build_required' ? 'usage' : 'refused',
      category: error.category,
    };
  const status = error?.status ?? error?.response?.status ?? error?.code;
  return {
    status: 'failed',
    category: typeof status === 'number' ? `provider_${status}` : 'error',
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
    const result = await publish(options);
    process.stdout.write(`${JSON.stringify({ event: 'kb_publish_done', ...result })}\n`);
    process.exitCode = 0;
  } catch (error) {
    const verdict = classify(error);
    process.stdout.write(`${JSON.stringify({ event: 'kb_publish_aborted', ...verdict })}\n`);
    if (verdict.status === 'usage') process.stderr.write(`${error.message}\n`);
    process.exitCode = verdict.status === 'usage' ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
