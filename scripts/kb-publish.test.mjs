import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as kbLoader from '../packages/kb-loader/dist/index.js';
import { runManifestCli } from '../packages/kb-loader/dist/cli.js';
import * as skills from '../services/pet-agent/dist/skills.js';
import {
  classify,
  contentType,
  decideApproval,
  objectName,
  parseArgs,
  planReplacement,
  publish,
  RefusalError,
  UsageError,
} from './kb-publish.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = join(ROOT, 'kb/v0.1.0');
const modules = { ...kbLoader, ...skills, runManifestCli, AdcGoogleHttp: class {} };

function fakeFirestore(seed = []) {
  const docs = new Map(seed.map((id) => [id, { seeded: true }]));
  const ops = [];
  const collection = (name) => ({
    doc: (id) => ({ name, id }),
    select: () => ({ get: async () => ({ docs: [...docs.keys()].map((id) => ({ id })) }) }),
  });
  return {
    docs,
    ops,
    collection,
    batch: () => {
      const pending = [];
      return {
        set: (ref, data) => pending.push(['set', ref, data]),
        delete: (ref) => pending.push(['delete', ref]),
        commit: async () => {
          for (const [kind, ref, data] of pending) {
            assert.equal(ref.name, 'kbChunks');
            if (kind === 'set') docs.set(ref.id, data);
            else docs.delete(ref.id);
            ops.push(kind);
          }
        },
      };
    },
  };
}

async function copyKb() {
  const temp = await mkdtemp(join(tmpdir(), 'kb-publish-'));
  const dir = join(temp, 'v0.1.0');
  const source = new kbLoader.FsKbSource(KB_DIR);
  for (const path of await source.list()) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), await source.read(path));
  }
  return { temp, dir };
}

async function approve(dir) {
  const source = new kbLoader.FsKbSource(dir);
  for (const path of (await source.list()).filter(kbLoader.isConversationContent)) {
    const text = (await source.read(path)).toString('utf8');
    await writeFile(
      join(dir, path),
      text.replaceAll(kbLoader.LITERATURE_MARKER, '専門家レビュー済み'),
    );
  }
  const review = join(dir, 'content-review.yaml');
  await writeFile(
    review,
    (await readFile(review, 'utf8')).replace(
      /^review_status: .+$/m,
      'review_status: expert_approved',
    ),
  );
  const { files } = await kbLoader.buildManifest(source, {
    version: '0.1.0',
    releasedAt: '2026-10-03T00:00:00.000Z',
    approvedBy: [],
  });
  await writeFile(
    join(dir, 'review/synthetic.yaml'),
    [
      'reviewer: synthetic-reviewer',
      'qualification: synthetic-test-only',
      "scope: ['**']",
      "reviewed_at: '2026-10-03'",
      `manifest_hash: '${kbLoader.manifestHash(files)}'`,
      'signature_note: synthetic fixture, not a real review',
      '',
    ].join('\n'),
  );
  assert.equal(await runManifestCli([dir, '--release']), 0);
}

const quiet = () => {
  const lines = [];
  return { lines, log: (event, fields) => lines.push({ event, ...fields }) };
};

test('argument parsing enforces the production guard rails', () => {
  const base = parseArgs(['kb/v0.1.0', '--project=demo-ijime-12'], {});
  assert.deepEqual(base, {
    dir: 'kb/v0.1.0',
    project: 'demo-ijime-12',
    environment: 'dev',
    embedder: 'vertex',
    allowDraft: false,
    skipGcs: false,
    dryRun: false,
  });
  assert.equal(parseArgs(['kb/v0.1.0'], { GCP_PROJECT_ID: 'from-env-1' }).project, 'from-env-1');
  assert.equal(parseArgs(['kb/v0.1.0', '--embedder=fake', '--skip-gcs']).project, undefined);
  for (const argv of [
    [],
    ['kb/README'],
    ['kb/v0.1.0', 'extra'],
    ['kb/v0.1.0', '--unknown'],
    ['kb/v0.1.0', '--embedder=openai'],
    ['kb/v0.1.0', '--project=Bad Project'],
    ['kb/v0.1.0'],
    ['kb/v0.1.0', '--project=demo-ijime-12', '--environment=prod', '--allow-draft'],
    ['kb/v0.1.0', '--project=demo-ijime-12', '--environment=production', '--embedder=fake'],
  ]) {
    assert.throws(() => parseArgs(argv, {}), UsageError, argv.join(' '));
  }
});

test('replacement keeps only the new version and drops stale same-version chunks', () => {
  assert.deepEqual(
    planReplacement(
      ['0.0.9__a__0', '0.1.0__a__0', '0.1.0__a__7', 'x'],
      ['0.1.0__a__0', '0.1.0__a__1'],
    ),
    ['0.0.9__a__0', '0.1.0__a__7', 'x'],
  );
  assert.equal(objectName('0.1.0', 'skills/a.md'), '0.1.0/skills/a.md');
  assert.equal(contentType('skills/a.md'), 'text/markdown; charset=utf-8');
  assert.equal(contentType('rules/x.yaml'), 'application/yaml');
  assert.equal(contentType('manifest.json'), 'application/json');
  assert.equal(contentType('x.bin'), 'application/octet-stream');
});

test('approval requires verified signatures that cover every manifest approver', async () => {
  const draft = { manifest: { approvedBy: [], reviewStatus: 'draft_pending_expert_review' } };
  const signed = { manifest: { approvedBy: ['a'], reviewStatus: 'expert_approved' } };
  const ok = async () => ({ reviewers: ['a'] });
  const fail = async () => {
    throw new Error('expert review: not releasable');
  };
  assert.deepEqual(await decideApproval(signed, ok, { environment: 'prod' }), {
    approved: true,
    reviewers: ['a'],
  });
  await assert.rejects(decideApproval(signed, fail, { environment: 'prod' }), RefusalError);
  await assert.rejects(decideApproval(draft, ok, { environment: 'dev' }), {
    message: 'kb_unapproved',
  });
  await assert.rejects(decideApproval(draft, ok, { environment: 'prod', allowDraft: true }), {
    message: 'kb_unapproved',
  });
  await assert.rejects(
    decideApproval({ manifest: { approvedBy: ['a', 'b'], reviewStatus: 'expert_approved' } }, ok, {
      environment: 'prod',
    }),
    { message: 'kb_unapproved' },
  );
  assert.deepEqual(await decideApproval(draft, ok, { environment: 'dev', allowDraft: true }), {
    approved: false,
    reviewers: [],
  });
});

test('a literature-reviewed manifest is never published as approved', async () => {
  const literature = { manifest: { approvedBy: [], reviewStatus: 'literature_reviewed' } };
  const ok = async () => ({ reviewers: ['a'] });
  await assert.rejects(decideApproval(literature, ok, { environment: 'dev' }), {
    message: 'kb_unapproved',
  });
  await assert.rejects(decideApproval(literature, ok, { environment: 'prod' }), {
    message: 'kb_unapproved',
  });
  assert.deepEqual(await decideApproval(literature, ok, { environment: 'dev', allowDraft: true }), {
    approved: false,
    reviewers: [],
  });
});

test('the bundled unsigned KB is refused without --allow-draft and nothing is written', async () => {
  const db = fakeFirestore(['old']);
  const { log } = quiet();
  await assert.rejects(
    publish(
      { dir: 'kb/v0.1.0', environment: 'dev', embedder: 'fake', allowDraft: false, skipGcs: true },
      { modules, firestore: db, log, upload: () => assert.fail('no upload') },
    ),
    { message: 'kb_unapproved' },
  );
  assert.deepEqual(db.ops, []);
  assert.deepEqual([...db.docs.keys()], ['old']);
});

test('--allow-draft publishes approved=false chunks, replaces old versions and uploads the tree', async () => {
  const db = fakeFirestore(['0.0.9__bedtime__0', '0.1.0__bedtime__99']);
  const uploads = [];
  const { lines, log } = quiet();
  const result = await publish(
    { dir: 'kb/v0.1.0', environment: 'dev', embedder: 'fake', allowDraft: true, skipGcs: false },
    {
      modules,
      firestore: db,
      log,
      upload: async (name, bytes, type) => uploads.push([name, bytes.length, type]),
    },
  );
  assert.equal(result.approved, false);
  assert.ok(result.chunks > 11);
  assert.equal(result.deleted, 2);
  assert.equal(db.docs.size, result.chunks);
  for (const [id, doc] of db.docs) {
    assert.match(id, /^0\.1\.0__[a-z-]+__\d+$/);
    assert.equal(doc.kbVersion, '0.1.0');
    assert.equal(doc.approved, false);
    assert.equal(doc.embeddingModel, 'fake');
    assert.ok(doc.embedding);
    assert.ok(doc.text.length > 0);
    assert.ok(doc.gradeBands.length > 0);
  }
  const kb = await kbLoader.Kb.load(new kbLoader.FsKbSource(KB_DIR));
  assert.deepEqual(
    uploads.map(([name]) => name).sort(),
    [...kb.paths(), 'manifest.json'].map((path) => `0.1.0/${path}`).sort(),
  );
  assert.equal(result.uploaded, uploads.length);
  const skillText = await kb.text('skills/bedtime.md');
  const sentence = skillText.split('\n').find((line) => line.length > 20);
  assert.ok(!JSON.stringify(lines).includes(sentence));
  assert.deepEqual(
    lines.map((line) => line.event),
    [
      'kb_publish_start',
      'kb_publish_chunked',
      'kb_publish_embedded',
      'kb_publish_firestore',
      'kb_publish_gcs',
    ],
  );
});

test('a signed and released KB publishes approved=true chunks', async () => {
  const { temp, dir } = await copyKb();
  try {
    await approve(dir);
    const db = fakeFirestore();
    const { log } = quiet();
    const result = await publish(
      {
        dir: relative(ROOT, dir),
        environment: 'prod',
        embedder: 'vertex',
        allowDraft: false,
        skipGcs: true,
      },
      { modules, firestore: db, log, embedder: new skills.FakeEmbedder(8) },
    );
    assert.equal(result.approved, true);
    assert.ok([...db.docs.values()].every((doc) => doc.approved === true));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('a stale manifest fails kb:check before anything is embedded or written', async () => {
  const { temp, dir } = await copyKb();
  try {
    const path = join(dir, 'skills/bedtime.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\n`);
    const db = fakeFirestore();
    await assert.rejects(
      publish(
        {
          dir: relative(ROOT, dir),
          environment: 'dev',
          embedder: 'fake',
          allowDraft: true,
          skipGcs: true,
        },
        { modules, firestore: db, log: () => {} },
      ),
      { message: 'kb_check_failed' },
    );
    assert.deepEqual(db.ops, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('--dry-run stops after chunking', async () => {
  const { lines, log } = quiet();
  const result = await publish(
    {
      dir: 'kb/v0.1.0',
      environment: 'dev',
      embedder: 'fake',
      allowDraft: true,
      skipGcs: true,
      dryRun: true,
    },
    { modules, log, firestore: { collection: () => assert.fail('no firestore') } },
  );
  assert.equal(result.dryRun, true);
  assert.deepEqual(
    lines.map((line) => line.event),
    ['kb_publish_start', 'kb_publish_chunked'],
  );
});

test('verdicts never carry provider text', () => {
  assert.deepEqual(classify(new UsageError('x')), {
    status: 'usage',
    category: 'invalid_arguments',
  });
  assert.deepEqual(classify(new RefusalError('kb_unapproved')), {
    status: 'refused',
    category: 'kb_unapproved',
  });
  assert.deepEqual(classify(new RefusalError('build_required')), {
    status: 'usage',
    category: 'build_required',
  });
  assert.deepEqual(classify(Object.assign(new Error('SECRET'), { status: 403 })), {
    status: 'failed',
    category: 'provider_403',
  });
  assert.deepEqual(classify(new Error('SECRET')), { status: 'failed', category: 'error' });
});

test('CLI without arguments prints usage and exits 2', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/kb-publish.mjs')], {
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
  assert.deepEqual(JSON.parse(result.stdout), {
    event: 'kb_publish_aborted',
    status: 'usage',
    category: 'invalid_arguments',
  });
});
