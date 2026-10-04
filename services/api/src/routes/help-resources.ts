import type { HelpResourcesRes } from '@ijime/api-types';
import { loadHotlines } from '@ijime/crisis-detector';
import type { Kb } from '@ijime/kb-loader';
import type { ServiceApp } from '@ijime/service-kit';

export const HELP_RESOURCES_PATH = '/v1/child/help-resources';

export function loadHelpResources(kb: Kb): Promise<HelpResourcesRes> {
  return loadHotlines(kb);
}

export function registerHelpResources(app: ServiceApp, getKb: () => Promise<Kb>): void {
  app.get(HELP_RESOURCES_PATH, async (c) => {
    const body = await loadHelpResources(await getKb());
    c.header('Cache-Control', 'public, max-age=3600, stale-if-error=86400');
    return c.json(body);
  });
}
