import { FunctionTool } from '@google/adk';
import {
  EXPRESSIONS,
  MOOD_WEATHERS,
  PET_REQUEST_TYPES,
  type CharacterId,
  type CrisisReason,
  type GameType,
  type GradeBand,
  type PetAction,
} from '@ijime/api-types';
import { agent as agentConfig } from '@ijime/config';
import { z } from 'zod';

import type { OutputFilter } from './output-filter.js';

export const MEMORY_CATEGORIES = ['like', 'event', 'person', 'other'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const CRISIS_REASONS = [
  'self_harm',
  'suicidal',
  'violence',
  'extortion',
] as const satisfies readonly CrisisReason[];

export type TurnContext = {
  childId: string;
  sessionId: string;
  gradeBand: GradeBand;
  characterId: CharacterId;
  operationId?: string;
};

export type ChildContext = {
  gradeBand: GradeBand;
  characterId: CharacterId;
  localTime: string;
  dayType: 'school_day' | 'day_off';
  recentTrend: string;
  pendingConsultationId?: string;
  followUpAt?: string;
  careFlag: boolean;
};

export interface PetToolExecutor {
  getChildContext(ctx: TurnContext): Promise<ChildContext>;
  searchSkill(ctx: TurnContext, query: string): Promise<string[]>;
  recordMood(ctx: TurnContext, weather: (typeof MOOD_WEATHERS)[number]): Promise<void>;
  remember(
    ctx: TurnContext,
    content: string,
    category: MemoryCategory,
  ): Promise<{ proposalId: string; status: 'pending' } | { memoryId: string }>;
  recall(ctx: TurnContext, topic: string): Promise<string[]>;
  suggestGame(ctx: TurnContext, game: GameType): Promise<boolean | { requestId: string }>;
  startTellAdult(ctx: TurnContext, reason?: string): Promise<{ consultationId: string }>;
  escalateCrisis(ctx: TurnContext, reason: CrisisReason): Promise<{ crisisId: string }>;
}

export type ActionSink = (action: PetAction) => void;

export const petToolSchemas = {
  get_child_context: z.object({}),
  search_skill: z.object({
    query: z.string().min(1).max(200).describe('子どもの状況を短く表した検索語（日本語）'),
  }),
  record_mood: z.object({ weather: z.enum(MOOD_WEATHERS).describe('今日の心の天気') }),
  remember: z.object({
    content: z.string().min(1).max(200).describe('覚えておくこと。同級生の本名は含めない'),
    category: z.enum(MEMORY_CATEGORIES),
  }),
  recall: z.object({ topic: z.string().min(1).max(100).describe('思い出したい話題') }),
  set_expression: z.object({ expression: z.enum(EXPRESSIONS) }),
  offer_quick_replies: z.object({
    options: z
      .array(z.string().min(1).max(30))
      .min(agentConfig.quickReplyOptions.min)
      .max(agentConfig.quickReplyOptions.max)
      .describe('子どもが選びやすい返事の候補'),
  }),
  show_help_resources: z.object({}),
  suggest_game: z.object({ type: z.enum(PET_REQUEST_TYPES) }),
  start_tell_adult: z.object({ reason: z.string().max(200).optional() }),
  escalate_crisis: z.object({ reason: z.enum(CRISIS_REASONS) }),
} as const;

export type PetToolName = keyof typeof petToolSchemas;
export const PET_TOOL_NAMES = Object.keys(petToolSchemas) as PetToolName[];

export const petToolDescriptions: Record<PetToolName, string> = {
  get_child_context:
    '学年、キャラクター、最近の様子の要約、返事を待っている相談を読む。会話の原文は含まない。',
  search_skill:
    'つらい出来事を聞いたとき、知識ベースから接し方の指針を最大3件取り出す。相談窓口を表示するツールではない。子どもが相談先の表示も求めたら、返答文の前に show_help_resources も呼ぶ。',
  record_mood: '子どもが会話の中で自分の気分を言ったとき、心の天気として記録する。',
  remember:
    '子どもが覚えてほしいことの候補を作る。確認ボタンで同意するまで記憶しない。本名は含めず「おともだちA」などの仮名にする。',
  recall: '話題に関係する、子どもが覚えていてほしいと言ったことを最大5件思い出す。',
  set_expression: '毎回1回、ペットの表情を選ぶ。',
  offer_quick_replies: '小学校低学年には毎回、答えやすい選択肢を2〜3個出す。',
  show_help_resources:
    '相談窓口を画面に表示する。子どもが「誰に相談できる？」「相談窓口・連絡先を見せて」など相談先の案内や表示を求めたら、返答文を出す前に必ず呼ぶ。説明文だけでは画面に表示されない。接し方の指針も求められたら search_skill と同じターンで両方を呼ぶ。相談先の表示は大人への通知・送信ではなく、追加の同意確認は不要。気持ちがとても沈んでいるときにも使える。',
  suggest_game:
    'タイミングが合うとき、ペットからのお願いを一つ出す。drawing は絵をかいて島の家にかざってもらう、story は島の物語のつづき、pet_worry はペットのなやみに答えてもらう。',
  start_tell_adult: '子どもが「大人に話したい」と言ったとき、大人に伝えるかどうかの相談を始める。',
  escalate_crisis:
    '現実の危険をすぐに知らせる。suicidal は「しにたい」「消えたい」など現在の希死念慮、self_harm は現実の自傷やそのおそれ、violence は現在続いている・差し迫った身体的暴力やその脅迫（家庭内を含む）、extortion は脅しや強制でお金・物を要求される／とられること。' +
    '仲間外れ・無視・口げんかだけを violence と扱わない。それだけなら search_skill や show_help_resources で支える。ただし自傷・希死念慮・身体的な危険・恐喝もあれば、該当する理由ですぐに呼ぶ。' +
    '創作や引用だけでは呼ばないが、本人の現在の危険が一緒に語られていれば見落とさない。現実の危険が疑われるときは安全側に扱い、詳しい証明や同意を待たない。',
};

// onToolError：指定すると、ツールの例外をモデルに渡す結果に変換する（runLive ではツールが例外を投げるとセッション全体が終了する）
export function createPetTools(
  executor: PetToolExecutor,
  ctx: TurnContext,
  onAction: ActionSink,
  onToolError?: (name: PetToolName, err: unknown) => unknown,
  options: { filter?: OutputFilter; maxToolCalls?: number; turnId?: () => string } = {},
): FunctionTool<(typeof petToolSchemas)[PetToolName]>[] {
  const counts = new Map<string, number>();
  const tool = <N extends PetToolName>(
    name: N,
    execute: (input: z.infer<(typeof petToolSchemas)[N]>) => Promise<unknown>,
  ) =>
    new FunctionTool({
      name,
      description: petToolDescriptions[name],
      parameters: petToolSchemas[name].strict(),
      execute: async (input: unknown, toolContext) => {
        if (toolContext?.abortSignal?.aborted) return { error: 'turn_cancelled' };
        const parsed = petToolSchemas[name].strict().safeParse(input);
        if (!parsed.success) return { error: 'invalid_arguments' };
        // Live agents live across turns; the invocation scopes the execution budget.
        const invocation =
          options.turnId?.() ?? toolContext?.invocationId ?? ctx.operationId ?? 'turn';
        const count = counts.get(invocation) ?? 0;
        if (!SAFETY_TOOLS.has(name)) {
          if (count >= (options.maxToolCalls ?? agentConfig.maxToolCallsPerTurn))
            return { error: 'tool_budget_exhausted' };
          counts.clear();
          counts.set(invocation, count + 1);
        }
        try {
          if (
            name === 'offer_quick_replies' &&
            options.filter &&
            !petToolSchemas.offer_quick_replies
              .parse(input)
              .options.every((text) => options.filter!.check(text).ok)
          )
            return { error: 'output_blocked' };
          if (
            name === 'remember' &&
            options.filter &&
            !options.filter.check(petToolSchemas.remember.parse(input).content).ok
          )
            return { error: 'output_blocked' };
          return await execute(parsed.data as z.infer<(typeof petToolSchemas)[N]>);
        } catch (err) {
          if (onToolError) return onToolError(name, err);
          throw err;
        }
      },
    });

  return [
    tool('get_child_context', () => executor.getChildContext(ctx)),
    tool('search_skill', async ({ query }) => ({
      passages: (await executor.searchSkill(ctx, query)).slice(
        0,
        agentConfig.searchSkillMaxPassages,
      ),
    })),
    tool('record_mood', async ({ weather }) => {
      await executor.recordMood(ctx, weather);
      return { ok: true };
    }),
    tool('remember', async ({ content, category }) => {
      const result = await executor.remember(ctx, content, category);
      if ('proposalId' in result)
        onAction({
          type: 'memory_proposal',
          proposalId: result.proposalId,
          text: content,
          category,
        });
      return result;
    }),
    tool('recall', async ({ topic }) => ({
      memories: (await executor.recall(ctx, topic)).slice(0, agentConfig.recallMaxMemories),
    })),
    tool('set_expression', async ({ expression }) => {
      onAction({ type: 'set_expression', expression });
      return { ok: true };
    }),
    tool('offer_quick_replies', async ({ options }) => {
      onAction({ type: 'quick_replies', options });
      return { ok: true };
    }),
    tool('show_help_resources', async () => {
      onAction({ type: 'show_help_resources' });
      return { ok: true };
    }),
    tool('suggest_game', async ({ type }) => {
      const reserved = await executor.suggestGame(ctx, type);
      if (!reserved) return { error: 'game_suggestion_limit' };
      if (typeof reserved === 'object') {
        onAction({ type: 'suggest_game', game: type, requestId: reserved.requestId });
        return { ok: true, requestId: reserved.requestId };
      }
      onAction({ type: 'suggest_game', game: type });
      return { ok: true };
    }),
    tool('start_tell_adult', async ({ reason }) => {
      const { consultationId } = await executor.startTellAdult(ctx, reason);
      onAction({ type: 'offer_tell_adult', consultationId });
      return { consultationId };
    }),
    tool('escalate_crisis', ({ reason }) => executor.escalateCrisis(ctx, reason)),
  ];
}

export const SAFETY_TOOLS = new Set<PetToolName>([
  'escalate_crisis',
  'show_help_resources',
  'start_tell_adult',
]);
