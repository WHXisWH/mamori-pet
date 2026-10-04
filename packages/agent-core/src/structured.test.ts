import type { LlmRequest } from '@google/adk';
import { describe, expect, it } from 'vitest';

import { createExtractorAgent } from './agent.js';
import { checkSchema, type JsonSchema } from './json-schema.js';
import { ScriptedLlm, type Script } from './scripted-llm.js';
import { runStructured } from './structured.js';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 5 },
    score: { type: 'number', minimum: 0, maximum: 1 },
    tags: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } },
    note: { type: 'string', nullable: true },
  },
  required: ['title', 'score'],
};

function agentWith(script: Script, delayMs?: number) {
  const llm = new ScriptedLlm(script, {
    model: 'scripted-extract',
    ...(delayMs ? { delayMs } : {}),
  });
  return {
    llm,
    agent: createExtractorAgent({
      name: 'extract_test',
      description: 't',
      model: llm,
      instruction: 'JSON だけを返す',
      outputSchema: schema as never,
      temperature: 0,
    }),
  };
}

describe('checkSchema', () => {
  it('accepts valid values and drops undeclared fields', () => {
    expect(checkSchema(schema, { title: 'abc', score: 0.5, extra: 'x' })).toEqual({
      ok: true,
      value: { title: 'abc', score: 0.5 },
    });
    expect(checkSchema(schema, { title: 'a', score: 1, note: null }).ok).toBe(true);
  });

  it('rejects out-of-range, too long, wrong enum, and missing required', () => {
    expect(checkSchema(schema, { title: 'abcdef', score: 0 })).toEqual({
      ok: false,
      path: '$.title',
    });
    expect(checkSchema(schema, { title: 'a', score: 2 })).toEqual({ ok: false, path: '$.score' });
    expect(checkSchema(schema, { title: 'a', score: 0, tags: ['c'] })).toEqual({
      ok: false,
      path: '$.tags[0]',
    });
    expect(checkSchema(schema, { score: 0 })).toEqual({ ok: false, path: '$.title' });
  });
});

describe('runStructured', () => {
  it('parses JSON (also inside a code fence) and validates it', async () => {
    const { agent, llm } = agentWith(() => ({ text: '```json\n{"title":"ok","score":0.2}\n```' }));
    const r = await runStructured(agent, 'input', { schema, timeoutMs: 2000 });
    expect(r).toEqual({ ok: true, value: { title: 'ok', score: 0.2 }, attempts: 1 });
    expect(llm.requests).toHaveLength(1);
  });

  it('retries once on schema failure then succeeds', async () => {
    const { agent, llm } = agentWith(({ turnIndex }) => ({
      text: turnIndex === 0 ? '{"title":"toolong!","score":0}' : '{"title":"ok","score":0}',
    }));
    const r = await runStructured(agent, 'input', { schema, timeoutMs: 2000, maxAttempts: 2 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(llm.requests).toHaveLength(2);
  });

  it('reports invalid JSON, business rejection, and timeouts', async () => {
    expect(
      await runStructured(agentWith(() => ({ text: 'not json' })).agent, 'i', {
        schema,
        timeoutMs: 2000,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_json' });
    expect(
      await runStructured(agentWith(() => ({ text: '{"title":"ng","score":0}' })).agent, 'i', {
        schema,
        timeoutMs: 2000,
        accept: (v: { title: string }) => v.title !== 'ng',
      }),
    ).toMatchObject({ ok: false, reason: 'schema', path: 'accept' });
    class SlowLlm extends ScriptedLlm {
      override async *generateContentAsync(req: LlmRequest, stream?: boolean) {
        await new Promise((r) => setTimeout(r, 500));
        yield* super.generateContentAsync(req, stream);
      }
    }
    const slowAgent = createExtractorAgent({
      name: 'extract_slow',
      description: 't',
      model: new SlowLlm(() => ({ text: '{"title":"ok","score":0}' }), { model: 'scripted-slow' }),
      instruction: 'JSON だけを返す',
      outputSchema: schema as never,
      temperature: 0,
    });
    expect(await runStructured(slowAgent, 'i', { schema, timeoutMs: 50 })).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });

  it('sends the input as the only user content', async () => {
    const { agent, llm } = agentWith(() => ({ text: '{"title":"ok","score":0}' }));
    await runStructured(agent, 'ひとこと', { schema, timeoutMs: 2000 });
    const users = llm.requests[0]!.contents.filter((c) => c.role === 'user');
    expect(users.map((c) => c.parts?.map((p) => p.text).join(''))).toEqual(['ひとこと']);
  });

  it('passes multimodal parts through unchanged', async () => {
    const { agent, llm } = agentWith(() => ({ text: '{"title":"ok","score":0}' }));
    const image = { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } };
    await runStructured(agent, [{ text: 'えの せつめい' }, image], { schema, timeoutMs: 2000 });
    const user = llm.requests[0]!.contents.find((c) => c.role === 'user')!;
    expect(user.parts).toEqual([{ text: 'えの せつめい' }, image]);
  });
});
