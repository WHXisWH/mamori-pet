import type {
  ChildHomeRes,
  DailyRituals,
  IslandPutReq,
  IslandStateRes,
  PetRequest,
  RitualReq,
} from '@ijime/api-types';
import type { Page, Request } from '@playwright/test';

export const FIXTURE_CHILD_ID = 'island-ui-fixture';

const THUMB =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff4e6"/><circle cx="32" cy="32" r="18" fill="#f4c95d"/></svg>',
  );

export const RITUALS_NONE: DailyRituals = {
  morningMood: false,
  okaeri: false,
  goodThing: false,
  watered: false,
};

export const PET_REQUEST: PetRequest = {
  requestId: 'req_fixture_1',
  type: 'drawing',
  promptId: 'draw_food_1',
  promptText: 'すきな たべものを かいて ほしいな',
  rewardItemId: 'lantern',
  offeredAt: '2026-10-03T07:00:00.000Z',
  expiresAt: '2026-10-05T07:00:00.000Z',
};

export function homeFixture(overrides: Partial<ChildHomeRes> = {}): ChildHomeRes {
  return {
    gradeBand: 'high',
    pet: { petId: 'pet_fixture', characterId: 'moko', petName: 'もこ' },
    greeting: { text: '今日も来てくれてうれしいな。', expression: 'happy', source: 'agent' },
    showHomeCheckin: false,
    games: [],
    island: { visitDays: 12, stage: 3, season: 'autumn', decorationCount: 1 },
    rituals: RITUALS_NONE,
    petRequests: [],
    ...overrides,
  };
}

export function islandFixture(overrides: Partial<IslandStateRes> = {}): IslandStateRes {
  return {
    items: [
      {
        id: 'fig_1',
        catalogId: 'rabbit_small',
        category: 'animal',
        x: 0.3,
        y: 0.5,
        rotation: 0,
        layer: 1,
      },
      {
        id: 'fig_2',
        catalogId: 'tree',
        category: 'nature',
        x: 0.7,
        y: 0.45,
        rotation: 0,
        layer: 2,
      },
    ],
    selfFigureId: 'fig_1',
    decorations: [{ artworkId: 'art_1', thumbnailUrl: THUMB }],
    unlockedItems: ['rabbit_small', 'bear', 'tree', 'rock', 'house'],
    catalog: [
      {
        catalogId: 'rabbit_small',
        category: 'animal',
        label: 'うさぎ',
        spriteUrl: 'island/rabbit_small.svg',
        locked: false,
      },
      {
        catalogId: 'bear',
        category: 'animal',
        label: 'くま',
        spriteUrl: 'island/bear.svg',
        locked: false,
      },
      {
        catalogId: 'tree',
        category: 'nature',
        label: 'き',
        spriteUrl: 'island/tree.svg',
        locked: false,
      },
      {
        catalogId: 'rock',
        category: 'nature',
        label: 'いわ',
        spriteUrl: 'island/rock.svg',
        locked: false,
      },
      {
        catalogId: 'house',
        category: 'building',
        label: 'いえ',
        spriteUrl: 'island/house.svg',
        locked: false,
      },
      {
        catalogId: 'lantern',
        category: 'object',
        label: 'ランタン',
        spriteUrl: 'island/lantern.svg',
        locked: true,
      },
    ],
    visitDays: 12,
    stage: 3,
    season: 'autumn',
    goodThingCount: 4,
    ...overrides,
  };
}

export type IslandRoutes = {
  rituals: RitualReq[];
  puts: IslandPutReq[];
  declined: string[];
  requests: Request[];
};

export async function seedChild(page: Page, gradeBand: 'low' | 'high' | 'jhs' = 'high') {
  await page.addInitScript(
    ({ grade, childId }) => {
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            paired: true,
            childId,
            assented: true,
            gradeBand: grade,
            characterId: 'moko',
            petName: 'もこ',
            petLock: null,
            readAloud: false,
            todayMood: null,
            lastHomeCheckin: null,
            dataSources: {
              voice: true,
              typing: true,
              artwork_save: true,
              home_checkin: false,
              calendar: true,
            },
          },
          version: 0,
        }),
      );
    },
    { grade: gradeBand, childId: FIXTURE_CHILD_ID },
  );
}

export async function routeIslandApi(
  page: Page,
  options: { home?: Partial<ChildHomeRes>; island?: Partial<IslandStateRes> } = {},
): Promise<IslandRoutes> {
  const calls: IslandRoutes = { rituals: [], puts: [], declined: [], requests: [] };
  let home = homeFixture(options.home);
  let island = islandFixture(options.island);
  const rituals: DailyRituals = { ...(home.rituals ?? RITUALS_NONE) };

  await page.route('**/v1/child/home', (route) => route.fulfill({ json: home }));
  await page.route('**/v1/child/preferences', (route) =>
    route.fulfill({ json: { gradeBand: home.gradeBand, ttsEnabled: false } }),
  );
  await page.route('**/v1/child/data-sources', (route) =>
    route.fulfill({
      json: {
        dataSources: {
          voice: true,
          typing: true,
          artwork_save: true,
          home_checkin: false,
          calendar: true,
        },
      },
    }),
  );
  await page.route('**/v1/child/followups', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/v1/child/island', (route) => {
    calls.requests.push(route.request());
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as IslandPutReq;
      calls.puts.push(body);
      island = {
        ...island,
        items: body.items,
        ...(body.selfFigureId ? { selfFigureId: body.selfFigureId } : {}),
      };
      return route.fulfill({ json: { sceneId: `scene_${calls.puts.length}` } });
    }
    return route.fulfill({ json: island });
  });
  await page.route('**/v1/child/rituals', (route) => {
    const body = route.request().postDataJSON() as RitualReq;
    calls.rituals.push(body);
    if (body.kind === 'watered') rituals.watered = true;
    if (body.kind === 'good_thing') {
      rituals.goodThing = true;
      island = { ...island, goodThingCount: island.goodThingCount + 1 };
    }
    home = { ...home, rituals: { ...rituals } };
    return route.fulfill({ json: { rituals, goodThingCount: island.goodThingCount } });
  });
  await page.route('**/v1/child/pet-requests/*/decline', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
    calls.declined.push(id);
    home = { ...home, petRequests: (home.petRequests ?? []).filter((r) => r.requestId !== id) };
    return route.fulfill({ json: { ok: true } });
  });
  return calls;
}
