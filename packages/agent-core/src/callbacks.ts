import type { AfterModelCallback, BeforeModelCallback, BeforeToolCallback } from '@google/adk';

import { petToolSchemas, SAFETY_TOOLS } from './tools.js';
import type { OutputFilter } from './output-filter.js';
import { createGamePreferenceGuard, type GamePreferenceRules } from './game-preference.js';

export function createPetCallbacks(input: {
  filter: OutputFilter;
  safeReply: string;
  prepareMemory?: (content: string) => Promise<string>;
  inspectOutput?: (text: string) => Promise<boolean>;
  gamePreferenceRules?: GamePreferenceRules;
}): {
  beforeModelCallback?: BeforeModelCallback;
  beforeToolCallback: BeforeToolCallback;
  afterModelCallback: AfterModelCallback;
} {
  let invocation = '';
  let buffered = '';
  const gamePreference =
    input.gamePreferenceRules && createGamePreferenceGuard(input.gamePreferenceRules);
  const beforeToolCallback: BeforeToolCallback = async ({ tool, args, context }) => {
    const blocked = await gamePreference?.beforeToolCallback({ tool, args, context });
    if (blocked) return blocked;
    if (tool.name !== 'remember') return;
    const parsed = petToolSchemas.remember.strict().safeParse(args);
    if (!parsed.success) return { error: 'invalid_arguments' };
    if (!input.filter.check(parsed.data.content).ok) return { error: 'output_blocked' };
    if (input.prepareMemory) {
      try {
        args['content'] = await input.prepareMemory(parsed.data.content);
      } catch {
        return { error: 'memory_privacy_unavailable' };
      }
    }
    return undefined;
  };
  const afterModelCallback: AfterModelCallback = async ({ context, response }) => {
    if (context.invocationId !== invocation) {
      invocation = context.invocationId;
      buffered = '';
    }
    const parts = response.content?.parts ?? [];
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('');
    buffered = response.partial ? buffered + text : text || buffered;
    let allowed = input.filter.check(buffered).ok;
    if (allowed && input.inspectOutput) {
      // With remote inspection enabled no partial text can reach the stream or session store.
      if (response.partial) return { ...response, content: { role: 'model', parts: [] } };
      try {
        allowed = !buffered.trim() || (await input.inspectOutput(buffered));
      } catch {
        allowed = false;
      }
    }
    if (allowed) {
      const complete = buffered;
      if (!response.partial) buffered = '';
      if (input.inspectOutput && !text && complete)
        return { ...response, content: { role: 'model', parts: [...parts, { text: complete }] } };
      return;
    }
    buffered = '';
    // An unsafe sentence must not suppress a simultaneous safety-tool call.
    const safety = parts.filter((part) => SAFETY_TOOLS.has(part.functionCall?.name as never));
    if (safety.length > 0)
      return {
        ...response,
        partial: false,
        content: { role: 'model', parts: [...safety, { text: input.safeReply }] },
      };
    return { errorCode: 'OUTPUT_BLOCKED', errorMessage: 'output_blocked', partial: false };
  };
  return {
    beforeToolCallback,
    afterModelCallback,
    ...(gamePreference ? { beforeModelCallback: gamePreference.beforeModelCallback } : {}),
  };
}
