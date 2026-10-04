import { GRADE_BANDS, STORY_OUTCOMES, type GradeBand } from '@ijime/api-types';
import { z } from 'zod';

import { KbIntegrityError, type Kb } from './kb.js';

// ペットの島：kb/games のお題・アイテム・季節。旧 schema（schemas.ts）は同じファイルの一部を引き続き読み取る

const id = z.string().regex(/^[a-z][a-z0-9_]*$/);
const gradeBands = z.array(z.enum(GRADE_BANDS)).min(1);

export const drawingRequestsSchema = z.object({
  items: z
    .array(
      z.object({
        id,
        grade_bands: gradeBands,
        text_ja: z.string().min(1),
        neutral: z.boolean(),
        reward_item: id,
      }),
    )
    .min(1),
});
export type DrawingRequest = z.infer<typeof drawingRequestsSchema>['items'][number];

export const PET_WORRY_OPTION_KINDS = ['tell_adult', 'talk', 'wait', 'other'] as const;
export type PetWorryOptionKind = (typeof PET_WORRY_OPTION_KINDS)[number];

export const petWorriesSchema = z.object({
  items: z
    .array(
      z.object({
        id,
        grade_bands: gradeBands,
        setup_ja: z.string().min(1),
        options: z
          .array(z.object({ id, text_ja: z.string().min(1), kind: z.enum(PET_WORRY_OPTION_KINDS) }))
          .min(2),
        reply_ja: z.string().min(1),
        reward_item: id,
      }),
    )
    .min(1),
});
export type PetWorry = z.infer<typeof petWorriesSchema>['items'][number];

export const storyRequestsSchema = z.object({
  prompts: z
    .array(
      z.object({
        id,
        grade_bands: gradeBands,
        text_ja: z.string().min(1),
        ending_options: z
          .array(z.object({ id, text_ja: z.string().min(1), outcome: z.enum(STORY_OUTCOMES) }))
          .min(2),
        reward_item: id,
      }),
    )
    .min(1),
});
export type StoryRequest = z.infer<typeof storyRequestsSchema>['prompts'][number];

export const ISLAND_SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type IslandSeason = (typeof ISLAND_SEASONS)[number];

export const islandUnlockSchema = z.union([
  z.literal('default'),
  z.literal('reward'),
  z.templateLiteral(['season:', z.enum(ISLAND_SEASONS)]),
]);
export type IslandUnlock = z.infer<typeof islandUnlockSchema>;

export const islandCatalogSchema = z.object({
  items: z
    .array(
      z.object({
        catalogId: id,
        category: z.string().min(1),
        label_ja: z.string().min(1),
        unlock: islandUnlockSchema,
        sprite: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      }),
    )
    .min(1),
});
export type IslandCatalogEntry = z.infer<typeof islandCatalogSchema>['items'][number];

export const seasonsSchema = z.object({
  seasons: z
    .array(
      z.object({
        id: z.enum(ISLAND_SEASONS),
        months: z.array(z.number().int().min(1).max(12)).min(1),
        label_ja: z.string().min(1),
      }),
    )
    .min(1),
});
export type Seasons = z.infer<typeof seasonsSchema>['seasons'];

const perGrade = z.object({ low: z.string(), high: z.string(), jhs: z.string() });
export const petRequestRepliesSchema = z.object({
  pet_request: z.object({
    drawing: perGrade,
    story: perGrade,
    tell_adult: perGrade,
    declined: perGrade,
  }),
});
export type PetRequestReplies = z.infer<typeof petRequestRepliesSchema>['pet_request'];

export const GAMES_PATHS = {
  drawing: 'games/drawing_requests.yaml',
  story: 'games/story_prompts.yaml',
  pet_worry: 'games/pet_worries.yaml',
  islandItems: 'games/island_items.yaml',
  seasons: 'games/seasons.yaml',
} as const;

export type GameCatalog = {
  drawing: DrawingRequest[];
  story: StoryRequest[];
  pet_worry: PetWorry[];
  islandItems: IslandCatalogEntry[];
  seasons: Seasons;
};

export type GamePrompt =
  | { type: 'drawing'; prompt: DrawingRequest }
  | { type: 'story'; prompt: StoryRequest }
  | { type: 'pet_worry'; prompt: PetWorry };

export async function loadGames(kb: Kb): Promise<GameCatalog> {
  const [drawing, story, petWorry, items, seasons] = await Promise.all([
    kb.yaml(GAMES_PATHS.drawing, drawingRequestsSchema),
    kb.yaml(GAMES_PATHS.story, storyRequestsSchema),
    kb.yaml(GAMES_PATHS.pet_worry, petWorriesSchema),
    kb.yaml(GAMES_PATHS.islandItems, islandCatalogSchema),
    kb.yaml(GAMES_PATHS.seasons, seasonsSchema),
  ]);
  const rewards = new Set(items.items.filter((i) => i.unlock === 'reward').map((i) => i.catalogId));
  const prompts = [
    ...drawing.items.map((p) => ({ path: GAMES_PATHS.drawing, p })),
    ...story.prompts.map((p) => ({ path: GAMES_PATHS.story, p })),
    ...petWorry.items.map((p) => ({ path: GAMES_PATHS.pet_worry, p })),
  ];
  for (const { path, p } of prompts) {
    if (!rewards.has(p.reward_item))
      throw new KbIntegrityError(`unknown reward item ${p.reward_item} in ${p.id}`, path);
  }
  for (const list of [drawing.items, story.prompts, petWorry.items, items.items]) {
    const ids = list.map((e) => ('id' in e ? e.id : e.catalogId));
    if (new Set(ids).size !== ids.length)
      throw new KbIntegrityError('duplicate game id', GAMES_PATHS.islandItems);
  }
  for (const worry of petWorry.items) {
    const ids = worry.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length)
      throw new KbIntegrityError(`duplicate option id in ${worry.id}`, GAMES_PATHS.pet_worry);
  }
  for (const prompt of story.prompts) {
    const ids = prompt.ending_options.map((o) => o.id);
    if (new Set(ids).size !== ids.length)
      throw new KbIntegrityError(`duplicate ending id in ${prompt.id}`, GAMES_PATHS.story);
  }
  const months = seasons.seasons.flatMap((s) => s.months);
  if (new Set(months).size !== 12 || months.length !== 12)
    throw new KbIntegrityError('seasons must cover each month exactly once', GAMES_PATHS.seasons);
  return {
    drawing: drawing.items,
    story: story.prompts,
    pet_worry: petWorry.items,
    islandItems: items.items,
    seasons: seasons.seasons,
  };
}

export function findGamePrompt(
  games: GameCatalog,
  type: GamePrompt['type'],
  promptId: string,
): GamePrompt | undefined {
  if (type === 'drawing') {
    const prompt = games.drawing.find((p) => p.id === promptId);
    return prompt && { type, prompt };
  }
  if (type === 'story') {
    const prompt = games.story.find((p) => p.id === promptId);
    return prompt && { type, prompt };
  }
  const prompt = games.pet_worry.find((p) => p.id === promptId);
  return prompt && { type, prompt };
}

export function gamePromptsFor(
  games: GameCatalog,
  type: GamePrompt['type'],
  gradeBand: GradeBand,
): GamePrompt[] {
  const list: GamePrompt[] =
    type === 'drawing'
      ? games.drawing.map((prompt) => ({ type, prompt }))
      : type === 'story'
        ? games.story.map((prompt) => ({ type, prompt }))
        : games.pet_worry.map((prompt) => ({ type, prompt }));
  return list.filter((g) => g.prompt.grade_bands.includes(gradeBand));
}

export function promptText(game: GamePrompt): string {
  return game.type === 'pet_worry' ? game.prompt.setup_ja : game.prompt.text_ja;
}

export function promptOptions(game: GamePrompt): { id: string; text: string }[] | undefined {
  if (game.type === 'pet_worry')
    return game.prompt.options.map((o) => ({ id: o.id, text: o.text_ja }));
  if (game.type === 'story')
    return game.prompt.ending_options.map((o) => ({ id: o.id, text: o.text_ja }));
  return undefined;
}

// 日本時間の月 → 季節 ID
export function seasonFor(seasons: Seasons, at: Date): IslandSeason {
  const month = new Date(at.getTime() + 9 * 3_600_000).getUTCMonth() + 1;
  return seasons.find((s) => s.months.includes(month))?.id ?? 'spring';
}

export function islandItemAvailable(
  entry: IslandCatalogEntry,
  state: { unlockedItems: readonly string[]; season: IslandSeason },
): boolean {
  if (entry.unlock === 'default') return true;
  if (entry.unlock === 'reward') return state.unlockedItems.includes(entry.catalogId);
  return entry.unlock === `season:${state.season}`;
}
