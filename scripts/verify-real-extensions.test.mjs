import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { CallBudget, CASES, PROJECT, REGION, ROOT, sanitizeCase } from './verify-real-business.mjs';
import { EXTENSION_ASSERTIONS, runExtensionProbes } from './verify-real-extensions.mjs';

function fixture(fault = '') {
  const budget = new CallBudget(CASES.extensions.calls, Date.now() + 10_000);
  const checks = {};
  const child = {
    familyId: 'synthetic',
    childId: 'synthetic',
    gradeBand: 'high',
    characterId: 'moko',
  };
  const base = 'families/synthetic/children/synthetic';
  const docs = new Map();
  const plaintexts = new Map();
  const encrypt = (value) => {
    const bytes = Buffer.from(`cipher-${plaintexts.size}`);
    plaintexts.set(String(bytes), value);
    return bytes;
  };
  const inference = () => {
    budget.take('modelCalls');
    budget.take('transportCalls');
  };
  const snapshot = (data = {}) => ({ get: (key) => data[key], data: () => data });
  const db = {
    doc: (path) => ({
      get: async () => snapshot(docs.get(path)),
      update: async (data) => docs.set(path, { ...docs.get(path), ...data }),
    }),
    collection: (path) => ({
      get: async () => {
        const rows = [...docs].filter(
          ([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'),
        );
        return {
          empty: rows.length === 0,
          size: rows.length,
          docs: rows.map(([, data]) => snapshot(data)),
        };
      },
    }),
  };
  let safe,
    written = false,
    greeting;
  const runtime = {
    budget,
    db,
    kb: {},
    core: { childPath: () => base },
    detector: {
      check: async () => {
        inference();
        return {
          availability: fault === 'unchecked_summary' ? 'unavailable' : 'verified',
          hit: false,
          method: 'model',
          confidence: 0.01,
        };
      },
    },
    pet: {
      summarize: async () => {
        inference();
        return 'private synthetic summary';
      },
      sessions: {
        decryptForChild: (_child, bytes) => plaintexts.get(String(bytes)),
        writeChildMessage: async (_child, _session, message) => {
          assert.deepEqual(Object.keys(message.crisisCheck).sort(), [
            'checkedAt',
            'hit',
            'method',
            'score',
          ]);
          assert.equal(message.crisisCheck.hit, false);
          assert.equal(message.crisisCheck.score, 0.01);
          assert.ok(message.crisisCheck.checkedAt instanceof Date);
          docs.set(`${base}/sessions/synthetic/messages/input`, {
            contentEnc: encrypt(message.text),
          });
        },
      },
      executorFor: () => ({
        prepareMemory: async (_ctx, text) => {
          if (safe) return safe;
          if (fault !== 'uncounted_names') inference();
          const name = text.split('\u304f\u3093')[0];
          safe =
            fault === 'unredacted_name'
              ? text
              : text.replace(name, '\u304a\u3068\u3082\u3060\u3061A');
          docs.set(`${base}/private/pseudonyms`, {
            mapEnc: encrypt(
              JSON.stringify([
                [
                  name,
                  fault === 'wrong_persisted_alias' ? 'wrong' : '\u304a\u3068\u3082\u3060\u3061A',
                ],
              ]),
            ),
          });
          return safe;
        },
        remember: async (_ctx, text) => {
          docs.set(`${base}/memoryProposals/proposal`, {
            status: 'pending',
            contentEnc: encrypt(text),
            ...(fault === 'plaintext_proposal' ? { text } : {}),
          });
        },
      }),
    },
  };
  const judgeModel = { bounded: true };
  const modules = {
    'services/pet-agent/dist/summary.js': {
      AGENT_SUMMARY_INTERVAL_TURNS: 6,
      maybeWriteAgentSummary: async (_db, _sessions, _child, _session, _now, generate) => {
        if (written) return false;
        written = true;
        const text = await generate();
        docs.set(base, {
          agentSummary: {
            source: 'model',
            approved: fault === 'auto_approved',
            textEnc: encrypt(text),
          },
        });
        return true;
      },
    },
    'services/pet-agent/dist/context.js': {
      jstParts: () => ({ date: '2026-10-06' }),
      readChildContext: async () => ({
        recentTrend: fault === 'summary_leaked' ? 'private synthetic summary' : '',
      }),
    },
    'services/pet-agent/dist/proactive.js': {
      runProactiveTurn: async (_pet, task, now) => {
        assert.equal(now().getUTCHours(), 6);
        if (greeting) {
          if (fault === 'replay_calls_model') inference();
          return structuredClone(greeting);
        }
        inference();
        inference();
        if (fault === 'proactive_chat_history')
          docs.set(`${base}/sessions/proactive-${task.localDate}-${task.slot}/messages/leak`, {});
        greeting = {
          fallback: fault === 'fallback_greeting',
          greeting: { text: 'private synthetic greeting' },
        };
        return greeting;
      },
    },
    'scripts/eval-judge.mjs': {
      createGeminiJudge: async (_kb, env, options) => {
        assert.equal(options.model, judgeModel);
        assert.equal(env.GEMINI_MODEL_EVAL_JUDGE, 'gemini-2.5-pro');
        return async (scenario, turns) => {
          assert.equal(scenario.source, 'synthetic');
          assert.equal(scenario.grade_band, child.gradeBand);
          assert.equal(turns[0].replyText, greeting.greeting.text);
          if (fault !== 'uncounted_judge') inference();
          return {
            harmful: fault === 'harmful_judge',
            charterViolations: [],
            toneScore: 4,
            gradeFit: true,
          };
        };
      },
    },
  };
  return {
    budget,
    checks,
    run: () =>
      runExtensionProbes({
        runtime,
        child,
        sessionId: 'synthetic',
        judgeModel,
        env: { GEMINI_MODEL_EVAL_JUDGE: 'gemini-2.5-pro' },
        load: async (path) => {
          assert.ok(modules[path]);
          return modules[path];
        },
        check: (name, ok) => {
          assert.ok(EXTENSION_ASSERTIONS.includes(name));
          checks[name] = Boolean(ok);
          assert.ok(ok, name);
        },
      }),
  };
}

test('extension probes exercise all stages with the same budget and return no private data', async () => {
  const f = fixture();
  assert.equal(await f.run(), undefined);
  assert.equal(f.budget.modelCalls, 6);
  assert.equal(f.budget.transportCalls, 6);
  assert.deepEqual(Object.keys(f.checks), EXTENSION_ASSERTIONS);
  assert.ok(Object.values(f.checks).every(Boolean));
  const report = sanitizeCase('extensions', {
    status: 'pass',
    code: 'verified',
    assertions: f.checks,
    modelCalls: f.budget.modelCalls,
    transportCalls: f.budget.transportCalls,
  });
  assert.equal(report.exitCode, 0);
  assert.ok(!JSON.stringify(report).includes('private synthetic'));
});

for (const [fault, assertion] of [
  ['uncounted_names', 'names_model_called'],
  ['unredacted_name', 'names_redacted'],
  ['plaintext_proposal', 'names_encrypted_proposal'],
  ['wrong_persisted_alias', 'names_persisted_mapping'],
  ['unchecked_summary', 'summary_verified_detector'],
  ['auto_approved', 'summary_encrypted_unapproved'],
  ['summary_leaked', 'summary_excluded_from_context'],
  ['fallback_greeting', 'proactive_nonfallback'],
  ['replay_calls_model', 'proactive_replay_no_calls'],
  ['proactive_chat_history', 'proactive_no_chat_messages'],
  ['uncounted_judge', 'judge_model_called'],
  ['harmful_judge', 'judge_safe'],
]) {
  test(`extension probe fails closed: ${fault}`, async () => {
    const f = fixture(fault);
    await assert.rejects(f.run(), (error) => error.message === assertion);
    assert.equal(f.checks[assertion], false);
    const report = sanitizeCase('extensions', {
      status: 'pass',
      code: 'verified',
      assertions: f.checks,
      modelCalls: f.budget.modelCalls,
      transportCalls: f.budget.transportCalls,
    });
    assert.equal(report.exitCode, 1);
    assert.equal(report.code, 'incomplete_result');
  });
}

test('name, summary and judge HTTP attempts share the guarded ceiling, including failed requests', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { boundedModel, CallBudget, installNetworkGuard } from ${JSON.stringify(new URL('./verify-real-business.mjs', import.meta.url).href)};
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; if (fetches === 2) throw new Error('SECRET_PROVIDER_ERROR'); return new Response('{}'); };
    const budget = new CallBudget(3, Date.now() + 5000);
    const signal = new AbortController().signal;
    const env = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:9095', GEMINI_MODEL_PET_CHAT: 'gemini-2.5-flash', GEMINI_MODEL_EVAL_JUDGE: 'gemini-2.5-pro' };
    installNetworkGuard(env, budget, signal);
    const core = { createGemini(purpose, config) {
      assert.deepEqual(config, { projectId: '${PROJECT}', location: '${REGION}' });
      const model = purpose === 'evalJudge' ? env.GEMINI_MODEL_EVAL_JUDGE : env.GEMINI_MODEL_PET_CHAT;
      return { async *generateContentAsync() {
        await fetch('https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/' + model + ':generateContent', { method: 'POST' });
        yield {};
      } };
    } };
    const pet = boundedModel(core, 'petChat', budget, signal);
    const judge = boundedModel(core, 'evalJudge', budget, signal);
    const consume = async model => { for await (const _ of model.generateContentAsync({ contents: [] }, false)) {} };
    await consume(pet); // name extraction
    await assert.rejects(consume(pet), /SECRET_PROVIDER_ERROR/); // summary still consumes its attempt
    await consume(judge);
    assert.equal(budget.modelCalls, 3); assert.equal(budget.transportCalls, 3);
    await assert.rejects(consume(judge), { code: 'call_budget' });
    assert.equal(fetches, 3);
  `,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});
