import type { SingleBeforeModelCallback, SingleBeforeToolCallback } from '@google/adk';
import type { Part } from '@google/genai';
import type { Kb } from '@ijime/kb-loader';
import { z } from 'zod';

const schema = z.object({
  decline: z.array(z.string().min(1)).min(1),
  request: z.array(z.string().min(1)).min(1),
  change_topic: z.array(z.string().min(1)).min(1),
  blocked_instruction: z.string().min(1),
});

export type GamePreferenceRules = z.infer<typeof schema>;

export function loadGamePreferenceRules(kb: Kb): Promise<GamePreferenceRules> {
  return kb.yaml('templates/game_preference.ja.yaml', schema);
}

function matches(text: string, patterns: string[]): boolean {
  const clauses = text
    .normalize('NFKC')
    .split(/[。！？!?\n]/u)
    .map((clause) => clause.replace(/\s/gu, ''));
  return patterns.some((pattern) => {
    const regex = new RegExp(pattern, 'u');
    return clauses.some((clause) => regex.test(clause));
  });
}

export function gamePreferenceChange(
  text: string,
  rules: GamePreferenceRules,
): boolean | undefined {
  if (matches(text, rules.decline)) return true;
  if (matches(text, rules.request)) return false;
  return undefined;
}

export function createGamePreferenceGuard(rules: GamePreferenceRules): {
  beforeModelCallback: SingleBeforeModelCallback;
  beforeToolCallback: SingleBeforeToolCallback;
} {
  let blockReason: 'game_declined' | 'topic_change_is_not_game_consent' | undefined;
  return {
    beforeModelCallback: ({ context, request }) => {
      // Only the current safety-cleared child message can change this session's choice.
      // Model/tool text and historical summaries must never revoke a refusal.
      const text = (context.userContent?.parts ?? [])
        .filter((part) => !part.thought && !part.functionCall && !part.functionResponse)
        .map((part) => part.text ?? '')
        .join('');
      const declined =
        gamePreferenceChange(text, rules) ?? context.state.get('gameSuggestionsDeclined') === true;
      blockReason = declined
        ? 'game_declined'
        : matches(text, rules.change_topic)
          ? 'topic_change_is_not_game_consent'
          : undefined;
      if (blockReason) {
        const existing = request.config?.systemInstruction;
        const parts: Part[] =
          existing === undefined
            ? []
            : [existing]
                .flat()
                .flatMap((part) =>
                  typeof part === 'string'
                    ? [{ text: part }]
                    : 'parts' in part
                      ? (part.parts ?? [])
                      : [part as Part],
                );
        request.config = {
          ...request.config,
          systemInstruction: { parts: [...parts, { text: rules.blocked_instruction }] },
        };
      }
      return undefined;
    },
    beforeToolCallback: ({ tool }) => {
      if (tool.name === 'suggest_game' && blockReason)
        return { error: blockReason, instruction: rules.blocked_instruction };
      return undefined;
    },
  };
}
