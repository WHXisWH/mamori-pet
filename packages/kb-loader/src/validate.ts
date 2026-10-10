import type { GradeBand } from '@ijime/api-types';

import { KbIntegrityError, type Kb } from './kb.js';
import { loadQuickReplyCatalog, QUICK_REPLY_CATALOG_PATH } from './quick-replies.js';
import {
  holidaysSchema,
  hotlinesSchema,
  lexiconSchema,
  schoolCalendarsSchema,
  signalDefinitionSchema,
  sourceRegistrySchema,
  type Hotlines,
  type Lexicon,
  type SignalDefinition,
  type SourceRegistry,
} from './schemas.js';

export const SOURCE_REGISTRY_PATH = 'sources/registry.yaml';
export const HOTLINES_PATH = 'resources/hotlines.yaml';
export const LEXICON_PATH = 'lexicon/ja.yaml';
export const HOLIDAYS_PATH = 'resources/jp_holidays.yaml';
export const SCHOOL_CALENDARS_PATH = 'resources/school_calendars.yaml';

function fail(message: string, path: string): never {
  throw new KbIntegrityError(`knowledge base: ${message}`, path);
}

export function normalizeExpression(expression: string): string {
  return expression.normalize('NFKC').trim();
}

export function sourceIds(registry: SourceRegistry): Set<string> {
  return new Set(registry.sources.map((source) => source.id));
}

export function validateSignalDefinition(
  def: SignalDefinition,
  known: ReadonlySet<string>,
  path = `signals/${def.signal_id.toLowerCase()}.yaml`,
): void {
  if (def.evidence.source !== undefined) {
    fail(
      `${def.signal_id} still uses evidence.source "${def.evidence.source}"; register it in ${SOURCE_REGISTRY_PATH} and move it to evidence.sources: [<id>]`,
      path,
    );
  }
  for (const id of def.evidence.sources ?? []) {
    if (!known.has(id)) fail(`${def.signal_id} cites unknown source ${id}`, path);
  }
  if (def.grade_bands.length === 0) fail(`${def.signal_id} declares no grade band`, path);
  const byGrade = def.examples_by_grade;
  if (byGrade) {
    for (const band of Object.keys(byGrade) as GradeBand[]) {
      if (!def.grade_bands.includes(band)) {
        fail(`${def.signal_id} has examples for undeclared grade band ${band}`, path);
      }
    }
  }
  if (def.explicit && def.method === 'model') {
    if (!byGrade) {
      fail(
        `${def.signal_id} is explicit; examples_ja must be grouped by grade band {low, high, jhs}`,
        path,
      );
    }
    for (const band of def.grade_bands) {
      if ((byGrade[band] ?? []).length === 0) {
        fail(`${def.signal_id} has no example for grade band ${band}`, path);
      }
    }
  }
}

export function validateLexicon(lexicon: Lexicon, path = LEXICON_PATH): void {
  const seen = new Map<string, string>();
  for (const category of lexicon.categories) {
    if (category.explicit === undefined) fail(`category ${category.id} lacks explicit`, path);
    if (!category.grade_bands || category.grade_bands.length === 0) {
      fail(`category ${category.id} lacks grade_bands`, path);
    }
    for (const expression of category.expressions) {
      const normalized = normalizeExpression(expression);
      if (normalized.length === 0) fail(`category ${category.id} has an empty expression`, path);
      const previous = seen.get(normalized);
      if (previous !== undefined) {
        fail(`duplicate expression "${expression}" (${category.id}) already in ${previous}`, path);
      }
      seen.set(normalized, category.id);
    }
  }
}

export function validateHotlines(hotlines: Hotlines, path = HOTLINES_PATH): void {
  for (const hotline of [...hotlines.resources, ...hotlines.candidates]) {
    if (hotline.verified_by.trim().length === 0) {
      fail(`hotline ${hotline.id} lacks verified_by`, path);
    }
    if (hotline.phone === undefined && hotline.url === undefined) {
      fail(`hotline ${hotline.id} needs a phone or a url`, path);
    }
  }
}

export async function loadSourceRegistry(kb: Kb): Promise<SourceRegistry> {
  if (!kb.has(SOURCE_REGISTRY_PATH)) fail('source registry missing', SOURCE_REGISTRY_PATH);
  return kb.yaml(SOURCE_REGISTRY_PATH, sourceRegistrySchema);
}

export async function loadSignalDefinitions(
  kb: Kb,
): Promise<{ path: string; def: SignalDefinition }[]> {
  const paths = kb.paths('signals/').filter((p) => p.endsWith('.yaml'));
  return Promise.all(
    paths.map(async (path) => ({ path, def: await kb.yaml(path, signalDefinitionSchema) })),
  );
}

export async function validateKnowledgeBase(kb: Kb): Promise<SourceRegistry> {
  if (kb.has(QUICK_REPLY_CATALOG_PATH)) await loadQuickReplyCatalog(kb);
  const registry = await loadSourceRegistry(kb);
  const known = sourceIds(registry);
  const signals = await loadSignalDefinitions(kb);
  const ids = new Set<string>();
  for (const { path, def } of signals) {
    if (ids.has(def.signal_id)) fail(`duplicate signal id ${def.signal_id}`, path);
    ids.add(def.signal_id);
    validateSignalDefinition(def, known, path);
  }
  if (kb.has(LEXICON_PATH)) validateLexicon(await kb.yaml(LEXICON_PATH, lexiconSchema));
  if (kb.has(HOTLINES_PATH)) validateHotlines(await kb.yaml(HOTLINES_PATH, hotlinesSchema));
  if (kb.has(HOLIDAYS_PATH)) {
    const holidays = await kb.yaml(HOLIDAYS_PATH, holidaysSchema);
    for (const id of holidays.source_ids ?? []) {
      if (!known.has(id)) fail(`holidays cite unknown source ${id}`, HOLIDAYS_PATH);
    }
  }
  if (kb.has(SCHOOL_CALENDARS_PATH)) {
    const calendars = await kb.yaml(SCHOOL_CALENDARS_PATH, schoolCalendarsSchema);
    for (const calendar of calendars.calendars) {
      for (const id of calendar.source_ids) {
        if (!known.has(id)) {
          fail(`calendar ${calendar.id} cites unknown source ${id}`, SCHOOL_CALENDARS_PATH);
        }
      }
    }
  }
  return registry;
}
