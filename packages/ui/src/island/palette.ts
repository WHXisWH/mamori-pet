export const ISLAND_COLORS = {
  ink: '#3b3a36',
  inkSoft: '#6f6b63',
  cream: '#fff8f0',
  creamDeep: '#f6ead9',
  sand: '#f3e2c3',
  sandDeep: '#e3cba0',
  leaf: '#7fb77e',
  leafDeep: '#4f8a4e',
  leafSoft: '#b9d9a8',
  wood: '#c99a6b',
  woodDeep: '#8a5a3c',
  sun: '#f4c95d',
  sunDeep: '#e0a93f',
  blush: '#f7b8c4',
  blushDeep: '#f2b8c6',
  calm: '#6b9ac4',
  calmDeep: '#3d6f9e',
  calmSoft: '#dbe7f3',
  orange: '#f6a96b',
  orangeDeep: '#d97b3a',
  coral: '#e8907a',
  mint: '#9fd9c8',
  lilac: '#c9b8d9',
  stone: '#b8b2a7',
  stoneDeep: '#8f887c',
  snow: '#ffffff',
  grey: '#c9d3dc',
  greyDeep: '#9fb1c4',
  storm: '#7c8797',
  night: '#2b3557',
  nightSoft: '#33406b',
  star: '#f1c76b',
} as const;

export const ISLAND_SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type IslandSeason = (typeof ISLAND_SEASONS)[number];

export const ISLAND_STAGES = [1, 2, 3] as const;
export type IslandStage = (typeof ISLAND_STAGES)[number];
