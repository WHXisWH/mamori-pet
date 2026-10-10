import type { BaseLlm } from '@google/adk';
import {
  createExtractorAgent,
  createGemini,
  disableAdkContentCapture,
  runStructured,
  toGenaiSchema,
  type JsonSchema,
} from '@ijime/agent-core';
import { crisis as config, models, REGION } from '@ijime/config';
import { lexiconSchema, type Kb } from '@ijime/kb-loader';

import {
  CrisisDetector,
  type CrisisInput,
  ModelCallError,
  type CrisisDetectorOptions,
  type CrisisReviewer,
  type ReviewResult,
  type SemanticScreener,
} from './detector.js';
import { KeywordMatcher } from './keyword.js';
import { createNoModelDetector } from './no-model.js';

type ModelOptions = { kb: Kb; screenModel: BaseLlm; reviewModel: BaseLlm };

async function classify<T>(
  options: ModelOptions,
  kind: 'screen' | 'review',
  input: CrisisInput,
  signal: AbortSignal,
): Promise<T> {
  const purpose = kind === 'screen' ? 'crisisScreen' : 'crisisReview';
  const schema = JSON.parse(await options.kb.text(`schemas/crisis_${kind}.json`)) as JsonSchema;
  const prompt = (await options.kb.text(`prompts/crisis_${kind}.md`)).replaceAll(
    '{gradeBand}',
    input.gradeBand,
  );
  const agent = createExtractorAgent({
    name: `crisis_${kind}`,
    description: 'Safety classification only; no tools or user-facing advice',
    model: kind === 'screen' ? options.screenModel : options.reviewModel,
    instruction: () => prompt,
    outputSchema: toGenaiSchema(schema),
    temperature: 0,
  });
  const result = await runStructured<T>(
    agent,
    JSON.stringify({
      latest: input.text,
      priorTurns: input.priorTurns.slice(-config.reviewContextTurns),
    }),
    { schema, signal, timeoutMs: models[purpose].timeoutMs ?? 1500, maxAttempts: 1 },
  );
  if (!result.ok)
    throw new ModelCallError(
      result.reason === 'quota' ? 'quota' : result.reason === 'timeout' ? 'timeout' : 'error',
      result.reason === 'quota' || result.reason === 'timeout' ? undefined : result.reason,
    );
  return result.value;
}

export function createModelDetector(
  options: ModelOptions,
  keywords: KeywordMatcher,
  detectorOptions: CrisisDetectorOptions = {},
): CrisisDetector {
  const screener: SemanticScreener = {
    screen: (input, signal) => classify<{ suspect: boolean }>(options, 'screen', input, signal),
  };
  const reviewer: CrisisReviewer = {
    review: async (input, signal) => {
      const value = await classify<ReviewResult>(options, 'review', input, signal);
      if (value.hit === (value.category === 'none'))
        throw new ModelCallError('error', 'inconsistent_verdict');
      if (
        value.hit &&
        (!value.evidenceSpan ||
          ![input.text, ...input.priorTurns].some((t) => t.includes(value.evidenceSpan!)))
      ) {
        throw new ModelCallError('error', 'invalid_evidence');
      }
      return value;
    },
  };
  return new CrisisDetector(keywords, screener, reviewer, detectorOptions);
}

export async function createRuntimeDetector(
  kb: Kb,
  env: NodeJS.ProcessEnv = process.env,
  detectorOptions: CrisisDetectorOptions = {},
): Promise<CrisisDetector> {
  const lexicon = await kb.yaml('lexicon/ja.yaml', lexiconSchema);
  const mode =
    env['CRISIS_MODEL_MODE'] ?? (env['NODE_ENV'] === 'production' ? 'vertex' : 'scripted');
  if (mode === 'scripted' && env['NODE_ENV'] !== 'production')
    return createNoModelDetector(lexicon, detectorOptions);
  if (mode !== 'vertex') throw new Error('CRISIS_MODEL_MODE must be vertex in production');
  const projectId = env['GCP_PROJECT_ID'];
  const location = env['GCP_REGION'] ?? REGION;
  if (!projectId || projectId.startsWith('demo-'))
    throw new Error('Vertex safety requires a real GCP_PROJECT_ID');
  if (location !== REGION) throw new Error(`Safety models must use ${REGION}`);
  disableAdkContentCapture();
  return createModelDetector(
    {
      kb,
      screenModel: createGemini('crisisScreen', { projectId, location }),
      reviewModel: createGemini('crisisReview', { projectId, location }),
    },
    KeywordMatcher.fromLexicon(lexicon),
    detectorOptions,
  );
}
