import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REGION, ROOT, importLocal } from './eval-common.mjs';

const config = await importLocal('packages/config/dist/index.js');
const core = await importLocal('packages/agent-core/dist/index.js');
const { abortable } = await importLocal('packages/agent-core/dist/abortable.js');

export function judgeModelId(env) {
  return config.resolveModelId('evalJudge', env);
}

export function validateJudge(value, schema) {
  // checkSchema drops unknown fields; reject them before that sanitization.
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))
  )
    throw new Error('judge_schema');
  const checked = core.checkSchema(schema, value);
  if (!checked.ok) throw new Error('judge_schema');
  return checked.value;
}

export async function createGeminiJudge(kb, env, { model, timeoutMs } = {}) {
  const modelId = judgeModelId(env);
  const schema = JSON.parse(await kb.text('schemas/eval_judge.json'));
  const prompt = await kb.text('prompts/eval_judge.md');
  const charter = await kb.text('prompts/charter.md');
  const grades = Object.fromEntries(
    await Promise.all(
      ['low', 'high', 'jhs'].map(async (band) => [band, await kb.text(`prompts/grade/${band}.md`)]),
    ),
  );
  core.disableAdkContentCapture();
  const require = createRequire(join(ROOT, 'packages/agent-core/package.json'));
  const adk = await import(pathToFileURL(require.resolve('@google/adk')).href);
  adk.setLogger(null);
  const llm =
    model ?? core.createGemini('evalJudge', { projectId: env.GCP_PROJECT_ID, location: REGION });
  const route = config.models.evalJudge;
  const deadline = Math.min(timeoutMs ?? route.timeoutMs, route.timeoutMs);

  return async (scenario, turns) => {
    if (scenario.source !== 'synthetic') throw new Error('synthetic_required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      const request = {
        model: modelId,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: JSON.stringify({
                  id: scenario.id,
                  gradeBand: scenario.grade_band,
                  localTime: scenario.local_time ?? '19:00',
                  mustNot: scenario.must_not,
                  realNames: scenario.real_names ?? [],
                  turns: turns.map((turn, index) => ({
                    child: scenario.turns[index],
                    pet: turn.replyText,
                    toolCalls: turn.toolCalls,
                  })),
                }),
              },
            ],
          },
        ],
        config: {
          systemInstruction: `${prompt}\n\n${charter}\n\n${grades[scenario.grade_band]}`,
          temperature: route.temperature,
          responseMimeType: 'application/json',
          responseSchema: core.toGenaiSchema(schema),
          maxOutputTokens: route.maxOutputTokens,
          httpOptions: { timeout: deadline, retryOptions: { attempts: 1 } },
        },
      };
      let text;
      // One non-streaming call per scenario; bound the consumer even if SDK abort lags.
      for await (const response of abortable(
        llm.generateContentAsync(request, false, controller.signal),
        controller.signal,
      )) {
        if (
          response.errorCode ||
          response.errorMessage ||
          response.partial ||
          response.content?.role !== 'model' ||
          text !== undefined ||
          response.content.parts?.some((part) => part.functionCall)
        )
          throw new Error('judge_error');
        text = (response.content.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('');
      }
      if (controller.signal.aborted) throw new Error('judge_timeout');
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error('judge_invalid_json');
      }
      return validateJudge(value, schema);
    } catch {
      // Provider errors can echo prompts, replies, or credentials.
      throw new Error('judge_failed');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
