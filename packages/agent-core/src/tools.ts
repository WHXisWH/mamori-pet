import { FunctionTool } from '@google/adk';
import {
  CRISIS_HIT_CATEGORIES,
  EXPRESSIONS,
  MOOD_WEATHERS,
  PET_REQUEST_TYPES,
  type CharacterId,
  type ConsultChoice,
  type CrisisHitCategory,
  type GameType,
  type GradeBand,
  type PetAction,
} from '@ijime/api-types';
import { agent as agentConfig } from '@ijime/config';
import { QUICK_REPLY_INTENTS, type QuickReplyCatalog } from '@ijime/kb-loader';
import { z } from 'zod';

import type { OutputFilter } from './output-filter.js';

export const MEMORY_CATEGORIES = ['like', 'event', 'person', 'other'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

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
  helpAttempt?: {
    choice?: ConsultChoice;
    state: 'unknown' | 'talked' | 'later' | 'needs_help' | 'supported' | 'paused';
    followUp: 'unscheduled' | 'scheduled' | 'due' | 'stopped';
  };
  careFlag: boolean;
};

export interface PetToolExecutor {
  prepareMemory?(ctx: TurnContext, content: string): Promise<string>;
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
  startTellAdult(
    ctx: TurnContext,
    reason?: string,
  ): Promise<{ consultationId: string; openingLine?: string }>;
  escalateCrisis(ctx: TurnContext, category: CrisisHitCategory): Promise<{ crisisId: string }>;
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
    trigger: z
      .object({
        kind: z.enum(['requested', 'hesitating']),
        evidenceSpan: z.string().trim().min(1).max(200),
      })
      .optional()
      .describe(
        '高学年・中学生では必須。requested=本人が候補を求めた、hesitating=本人が返答に迷うと伝えた。evidenceSpanは最新の本人の発言からその根拠を一箇所そのまま引用する。「聞いていて」「話したくない」や寂しさだけは迷いではない。',
      ),
    intents: z
      .array(z.enum(QUICK_REPLY_INTENTS))
      .min(agentConfig.quickReplyOptions.min)
      .max(agentConfig.quickReplyOptions.max)
      .refine((intents) => new Set(intents).size === intents.length, 'choose distinct intents')
      .refine((intents) => intents.includes('pause'), 'include pause as an exit choice')
      .describe(
        '子どもの発言の意図を重複なく2〜3個選ぶ。continue_topic=今の話の続きを話したい、listen_only=助言せず聞いていてほしい、practice_telling=大人への伝え方を練習したい、change_topic=別の話をしたい、unsure=まだわからない、pause=今は終わりたい。pauseを必ず含める。本人がまだ言っていない体調・感情・被害は追加できない。表示文は学年別の文案から返る。',
      ),
  }),
  show_help_resources: z.object({}),
  suggest_game: z.object({ type: z.enum(PET_REQUEST_TYPES) }),
  start_tell_adult: z.object({ reason: z.string().max(200).optional() }),
  escalate_crisis: z.object({ category: z.enum(CRISIS_HIT_CATEGORIES) }),
} as const;

export type PetToolName = keyof typeof petToolSchemas;
export const PET_TOOL_NAMES = Object.keys(petToolSchemas) as PetToolName[];

export const petToolDescriptions: Record<PetToolName, string> = {
  get_child_context:
    '学年、キャラクター、最近の様子の要約、返事を待っている相談、子ども自身の助けを求める試みの状態を読む。会話の原文や保護者の回答は含まない。未回答は結果不明、転送の選択や「話した」は解決を意味しない。supported / paused はその試みへの自発的な問いかけを止める状態で、新しい話題や子どもからの相談を止めるものではない。',
  search_skill:
    'つらい出来事を聞いたとき、知識ベースから接し方の指針を最大3件取り出す。相談窓口を表示するツールではない。子どもが相談先の表示も求めたら、返答文の前に show_help_resources も呼ぶ。',
  record_mood: '子どもが会話の中で自分の気分を言ったとき、心の天気として記録する。',
  remember:
    '子どもが覚えてほしいことの候補を作る。確認ボタンで同意するまで記憶しない。本名は含めず「おともだちA」などの仮名にする。',
  recall: '話題に関係する、子どもが覚えていてほしいと言ったことを最大5件思い出す。',
  set_expression: '毎回1回、ペットの表情を選ぶ。',
  offer_quick_replies:
    '子どもの発言としてそのまま送信する選択肢を出す。意図だけを選び、自由な文案は作らない。今の希望に合う意図とpauseを選ぶ。大人への相談を望んでいない時はpractice_tellingで誘導しない。低学年には終了時を除いて毎回、高学年・中学生には本人が選択肢を求めた時や返答に迷っている時だけ使う。「聞いていて」「詳しく話したくない」だけを理由に高学年・中学生へ出さない。ツールが返すoptionsが実際の表示文。本文で候補や確認の質問を繰り返さない。',
  show_help_resources:
    '相談窓口を画面に表示する。子どもが「誰に相談できる？」「相談窓口・連絡先を見せて」など相談先の案内や表示を求めたら、返答文を出す前に必ず呼ぶ。説明文だけでは画面に表示されない。接し方の指針も求められたら search_skill と同じターンで両方を呼ぶ。相談先の表示は大人への通知・送信ではなく、追加の同意確認は不要。気持ちがとても沈んでいるときにも使える。',
  suggest_game:
    '子どもの気持ちが落ち着き、相談や大人への伝え方の話の途中ではないときだけ、ペットからのお願いを一つ出す。つらさを話している途中に遊びでそらさない。drawing は絵をかいて島の家にかざってもらう、story は島の物語のつづき、pet_worry はペットのなやみに答えてもらう。',
  start_tell_adult:
    '子どもが親や先生などへの相談、伝える手伝い、言い方の練習を自分から求めたら、返答文を出す前に必ず呼ぶ。ペット自身が出した「練習する」などの候補を子どもが選んだ場合も、今の依頼として呼んでから練習を続ける。助言の文章だけでは入口は表示されない。以前に入口を出した、断った、回訪が paused / stopped になった場合も、今の自発的な求めには再び呼ぶ。選択画面を用意するだけで通知や共有はしないため、呼ぶための追加の同意は不要。聞いてほしいだけ、話題を変えたいだけのときは使わない。',
  escalate_crisis:
    '現実の危険をすぐに知らせる。category は self_harm（「しにたい」「消えたい」など現在の希死念慮、現実の自傷やそのおそれ）、violence（家族以外からの、現在続いている・差し迫った身体的暴力やその脅迫）、extortion（家族以外から脅しや強制でお金・物を要求される／とられること）、family_harm（親や同居する家族からの暴力・虐待・脅し。ほかの危険が一緒でも加害者が家族ならこれ）、other（危険だがどれか決められない）から選ぶ。迷ったら other。' +
    '仲間外れ・無視・口げんかだけを violence と扱わない。それだけなら search_skill や show_help_resources で支える。ただし自傷・希死念慮・身体的な危険・恐喝もあれば、該当する理由ですぐに呼ぶ。' +
    '創作や引用だけでは呼ばないが、本人の現在の危険が一緒に語られていれば見落とさない。現実の危険が疑われるときは安全側に扱い、詳しい証明や同意を待たない。',
};

function declaredSchema(name: PetToolName) {
  return new FunctionTool({
    name,
    description: petToolDescriptions[name],
    parameters: petToolSchemas[name].strict(),
    execute: async () => undefined,
  })._getDeclaration().parameters;
}

// onToolError：指定すると、ツールの例外をモデルに渡す結果に変換する（runLive ではツールが例外を投げるとセッション全体が終了する）
export function createPetTools(
  executor: PetToolExecutor,
  ctx: TurnContext,
  onAction: ActionSink,
  onToolError?: (name: PetToolName, err: unknown) => unknown,
  options: {
    filter?: OutputFilter;
    quickReplyCatalog?: QuickReplyCatalog;
    currentUserText?: string;
    maxToolCalls?: number;
    turnId?: () => string;
  } = {},
): FunctionTool<(typeof petToolSchemas)[PetToolName]>[] {
  const counts = new Map<string, number>();
  const tool = <N extends PetToolName>(
    name: N,
    execute: (input: z.infer<(typeof petToolSchemas)[N]>) => Promise<unknown>,
  ) =>
    new FunctionTool({
      name,
      description: petToolDescriptions[name],
      // ADK は先に zod で引数を検証し、失敗すると例外を投げる。危機の通報は schema を宣言するだけにして、下で自前で検証する
      parameters: (name === 'escalate_crisis'
        ? declaredSchema(name)
        : petToolSchemas[name].strict()) as (typeof petToolSchemas)[N],
      execute: async (input: unknown, toolContext) => {
        if (toolContext?.abortSignal?.aborted) return { error: 'turn_cancelled' };
        let parsed = petToolSchemas[name].strict().safeParse(input);
        // 危機の通報を引数の不正で取りこぼしてはならない。カテゴリが不明なら other として通報する
        if (!parsed.success && name === 'escalate_crisis')
          parsed = petToolSchemas[name].strict().safeParse({ category: 'other' });
        if (!parsed.success) return { error: 'invalid_arguments' };
        if (name === 'offer_quick_replies' && ctx.gradeBand !== 'low') {
          const { trigger } = petToolSchemas.offer_quick_replies.parse(parsed.data);
          const userText =
            options.currentUserText ??
            (toolContext?.userContent?.role === 'user'
              ? (toolContext.userContent.parts ?? []).map((part) => part.text ?? '').join('')
              : '');
          if (!trigger || !userText.includes(trigger.evidenceSpan))
            return { error: 'quick_reply_trigger_required' };
        }
        // Live agents live across turns; the invocation scopes the execution budget.
        const invocation =
          options.turnId?.() ?? toolContext?.invocationId ?? ctx.operationId ?? 'turn';
        const count = counts.get(invocation) ?? 0;
        if (BUDGETED_TOOLS.has(name)) {
          if (count >= (options.maxToolCalls ?? agentConfig.maxToolCallsPerTurn))
            return { error: 'tool_budget_exhausted' };
          counts.clear();
          counts.set(invocation, count + 1);
        }
        try {
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
      let sanitized = content;
      if (executor.prepareMemory) {
        // 人名の認識に失敗したら保存しない。モデルには原文を含まないエラーを返す
        try {
          sanitized = await executor.prepareMemory(ctx, content);
        } catch {
          return { error: 'memory_privacy_unavailable' };
        }
      }
      const result = await executor.remember(ctx, sanitized, category);
      if ('proposalId' in result)
        onAction({
          type: 'memory_proposal',
          proposalId: result.proposalId,
          text: sanitized,
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
    tool('offer_quick_replies', async ({ intents }) => {
      const catalog = options.quickReplyCatalog?.[ctx.gradeBand];
      if (!catalog) return { error: 'quick_replies_unavailable' };
      const labels = intents.map((intent) => catalog[intent]);
      if (options.filter && !labels.every((label) => options.filter!.check(label).ok))
        return { error: 'output_blocked' };
      onAction({ type: 'quick_replies', options: labels });
      return { ok: true, options: labels };
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
      const { consultationId, openingLine } = await executor.startTellAdult(ctx, reason);
      const opening = openingLine?.trim();
      const result = { consultationId, ...(opening ? { openingLine: opening } : {}) };
      onAction({ type: 'offer_tell_adult', ...result });
      return result;
    }),
    tool('escalate_crisis', ({ category }) => executor.escalateCrisis(ctx, category)),
  ];
}

export const SAFETY_TOOLS = new Set<PetToolName>([
  'escalate_crisis',
  'show_help_resources',
  'start_tell_adult',
]);

export const BUDGETED_TOOLS = new Set<PetToolName>([
  'get_child_context',
  'search_skill',
  'record_mood',
  'remember',
  'recall',
  'suggest_game',
]);
