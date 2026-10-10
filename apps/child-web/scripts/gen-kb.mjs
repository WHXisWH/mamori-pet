import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hotlinesSchema,
  islandCatalogSchema,
  safeRepliesSchema,
  storyRequestsSchema,
} from '@ijime/kb-loader';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const kb = resolve(here, '../../../kb/v0.1.0');
const outDir = resolve(here, '../src/generated');
mkdirSync(outDir, { recursive: true });

// Public dictionary assets only. Children's text stays inside the browser worker.
const require = createRequire(import.meta.url);
const tokenizerDir = dirname(require.resolve('kuromoji/package.json'));
const readingDir = resolve(here, '../public/readings/kuromoji-0.1.2');
mkdirSync(readingDir, { recursive: true });
for (const file of ['build/kuromoji.js', 'dict', 'LICENSE-2.0.txt', 'NOTICE.md']) {
  cpSync(resolve(tokenizerDir, file), resolve(readingDir, file), { recursive: true });
}

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

const rest = safeRepliesSchema.parse(
  parse(readFileSync(resolve(kb, 'prompts/rest-reminders.yaml'), 'utf8')),
);
write('rest_reminders.json', rest);

const push = parse(readFileSync(resolve(kb, 'prompts/child_push.yaml'), 'utf8'));
if (typeof push.title !== 'string' || !push.title || typeof push.body !== 'string' || !push.body)
  throw new Error('invalid child push copy');
writeFileSync(
  resolve(here, '../public/push-copy.json'),
  JSON.stringify({ title: push.title, body: push.body }, null, 2) + '\n',
);
