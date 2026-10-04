import type { CSSProperties, FC, ReactElement } from 'react';

import * as animals from './sprites/animals.js';
import * as buildings from './sprites/buildings.js';
import * as deco from './sprites/deco.js';
import * as plants from './sprites/plants.js';

export const ISLAND_SPRITES: Record<string, FC> = {
  rabbit_01: animals.Rabbit01,
  bear_01: animals.Bear01,
  fox_01: animals.Fox01,
  cat_01: animals.Cat01,
  dog_01: animals.Dog01,
  bird_01: animals.Bird01,
  turtle_01: animals.Turtle01,
  owl_01: animals.Owl01,
  frog_01: animals.Frog01,
  deer_01: animals.Deer01,
  penguin_01: animals.Penguin01,
  tree_01: plants.Tree01,
  bush_01: plants.Bush01,
  flower_01: plants.Flower01,
  flower_02: plants.Flower02,
  mushroom_01: plants.Mushroom01,
  cherry_tree_01: plants.CherryTree01,
  tulip_01: plants.Tulip01,
  sunflower_01: plants.Sunflower01,
  maple_tree_01: plants.MapleTree01,
  pine_tree_01: plants.PineTree01,
  house_01: buildings.House01,
  school_01: buildings.School01,
  tent_01: buildings.Tent01,
  treehouse_01: buildings.Treehouse01,
  lighthouse_01: buildings.Lighthouse01,
  bench_01: buildings.Bench01,
  table_01: buildings.Table01,
  swing_01: buildings.Swing01,
  slide_01: buildings.Slide01,
  lantern_01: buildings.Lantern01,
  mailbox_01: buildings.Mailbox01,
  bookshelf_01: buildings.Bookshelf01,
  boat_01: deco.Boat01,
  flag_01: deco.Flag01,
  kite_01: deco.Kite01,
  balloon_01: deco.Balloon01,
  frame_01: deco.Frame01,
  windchime_01: deco.Windchime01,
  watermelon_01: deco.Watermelon01,
  sports_flag_01: deco.SportsFlag01,
  bunting_01: deco.Bunting01,
  snowman_01: deco.Snowman01,
  notebook_01: deco.Notebook01,
  rock_01: deco.Rock01,
  pond_01: deco.Pond01,
  hill_01: deco.Hill01,
  cloud_01: deco.Cloud01,
  rainbow_01: deco.Rainbow01,
  star_01: deco.Star01,
};

export function hasIslandSprite(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISLAND_SPRITES, id);
}

export type IslandSpriteProps = {
  id: string;
  size?: number | string;
  label?: string;
  className?: string;
  style?: CSSProperties;
};

export function IslandSprite({
  id,
  size = 96,
  label,
  className,
  style,
}: IslandSpriteProps): ReactElement | null {
  const Sprite = hasIslandSprite(id) ? ISLAND_SPRITES[id] : undefined;
  if (!Sprite) return null;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
      style={style}
      data-sprite={id}
    >
      <Sprite />
    </svg>
  );
}
