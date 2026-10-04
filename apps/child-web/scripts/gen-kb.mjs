import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hotlinesSchema, islandCatalogSchema, storyRequestsSchema } from '@ijime/kb-loader';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const kb = resolve(here, '../../../kb/v0.1.0');
const outDir = resolve(here, '../src/generated');
mkdirSync(outDir, { recursive: true });

const write = (name, data) =>
  writeFileSync(resolve(outDir, name), JSON.stringify(data, null, 2) + '\n');

const hotlines = hotlinesSchema.parse(
  parse(readFileSync(resolve(kb, 'resources/hotlines.yaml'), 'utf8')),
);
write('hotlines.json', {
  version: `static/${hotlines.version}`,
  resources: hotlines.resources.map(({ id, name, audience, phone, url, hours }) => ({
    id,
    name,
    audience,
    ...(phone !== undefined ? { phone } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(hours !== undefined ? { hours } : {}),
  })),
});

const items = islandCatalogSchema.parse(
  parse(readFileSync(resolve(kb, 'games/island_items.yaml'), 'utf8')),
);
write(
  'island_items.json',
  items.items.map((i) => ({
    catalogId: i.catalogId,
    category: i.category,
    label: i.label_ja,
    sprite: i.sprite,
  })),
);

const prompts = storyRequestsSchema.parse(
  parse(readFileSync(resolve(kb, 'games/story_prompts.yaml'), 'utf8')),
);
write(
  'story_prompts.json',
  prompts.prompts.map((p) => ({ promptId: p.id, gradeBands: p.grade_bands, text: p.text_ja })),
);

const safe = {};
for (const g of ['low', 'high', 'jhs', 'family_harm']) {
  safe[g] = readFileSync(resolve(kb, `templates/safe_mode/${g}.ja.txt`), 'utf8')
    .trim()
    .split('\n');
}
write('safe_mode.json', safe);
