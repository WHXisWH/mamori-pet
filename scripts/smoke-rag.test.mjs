import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { agent } from '../packages/config/dist/index.js';
import { buildManifest, Kb } from '../packages/kb-loader/dist/index.js';
import {
  chunkSkill,
  createSkillSearch,
  FakeEmbedder,
  VectorSearchUnsupportedError,
} from '../services/pet-agent/dist/skills.js';
import {
  classify,
  LIMITS,
  preflight,
  probe,
  runBounded,
  runSmoke,
  sanitize,
} from './smoke-rag.mjs';

const env = {
  GCP_PROJECT_ID: 'synthetic-rag-project',
  GCP_REGION: 'asia-northeast1',
  GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc.json',
};
const approved = {
  version: '1.0.0',
  approvedBy: ['synthetic-test-only'],
  reviewStatus: 'expert_approved',
  files: { 'skills/play.md': '0'.repeat(64) },
};
const io = { existsSync: () => true, readFileSync: () => JSON.stringify(approved) };
const secret = 'SYNTHETIC_SECRET_DO_NOT_LOG';
const embedder = new FakeEmbedder(16);

async function fixture() {
  const files = new Map([
    ['skills/play.md', Buffer.from('# Drawing games\nEnjoy drawing together.\n')],
    ['skills/sleep.md', Buffer.from('# Bedtime\nSettle into a quiet evening.\n')],
  ]);
  const source = { list: async () => [...files.keys()], read: async (path) => files.get(path) };
  const manifest = await buildManifest(source, {
    version: '1.0.0',
    releasedAt: '2026-10-02T00:00:00.000Z',
    approvedBy: ['synthetic-test-only'],
    reviewStatus: 'expert_approved',
  });
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return Kb.load(source);
}

const hitsFrom = (kb, path, text) =>
  chunkSkill(path, text).map((chunk) => ({
    skillId: chunk.skillId,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    distance: 0.1,
  }));

test('no arguments and --check never launch a worker or authenticate', async () => {
  const forbidden = () => {
    throw new Error('must not launch');
  };
  assert.equal((await runSmoke([], env, io, forbidden)).category, 'opt_in_required');
  assert.deepEqual(await runSmoke(['--check'], env, io, forbidden), {
    status: 'blocked',
    category: 'configuration_only',
  });
  for (const args of [
    ['--vertex', '--check'],
    ['--query', secret],
    ['--list'],
    ['--region=global'],
  ])
    assert.equal((await runSmoke(args, env, io, forbidden)).category, 'invalid_arguments');
});

test('configuration blocks missing project, other regions, drafts and absent ADC before network', async () => {
  for (const [overrides, category] of [
    [{ GCP_PROJECT_ID: '' }, 'project_required'],
    [{ GCP_REGION: 'global' }, 'tokyo_required'],
  ]) {
    const result = await runSmoke(['--vertex'], { ...env, ...overrides }, io, () => {
      assert.fail('must not launch');
    });
    assert.deepEqual(result, { status: 'blocked', category });
  }
  for (const overrides of [
    { approvedBy: [] },
    { reviewStatus: 'draft_pending_expert_review' },
    { reviewStatus: 'literature_reviewed' },
  ]) {
    assert.equal(
      preflight(env, { ...io, readFileSync: () => JSON.stringify({ ...approved, ...overrides }) })
        .category,
      'kb_unapproved',
    );
  }
  assert.equal(preflight(env, { ...io, readFileSync: () => secret }).category, 'kb_invalid');
  assert.equal(preflight(env, { ...io, existsSync: () => false }).category, 'adc_missing');
});

test('probe uses the production adapter read-only and passes on a verified vector hit', async () => {
  const kb = await fixture();
  let queries = 0;
  const result = await probe(
    env,
    kb,
    createSkillSearch,
    {
      embedder,
      chunks: {
        nearest: async (input) => {
          queries++;
          assert.equal(input.kbVersion, '1.0.0');
          assert.equal(input.limit, agent.searchSkillMaxPassages);
          assert.equal(input.vector.length, 16);
          return [
            ...hitsFrom(kb, 'skills/play.md', await kb.text('skills/play.md')),
            { skillId: 'unknown', chunkIndex: 0, text: secret, distance: 0.2 },
          ];
        },
      },
    },
    agent.searchSkillMaxPassages,
  );
  assert.equal(queries, 1);
  assert.deepEqual(result, { status: 'pass', category: 'verified' });
});

test('empty collection blocks, unsupported vector search blocks, and lexical fallback never passes', async () => {
  const kb = await fixture();
  await assert.rejects(
    probe(env, kb, createSkillSearch, { embedder, chunks: { nearest: async () => [] } }, 3),
    { message: 'chunks_empty' },
  );
  const unsupported = await probe(
    env,
    kb,
    createSkillSearch,
    {
      embedder,
      chunks: {
        nearest: async () => {
          throw new VectorSearchUnsupportedError('12');
        },
      },
    },
    3,
  ).catch(classify);
  assert.deepEqual(unsupported, { status: 'blocked', category: 'vector_unsupported' });
  for (const hit of [
    { skillId: 'play', chunkIndex: 0, text: secret },
    { skillId: 'play', chunkIndex: 0, text: await kb.text('skills/sleep.md') },
    { skillId: 'unknown', chunkIndex: 0, text: 'Enjoy drawing together.' },
    { skillId: 'play', chunkIndex: 0, text: '' },
  ]) {
    const result = await probe(
      env,
      kb,
      createSkillSearch,
      { embedder, chunks: { nearest: async () => [hit] } },
      3,
    ).catch((error) => error.message);
    assert.ok(
      result === 'source_mismatch' || result === 'vector_not_observed',
      JSON.stringify(result),
    );
  }
});

test('real bundled unsigned KB remains blocked by the probe without touching the store', async () => {
  const { FsKbSource } = await import('../packages/kb-loader/dist/index.js');
  const kb = await Kb.load(new FsKbSource(fileURLToPath(new URL('../kb/v0.1.0', import.meta.url))));
  await assert.rejects(
    probe(
      env,
      kb,
      createSkillSearch,
      { embedder, chunks: { nearest: () => assert.fail('unsigned content must not reach cloud') } },
      agent.searchSkillMaxPassages,
    ),
    { message: 'kb_unapproved' },
  );
});

test('store failures propagate and classify without local success', async () => {
  const kb = await fixture();
  await assert.rejects(
    probe(
      env,
      kb,
      createSkillSearch,
      {
        embedder,
        chunks: {
          nearest: async () => {
            throw Object.assign(new Error(secret), { code: 7 });
          },
        },
      },
      3,
    ),
    { code: 7 },
  );
  assert.deepEqual(classify({ code: 7, message: secret }), {
    status: 'blocked',
    category: 'permission_denied',
  });
  assert.deepEqual(classify({ status: 403, responseText: secret }), {
    status: 'blocked',
    category: 'permission_denied',
  });
});

test('probe wrapper forbids extra embedding or query calls and private query text', async () => {
  const kb = await fixture();
  let embeds = 0;
  const twice = async (_kb, _env, deps) => async () => {
    await deps.embedder.embed(['Drawing'], 'RETRIEVAL_QUERY');
    await deps.embedder.embed(['Drawing'], 'RETRIEVAL_QUERY');
    return [];
  };
  const deps = {
    embedder: {
      model: 'fake',
      dimension: 16,
      embed: async (texts, task) => {
        embeds++;
        return embedder.embed(texts, task);
      },
    },
    chunks: { nearest: async () => [] },
  };
  await assert.rejects(probe(env, kb, twice, deps, 3), { message: 'call_budget' });
  assert.equal(embeds, LIMITS.embedCalls);
  const leaking = async (_kb, _env, d) => async () => {
    await d.embedder.embed([secret], 'RETRIEVAL_QUERY');
    return [];
  };
  await assert.rejects(probe(env, kb, leaking, deps, 3), { message: 'request_rejected' });
  const documentTask = async (_kb, _env, d) => async () => {
    await d.embedder.embed(['Drawing'], 'RETRIEVAL_DOCUMENT');
    return [];
  };
  await assert.rejects(probe(env, kb, documentTask, deps, 3), { message: 'request_rejected' });
});

test('bounded child suppresses output, strips unrelated env and sanitizes IPC', async () => {
  const child = new EventEmitter();
  child.kill = () => assert.fail('successful worker must not be killed');
  const launch = (_file, args, options) => {
    assert.deepEqual(args, ['--vertex']);
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
    assert.equal(options.env.NODE_ENV, 'production');
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.FIRESTORE_EMULATOR_HOST, undefined);
    assert.equal(options.env.OTEL_SDK_DISABLED, 'true');
    queueMicrotask(() => {
      child.emit('message', { status: 'pass', category: 'verified', text: secret, token: secret });
      child.emit('exit', 0);
    });
    return child;
  };
  assert.deepEqual(
    await runBounded(
      { ...env, OPENAI_API_KEY: secret, NODE_OPTIONS: secret, FIRESTORE_EMULATOR_HOST: 'x' },
      env.GOOGLE_APPLICATION_CREDENTIALS,
      launch,
    ),
    { status: 'pass', category: 'verified' },
  );
});

test('worker deadline kills and waits for exit; partial verdict does not pass', async () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = (signal) => {
    assert.equal(signal, 'SIGKILL');
    killed = true;
    queueMicrotask(() => child.emit('exit', null));
  };
  const result = await runBounded(
    env,
    env.GOOGLE_APPLICATION_CREDENTIALS,
    () => {
      queueMicrotask(() => child.emit('message', { status: 'pass', category: 'verified' }));
      return child;
    },
    10,
  );
  assert.equal(killed, true);
  assert.deepEqual(result, { status: 'fail', category: 'timeout' });
});

test('reports only allowlisted categories, not provider text, URLs, tokens or stacks', () => {
  for (const error of [
    new Error(secret),
    { response: { status: 500, data: secret } },
    { status: 400, stack: secret },
    { status: 401, token: secret },
    { status: 404, url: secret },
    { status: 429, message: secret },
    { code: 8, details: secret },
  ]) {
    const result = classify(error);
    assert.deepEqual(Object.keys(result).sort(), ['category', 'status']);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.deepEqual(sanitize({ status: 'pass', category: secret }), {
    status: 'fail',
    category: 'worker_failed',
  });
});

test('CLI without opt-in emits one sanitized blocked verdict and exits 2', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./smoke-rag.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 5000, env: { ...env, EMBEDDING_MODEL: secret } },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { status: 'blocked', category: 'opt_in_required' });
  assert.ok(!result.stdout.includes(secret));
});
