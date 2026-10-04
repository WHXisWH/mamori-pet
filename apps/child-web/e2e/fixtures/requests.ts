import type { Page } from '@playwright/test';

export type GradeBand = 'low' | 'high' | 'jhs';
export type PetRequestType = 'drawing' | 'story' | 'pet_worry';

export type PetRequestFixture = {
  requestId: string;
  type: PetRequestType;
  promptId: string;
  promptText: string;
  options?: { id: string; text: string }[];
  rewardItemId: string;
  offeredAt: string;
  expiresAt: string;
};

export type CompleteBody =
  | { type: 'drawing'; artworkId: string }
  | {
      type: 'story';
      artworkId?: string;
      ending?: { mode: 'typed' | 'voice_transcript' | 'option'; text: string };
    }
  | { type: 'pet_worry'; optionId: string };

export const DRAWING_REQUEST: PetRequestFixture = {
  requestId: 'req_draw_1',
  type: 'drawing',
  promptId: 'dp_food_001',
  promptText: 'すきな たべものを かいて',
  rewardItemId: 'tree',
  offeredAt: '2026-10-03T07:00:00.000Z',
  expiresAt: '2026-10-10T07:00:00.000Z',
};

export const STORY_REQUEST: PetRequestFixture = {
  requestId: 'req_story_1',
  type: 'story',
  promptId: 'sp_001',
  promptText: '森のがっこうで、ひとりの こりすが、おとした どんぐりを さがしていると……',
  options: [
    { id: 'opt_a', text: 'ともだちが いっしょに さがして くれた' },
    { id: 'opt_b', text: 'せんせいが きて、みんなで さがした' },
    { id: 'opt_c', text: 'あたらしい どんぐりを みつけた' },
  ],
  rewardItemId: 'boat',
  offeredAt: '2026-10-03T07:00:00.000Z',
  expiresAt: '2026-10-10T07:00:00.000Z',
};

export const WORRY_REQUEST: PetRequestFixture = {
  requestId: 'req_worry_1',
  type: 'pet_worry',
  promptId: 'pw_001',
  promptText: 'もりの がっこうで、みんなに むしされちゃったの。どうしたら いいかな？',
  options: [
    { id: 'talk_friend', text: 'なかのいい ともだちに はなす' },
    { id: 'tell_adult', text: 'せんせいや おうちの ひとに いう' },
    { id: 'wait', text: 'すこし ようすを みる' },
    { id: 'ask_why', text: 'どうしてか きいてみる' },
  ],
  rewardItemId: 'rabbit_small',
  offeredAt: '2026-10-03T07:00:00.000Z',
  expiresAt: '2026-10-10T07:00:00.000Z',
};

export const ALL_REQUESTS = [DRAWING_REQUEST, STORY_REQUEST, WORRY_REQUEST];

export const CRISIS_PAYLOAD = {
  crisisId: 'crisis_fixture_1',
  message: 'はなしてくれて ありがとう。いまは あんぜんな おとなに たすけを もとめよう。',
  resources: [
    { id: 'sos_dial', name: '24時間子供SOSダイヤル', phone: '0120078310', audience: 'child' },
    { id: 'jidou_soudan', name: '児童相談所', phone: '189', audience: 'child' },
  ],
};

export const PET_REPLIES: Record<PetRequestType, string> = {
  drawing: 'かざらせて くれて ありがとう！ これは だれが いるの？',
  story: 'つづきを きかせて くれて ありがとう。こりすは その あと、どうしたのかな？',
  pet_worry: 'そっか、いって みるね。いっしょに かんがえて くれて ありがとう。',
};

export const DEFAULT_SOURCES = {
  voice: true,
  typing: true,
  artwork_save: true,
  home_checkin: false,
  calendar: false,
};

export async function seedChild(
  page: Page,
  gradeBand: GradeBand,
  options: { sources?: typeof DEFAULT_SOURCES; readAloud?: boolean } = {},
) {
  await page.goto('/pair');
  await page.evaluate(
    ({ gradeBand, sources, readAloud }) =>
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            paired: true,
            childId: `c_requests_${gradeBand}`,
            assented: true,
            gradeBand,
            characterId: 'moko',
            petName: '',
            dataSources: sources,
            todayMood: null,
            lastHomeCheckin: null,
            petLock: null,
            readAloud,
          },
          version: 0,
        }),
      ),
    {
      gradeBand,
      sources: options.sources ?? DEFAULT_SOURCES,
      readAloud: options.readAloud ?? false,
    },
  );
}

export type RecordedCalls = {
  complete: { requestId: string; body: CompleteBody }[];
  decline: string[];
  artworks: string[];
};

export async function mockRequestRoutes(
  page: Page,
  options: {
    requests?: PetRequestFixture[];
    crisisOnComplete?: boolean;
    crisisOnArtwork?: boolean;
    artworkId?: string;
  } = {},
): Promise<RecordedCalls> {
  const calls: RecordedCalls = { complete: [], decline: [], artworks: [] };
  const requests = options.requests ?? ALL_REQUESTS;
  const artworkId = options.artworkId ?? 'art_fixture_1';
  await page.route('**/v1/child/pet-requests', (route) =>
    route.fulfill({ json: { items: requests } }),
  );
  await page.route('**/v1/child/pet-requests/*/complete', (route) => {
    const match = /pet-requests\/([^/]+)\/complete/.exec(route.request().url());
    const requestId = decodeURIComponent(match?.[1] ?? '');
    const body = route.request().postDataJSON() as CompleteBody;
    calls.complete.push({ requestId, body });
    const request = requests.find((item) => item.requestId === requestId);
    if (!request) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
    if (options.crisisOnComplete)
      return route.fulfill({
        json: {
          rewardItemId: request.rewardItemId,
          petReply: '',
          crisis: CRISIS_PAYLOAD,
        },
      });
    return route.fulfill({
      json: {
        rewardItemId: request.rewardItemId,
        replyMessageId: 'm_fixture_1',
        petReply: PET_REPLIES[request.type],
      },
    });
  });
  await page.route('**/v1/child/pet-requests/*/decline', (route) => {
    const match = /pet-requests\/([^/]+)\/decline/.exec(route.request().url());
    calls.decline.push(decodeURIComponent(match?.[1] ?? ''));
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/v1/child/artworks', (route) => {
    calls.artworks.push(route.request().postData() ?? '');
    if (options.crisisOnArtwork)
      return route.fulfill({
        json: { artworkId, petPrompt: '', crisis: CRISIS_PAYLOAD },
      });
    return route.fulfill({ json: { artworkId, petPrompt: 'これは なに？' } });
  });
  return calls;
}

export function multipartField(raw: string, name: string): string | null {
  const pattern = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`);
  const match = pattern.exec(raw);
  return match?.[1] ?? null;
}

export const FAKE_SPEECH_TRANSCRIPT = 'きょうは カレーを たべた';

export async function installFakeSpeechRecognition(
  page: Page,
  transcript = FAKE_SPEECH_TRANSCRIPT,
) {
  await page.addInitScript((text) => {
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      private timer: number | null = null;
      start() {
        (window as unknown as { __fakeSpeechLang?: string }).__fakeSpeechLang = this.lang;
        this.timer = window.setTimeout(() => {
          this.onresult?.({
            resultIndex: 0,
            results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: text } } },
          });
          this.onend?.();
        }, 300);
      }
      stop() {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.onend?.();
      }
      abort() {
        if (this.timer !== null) window.clearTimeout(this.timer);
      }
    }
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
      FakeRecognition;
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  }, transcript);
}

export async function removeSpeechRecognition(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w['webkitSpeechRecognition'];
    delete w['SpeechRecognition'];
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
  });
}

export async function drawStroke(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 });
  await page.mouse.up();
}

export async function expectNoHorizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
}
