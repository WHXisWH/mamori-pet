import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';
import test from 'node:test';

import {
  CASES,
  LIMITS,
  SYNTHETIC_PNG,
  boundedModel,
  classifyError,
  parseArgs,
  preflight,
  runBoundedCase,
  runSmoke,
  sanitizeOutcome,
} from './smoke-google.mjs';

const script = fileURLToPath(new URL('./smoke-google.mjs', import.meta.url));
const secret = 'PRIVATE-provider-prompt-token-and-result';
const env = {
  GCP_PROJECT_ID: 'synthetic-smoke-project',
  GCP_REGION: 'asia-northeast1',
  GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc.json',
  GEMINI_MODEL_PET_CHAT: 'gemini-2.5-flash',
  GEMINI_MODEL_CRISIS_SCREEN: 'gemini-2.5-flash',
  GEMINI_MODEL_CRISIS_REVIEW: 'gemini-2.5-pro',
  GEMINI_MODEL_SIGNAL_EXTRACT: 'gemini-2.5-flash',
  GEMINI_MODEL_ARTWORK_FEATURE: 'gemini-2.5-pro',
  GEMINI_MODEL_PET_VOICE: 'gemini-live-2.5-flash-native-audio',
  PET_RAG_CORPUS: 'projects/synthetic-smoke-project/locations/asia-northeast1/ragCorpora/existing',
  PET_RAG_KB_VERSION: '0.1.0',
  PET_RAG_SKILL_SOURCES_JSON: '{"gs://synthetic/listening":"skills/placeholder-listening.md"}',
};
const credentials = {
  type: 'authorized_user',
  client_id: secret,
  client_secret: secret,
  refresh_token: secret,
};
const io = {
  existsSync: () => true,
  statSync: () => ({ isFile: () => true, size: 200 }),
  readFileSync: () => JSON.stringify(credentials),
};
const configured = (id, values) => preflight(id, values, io);
const pass = { status: 'pass', category: 'verified' };
const collect = async (iterator) => {
  const values = [];
  for await (const value of iterator) values.push(value);
  return values;
};

test('import is silent and inert, even when argv contains --vertex', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `process.argv.push('--vertex'); await import(${JSON.stringify(new URL('./smoke-google.mjs', import.meta.url).href)});`,
    ],
    { env: {}, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('default selects every case and never implies cloud opt-in', async () => {
  assert.deepEqual(parseArgs([]), { mode: undefined, cases: Object.keys(CASES) });
  const result = await runSmoke([], env, {
    preflight: () => assert.fail('no checks or SDK loading without opt-in'),
    runCase: () => assert.fail('no cloud without opt-in'),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.cases.length, 8);
  assert.ok(result.report.cases.every((row) => row.category === 'opt_in_required'));
});

test('strict case arguments are deduplicated, and modes are mutually exclusive', () => {
  assert.deepEqual(parseArgs(['--vertex', '--case', 'chat,tool', '--case=chat']).cases, [
    'chat',
    'tool',
  ]);
  for (const args of [
    ['--check', '--vertex'],
    ['--vertex', '--vertex'],
    ['--case'],
    ['--case='],
    ['--case', 'constructor'],
    ['--case=chat,'],
    ['--region=global'],
    ['--scripted'],
  ]) {
    assert.throws(() => parseArgs(args), { message: 'invalid_arguments' });
  }
});

test('check validates local configuration without running a case or claiming a model pass', async () => {
  const result = await runSmoke(['--check', '--case', 'chat,rag'], env, {
    preflight: configured,
    runCase: () => assert.fail('check must be local only'),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(
    result.report.cases.every(
      (row) => row.status === 'blocked' && row.category === 'configuration_only',
    ),
  );
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('/synthetic'));
});

test('guards reject demo projects, non-Tokyo regions, aliases and absent ADC before SDKs', () => {
  const cases = [
    [{ GCP_PROJECT_ID: '' }, 'project_required'],
    [{ GCP_PROJECT_ID: 'demo-ijime' }, 'project_required'],
    [{ GCP_REGION: '' }, 'tokyo_required'],
    [{ GCP_REGION: 'global' }, 'tokyo_required'],
    [{ GCP_REGION: 'us-central1' }, 'tokyo_required'],
    [{ GEMINI_MODEL_PET_CHAT: '' }, 'model_required'],
    [{ GEMINI_MODEL_PET_CHAT: 'gemini-flash' }, 'model_required'],
    [{ GEMINI_MODEL_PET_CHAT: 'gemini-2.5-flash-latest' }, 'model_required'],
    [{ GEMINI_MODEL_PET_CHAT: secret }, 'model_required'],
  ];
  for (const [override, category] of cases) {
    assert.equal(preflight('chat', { ...env, ...override }, io).category, category);
  }
  assert.equal(preflight('chat', env, { ...io, existsSync: () => false }).category, 'adc_missing');
  assert.equal(
    preflight('chat', env, { ...io, existsSync: (path) => !path.endsWith('index.js') }).category,
    'build_required',
  );
});

test('ADC inspection only reads a bounded regular file and reports safe categories', () => {
  for (const raw of ['not JSON ' + secret, 'null', '{}', '{"type":"authorized_user"}']) {
    const result = preflight('chat', env, { ...io, readFileSync: () => raw });
    assert.ok(['adc_invalid', 'adc_unsupported'].includes(result.category));
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal(
    preflight('chat', env, {
      ...io,
      readFileSync: () => assert.fail('oversized file must not be read'),
      statSync: () => ({ isFile: () => true, size: 2_000_000 }),
    }).category,
    'adc_invalid',
  );
  assert.equal(
    preflight('chat', env, {
      ...io,
      readFileSync: () =>
        JSON.stringify({
          type: 'service_account',
          client_email: 'synthetic',
          private_key: secret,
          project_id: 'synthetic',
        }),
    }).category,
    'configuration_only',
  );
});

test('unsupported Tokyo Live is always blocked and never dispatched', async () => {
  const result = await runSmoke(['--vertex', '--case', 'live'], env, {
    preflight: configured,
    runCase: () => assert.fail('no supported Tokyo Live route'),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.cases[0].category, 'live_tokyo_unavailable');
  assert.equal(result.report.cases[0].modelId, env.GEMINI_MODEL_PET_VOICE);
});

test('synthetic artwork PNG decodes and every PNG chunk has a valid CRC', () => {
  const png = Buffer.from(SYNTHETIC_PNG, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    assert.equal(
      crc32(png.subarray(offset + 4, offset + 8 + size)),
      png.readUInt32BE(offset + 8 + size),
    );
    if (type === 'IDAT')
      assert.equal(inflateSync(png.subarray(offset + 8, offset + 8 + size)).length, 3);
    chunks.push(type);
    offset += 12 + size;
  }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
});

test('RAG requires an existing Tokyo corpus and a versioned source map', () => {
  for (const [override, category] of [
    [{ PET_RAG_CORPUS: '' }, 'rag_corpus_required'],
    [
      { PET_RAG_CORPUS: env.PET_RAG_CORPUS.replace('asia-northeast1', 'us-central1') },
      'rag_tokyo_required',
    ],
    [{ PET_RAG_SKILL_SOURCES_JSON: secret }, 'rag_mapping_required'],
    [{ PET_RAG_SKILL_SOURCES_JSON: '{}' }, 'rag_mapping_required'],
    [{ PET_RAG_SKILL_SOURCES_JSON: '{"source":"../../private"}' }, 'rag_mapping_required'],
    [{ PET_RAG_KB_VERSION: '0.0.0' }, 'rag_mapping_required'],
  ])
    assert.equal(preflight('rag', { ...env, ...override }, io).category, category);
  assert.equal(preflight('rag', env, io).category, 'configuration_only');
});

test('classification never derives an error category from provider text', () => {
  for (const [error, expected] of [
    [{ status: 401, message: secret }, 'unauthenticated'],
    [{ response: { status: 403, data: secret } }, 'permission_denied'],
    [{ status: 404 }, 'model_unavailable'],
    [{ status: 429 }, 'quota_exhausted'],
    [{ status: 400 }, 'request_rejected'],
    [{ status: 503 }, 'provider_error'],
    [{ code: 'ECONNRESET', message: secret }, 'network_error'],
    [{ name: 'AbortError', stack: secret }, 'timeout'],
    [{ code: 'ERR_MODULE_NOT_FOUND' }, 'build_required'],
    [new Error('401 timeout ' + secret), 'provider_error'],
    [{ category: 'verified', message: secret }, 'provider_error'],
  ]) {
    const result = classifyError(error);
    assert.equal(result.category, expected);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.deepEqual(sanitizeOutcome({ ...pass, text: secret, token: secret }), pass);
  assert.equal(
    sanitizeOutcome({ status: 'pass', category: 'configuration_only' }).category,
    'worker_failed',
  );
  assert.equal(sanitizeOutcome({ status: 'fail', category: secret }).category, 'worker_failed');
});

test('each case retains pass/fail/blocked independently; provider payloads are dropped', async () => {
  const calls = [];
  const result = await runSmoke(['--vertex', '--case=chat,tool,live,rag'], env, {
    preflight: configured,
    runCase: async (id) => {
      calls.push(id);
      return id === 'tool'
        ? { status: 'fail', category: 'tool_not_observed', text: secret }
        : { ...pass, text: secret };
    },
  });
  assert.deepEqual(calls, ['chat', 'tool', 'rag']);
  assert.deepEqual(
    result.report.cases.map((row) => row.status),
    ['pass', 'fail', 'blocked', 'pass'],
  );
  assert.equal(result.exitCode, 1);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('missing ADC fails fast and an authentication failure stops further requests', async () => {
  let calls = 0;
  const absent = await runSmoke(['--vertex'], env, {
    preflight: (id, values) => preflight(id, values, { ...io, existsSync: () => false }),
    runCase: () => assert.fail('missing ADC must never reach network'),
  });
  assert.equal(absent.exitCode, 2);
  assert.ok(absent.report.cases.every((row) => row.status === 'blocked'));
  const unauthorized = await runSmoke(['--vertex'], env, {
    preflight: configured,
    runCase: () => {
      calls++;
      throw { status: 401, message: secret };
    },
  });
  assert.equal(calls, 1);
  assert.equal(unauthorized.exitCode, 2);
});

test('the real model wrapper bounds calls, request time, output and SDK retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = boundedModel(
    {
      createGemini: (purpose, target) => {
        assert.equal(purpose, 'petChat');
        assert.deepEqual(target, { projectId: env.GCP_PROJECT_ID, location: 'asia-northeast1' });
        return {
          async *generateContentAsync(request, stream, signal) {
            calls++;
            assert.equal(signal, controller.signal);
            assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
            assert.ok(request.config.httpOptions.timeout < LIMITS.caseMs);
            assert.equal(request.config.maxOutputTokens, 2048);
            yield { content: { role: 'model', parts: [{ text: secret }] } };
          },
        };
      },
    },
    'petChat',
    env,
    controller.signal,
    1,
  );
  await collect(model.generateContentAsync({ config: { maxOutputTokens: 100000 } }, false));
  await assert.rejects(() => collect(model.generateContentAsync({})), { message: 'call_budget' });
  const upstream = AbortSignal.abort();
  await assert.rejects(() => collect(model.generateContentAsync({}, false, upstream)), {
    message: 'timeout',
  });
  controller.abort();
  await assert.rejects(() => collect(model.generateContentAsync({})), { message: 'timeout' });
  assert.equal(calls, 1);
  assert.equal(
    Object.values(CASES).reduce((total, spec) => total + spec.calls, 0),
    LIMITS.calls,
  );
});

test('worker stdout/stderr and inherited secrets are isolated; only safe IPC survives', async () => {
  const result = await runBoundedCase(
    'chat',
    {
      ...env,
      GOOGLE_API_KEY: secret,
      NODE_OPTIONS: '--require private.js',
      GOOGLE_VERTEX_BASE_URL: 'https://invalid.example',
      OTEL_EXPORTER_OTLP_ENDPOINT: secret,
    },
    '/synthetic/adc.json',
    1000,
    (_file, args, options) => {
      assert.deepEqual(args, ['--vertex', '--case', 'chat']);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      assert.deepEqual(options.execArgv, []);
      for (const key of [
        'GOOGLE_API_KEY',
        'NODE_OPTIONS',
        'GOOGLE_VERTEX_BASE_URL',
        'OTEL_EXPORTER_OTLP_ENDPOINT',
      ])
        assert.equal(options.env[key], undefined);
      assert.equal(options.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS, 'false');
      assert.equal(options.env.OTEL_SDK_DISABLED, 'true');
      const child = new EventEmitter();
      setImmediate(() => {
        child.emit('message', { ...pass, text: secret });
        child.emit('close', 0);
      });
      return child;
    },
  );
  assert.deepEqual(result, pass);
});

test(
  'hard deadline reaps a real stuck child, including one ignoring SIGTERM',
  { timeout: 5000 },
  async () => {
    let child;
    const started = Date.now();
    const result = await runBoundedCase('chat', env, '/synthetic/adc.json', 150, () => {
      child = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);'],
        { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      return child;
    });
    assert.equal(result.category, 'timeout');
    assert.ok(Date.now() - started < 3000);
    assert.ok(child.signalCode === 'SIGKILL' || child.signalCode === 'SIGTERM');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  },
);

test('direct CLI without credentials reports only bounded metadata and exits blocked', () => {
  const child = spawnSync(process.execPath, [script, '--vertex', '--case=chat'], {
    env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent-google-smoke-credentials.json' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.status, 2);
  assert.equal(child.stderr, '');
  const report = JSON.parse(child.stdout);
  assert.equal(report.cases[0].category, 'adc_missing');
  assert.deepEqual(Object.keys(report.cases[0]), [
    'case',
    'modelId',
    'status',
    'category',
    'durationMs',
  ]);
});
