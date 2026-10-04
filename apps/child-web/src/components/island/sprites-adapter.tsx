import {
  hasIslandSprite,
  IslandGround as UiIslandGround,
  IslandSky,
  IslandSprite as UiIslandSprite,
  ISLAND_SEASONS,
  type IslandSeason,
  type IslandSkyWeather as SkyWeather,
  type IslandStage,
  type TimeOfDay,
} from '@ijime/ui';
import type { ReactElement } from 'react';

import islandItems from '@/generated/island_items.json';

type CatalogEntry = { catalogId: string; category: string; label: string; sprite: string };

const CATALOG = islandItems as CatalogEntry[];

export function catalogSpriteId(catalogId: string): string {
  return CATALOG.find((item) => item.catalogId === catalogId)?.sprite ?? catalogId;
}

export function islandItemLabel(catalogId: string): string {
  return CATALOG.find((item) => item.catalogId === catalogId)?.label ?? catalogId;
}

export function seasonKey(season: string): IslandSeason {
  const s = season.toLowerCase();
  if (s.includes('summer') || s.includes('natsu') || s.includes('夏')) return 'summer';
  if (s.includes('autumn') || s.includes('fall') || s.includes('aki') || s.includes('秋'))
    return 'autumn';
  if (s.includes('winter') || s.includes('fuyu') || s.includes('冬')) return 'winter';
  return ISLAND_SEASONS[0];
}

function stageKey(stage: number): IslandStage {
  if (stage <= 1) return 1;
  if (stage === 2) return 2;
  return 3;
}

export function IslandSprite({
  id,
  size = 56,
  className,
  label,
}: {
  id: string;
  size?: number | string;
  className?: string;
  label?: string;
}): ReactElement {
  const spriteId = catalogSpriteId(id);
  return (
    <UiIslandSprite
      id={hasIslandSprite(spriteId) ? spriteId : 'rock_01'}
      size={size}
      {...(label ? { label } : {})}
      {...(className ? { className } : {})}
    />
  );
}

export function IslandGround({
  stage,
  season,
  className,
}: {
  stage: number;
  season: string;
  className?: string;
}): ReactElement {
  return (
    <UiIslandGround
      stage={stageKey(stage)}
      season={seasonKey(season)}
      height="100%"
      {...(className ? { className } : {})}
    />
  );
}

export { IslandSky, type SkyWeather, type TimeOfDay };
