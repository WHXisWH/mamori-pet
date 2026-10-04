import type { BaseLlm } from '@google/adk';
import {
  createExtractorAgent,
  runStructured,
  toGenaiSchema,
  type JsonSchema,
  type StructuredResult,
} from '@ijime/agent-core';
import type { GradeBand } from '@ijime/api-types';
import { models } from '@ijime/config';
import type { Kb, SignalDefinition } from '@ijime/kb-loader';

import type { ArtworkFeatures, ExtractOutput, IslandStory } from './rules.js';

export const SIGNAL_PROMPT = 'prompts/signal_extract.md';
export const SIGNAL_SCHEMA = 'schemas/signal_extract.json';

export function extractorVersion(kb: Kb, model: string | BaseLlm): string {
  return `${typeof model === 'string' ? model : model.model}/${SIGNAL_PROMPT}@${kb.version}`;
}

export function buildInstruction(
  template: string,
  band: GradeBand,
  defs: readonly SignalDefinition[],
): string {
  const list = defs.map((d) => ({
    signalDefId: d.signal_id,
    description: d.description,
    examples: d.examples_ja,
  }));
  return template.replace('{gradeBand}', band).replace('{signalDefinitions}', JSON.stringify(list));
}

export function buildInput(
  latest: string,
  prior: readonly { role: 'child' | 'pet' | 'system'; text: string }[],
): string {
  return JSON.stringify({
    current: { role: 'child', turnIndex: 0, text: latest },
    prior: prior.map((p, turnIndex) => ({ role: p.role, turnIndex, text: p.text })),
  });
}

export async function extractSignals(input: {
  kb: Kb;
  model: string | BaseLlm;
  band: GradeBand;
  defs: readonly SignalDefinition[];
  text: string;
}): Promise<StructuredResult<ExtractOutput>> {
  const schema = JSON.parse(await input.kb.text(SIGNAL_SCHEMA)) as JsonSchema;
  const instruction = buildInstruction(await input.kb.text(SIGNAL_PROMPT), input.band, input.defs);
  const agent = createExtractorAgent({
    name: 'signal_extractor',
    description: '会話からサインを取り出す',
    model: input.model,
    // 関数形式の instruction には ADK の {state} 注入がかからないため、定義内の JSON の波かっこはそのまま残る
    instruction: () => instruction,
    outputSchema: toGenaiSchema(schema),
    temperature: models.signalExtract.temperature ?? 0,
  });
  return runStructured<ExtractOutput>(agent, input.text, {
    schema,
    timeoutMs: models.signalExtract.timeoutMs ?? 20000,
  });
}

export const ARTWORK_PROMPT = 'prompts/artwork_feature.md';
export const ARTWORK_SCHEMA = 'schemas/artwork_feature.json';
export const ISLAND_PROMPT = 'prompts/island_narrative.md';
export const ISLAND_SCHEMA = 'schemas/island_narrative.json';

export function artworkFeatureVersion(kb: Kb, prompt: string, model: string | BaseLlm): string {
  return `${typeof model === 'string' ? model : model.model}/${prompt}@${kb.version}`;
}

// 作品特徴の失敗はデッドレターまでリトライしない：リトライ後に諦め、その作品は採点しない（docs/02-agent-architecture.md）
const ARTWORK_ATTEMPTS = 2;

async function loadPrompt(kb: Kb, prompt: string, schemaPath: string) {
  return {
    schema: JSON.parse(await kb.text(schemaPath)) as JsonSchema,
    template: await kb.text(prompt),
  };
}

export async function extractArtworkFeatures(input: {
  kb: Kb;
  model: string | BaseLlm;
  type: 'self_portrait' | 'story';
  narrative: string;
  image: { mimeType: string; data: string };
}): Promise<StructuredResult<ArtworkFeatures>> {
  const { schema, template } = await loadPrompt(input.kb, ARTWORK_PROMPT, ARTWORK_SCHEMA);
  const instruction = template
    .replace('{type}', input.type)
    .replace('{narrative}', '（ユーザーメッセージの「説明」）');
  const agent = createExtractorAgent({
    name: 'artwork_feature_extractor',
    description: '絵から決められた特徴を取り出す',
    model: input.model,
    instruction: () => instruction,
    outputSchema: toGenaiSchema(schema),
    temperature: models.artworkFeature.temperature ?? 0,
  });
  return runStructured<ArtworkFeatures>(
    agent,
    [{ text: `説明：${input.narrative || '（なし）'}` }, { inlineData: input.image }],
    {
      schema,
      timeoutMs: models.artworkFeature.timeoutMs ?? 30000,
      maxAttempts: ARTWORK_ATTEMPTS,
    },
  );
}

export async function extractIslandStory(input: {
  kb: Kb;
  model: string | BaseLlm;
  narrative: string;
}): Promise<StructuredResult<IslandStory>> {
  const { schema, template } = await loadPrompt(input.kb, ISLAND_PROMPT, ISLAND_SCHEMA);
  const agent = createExtractorAgent({
    name: 'island_story_extractor',
    description: '島の説明から物語の終わり方を取り出す',
    model: input.model,
    instruction: () => template,
    outputSchema: toGenaiSchema(schema),
    temperature: models.artworkFeature.temperature ?? 0,
  });
  return runStructured<IslandStory>(agent, input.narrative, {
    schema,
    timeoutMs: models.artworkFeature.timeoutMs ?? 30000,
    maxAttempts: ARTWORK_ATTEMPTS,
  });
}
