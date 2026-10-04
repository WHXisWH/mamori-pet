import type { StoryPromptRes } from '@ijime/api-types';
import { storyRequestsSchema, type Kb } from '@ijime/kb-loader';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { childOwner } from './workflow-store.js';

export function registerChildGames(
  app: ServiceApp,
  getDeps: () => Promise<ChatDeps>,
  getKb: () => Promise<Kb>,
): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child/games');
  r.use('*', async (c, next) => childAuth((await getDeps()).auth)(c, next));
  r.get('/story-prompt', async (c) => {
    const { child } = await childOwner(await getDeps(), c.get('child').childId);
    const kb = await getKb();
    const { prompts } = await kb.yaml('games/story_prompts.yaml', storyRequestsSchema);
    const available = prompts.filter((p) => p.grade_bands.includes(child.gradeBand));
    if (!available.length) throw new ApiHttpError('NOT_FOUND', 'お話が見つかりません');
    const day = Math.floor((Date.now() + 9 * 3_600_000) / 86_400_000);
    const prompt = available[day % available.length]!;
    return c.json({ promptId: prompt.id, text: prompt.text_ja } satisfies StoryPromptRes);
  });
}
