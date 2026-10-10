import { CHARACTER_IDS, EXPRESSIONS, GRADE_BANDS, MOOD_WEATHERS } from '@ijime/api-types';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CHARACTER_META, SELECTABLE_CHARACTERS } from './characters/meta.js';
import { PetAvatar } from './characters/PetAvatar.js';
import { PET_STATES } from './characters/petArt.js';
import { RULE_CARD_LINES, RuleCard } from './components/RuleCard.js';
import { WEATHER_LABELS, WeatherIcon } from './components/WeatherIcon.js';
import { IslandGround } from './island/IslandGround.js';
import { ISLAND_TIMES_OF_DAY, IslandSky } from './island/IslandSky.js';
import { ISLAND_SPRITES, IslandSprite, hasIslandSprite } from './island/IslandSprite.js';
import { ISLAND_SEASONS, ISLAND_STAGES } from './island/palette.js';

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, 'docs', '05-frontend.md')) && dirname(dir) !== dir)
    dir = dirname(dir);
  return dir;
}

function readGame(name: string): string {
  return readFileSync(join(repoRoot(), 'kb', 'v0.1.0', 'games', name), 'utf8');
}

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!);
}

describe('PetAvatar', () => {
  it('renders every character in every expression and state', () => {
    for (const c of CHARACTER_IDS) {
      for (const e of EXPRESSIONS) {
        for (const st of PET_STATES) {
          const { container, unmount } = render(
            <PetAvatar characterId={c} expression={e} state={st} />,
          );
          const svg = container.querySelector('svg')!;
          expect(svg.getAttribute('data-character')).toBe(c);
          expect(svg.getAttribute('data-expression')).toBe(e);
          expect(svg.getAttribute('data-state')).toBe(st);
          expect(svg.getAttribute('aria-label')).toContain(CHARACTER_META[c].displayName);
          unmount();
        }
      }
    }
  });

  it('turns aside while idle and listens while the child types', () => {
    const idle = render(<PetAvatar characterId="pokke" state="idle" />).container.querySelector(
      'svg',
    )!;
    expect(idle.classList.contains('pa-idle')).toBe(true);
    expect(idle.getAttribute('aria-label')).toContain('あそんでいる');
    const listen = render(<PetAvatar characterId="pokke" state="listen" />).container.querySelector(
      'svg',
    )!;
    expect(listen.classList.contains('pa-attend')).toBe(true);
    expect(listen.classList.contains('pa-listening')).toBe(true);
  });

  it('shows sparkles only when celebrating and zzz only when sleepy', () => {
    const celebrate = render(<PetAvatar characterId="moko" expression="celebrate" />);
    expect(celebrate.container.querySelectorAll('.pa-twinkle').length).toBeGreaterThan(0);
    expect(celebrate.container.querySelector('.pa-zzz')).toBeNull();
    const sleepy = render(<PetAvatar characterId="pokke" expression="sleepy" />);
    expect(sleepy.container.querySelector('.pa-zzz')).not.toBeNull();
    expect(sleepy.container.querySelector('.pa-twinkle')).toBeNull();
  });

  it('can disable animation', () => {
    const { container } = render(<PetAvatar characterId="nami" animate={false} />);
    expect(container.querySelector('svg')!.classList.contains('pa-anim')).toBe(false);
  });

  it('drops the felt texture at small sizes', () => {
    const small = render(<PetAvatar characterId="hoshi" size={40} />).container.innerHTML;
    const big = render(<PetAvatar characterId="hoshi" size={160} />).container.innerHTML;
    expect(small).not.toMatch(/filter="url\(#[^)]*-felt\)"/);
    expect(big).toMatch(/filter="url\(#[^)]*-felt\)"/);
  });

  it('keeps ids unique between avatars on the same page', () => {
    const { container } = render(
      <>
        <PetAvatar characterId="moko" />
        <PetAvatar characterId="moko" />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('smiles when tapped, unless tap reactions are off', () => {
    const { container } = render(<PetAvatar characterId="togemaru" />);
    const svg = container.querySelector('svg')!;
    fireEvent.click(svg);
    expect(svg.classList.contains('pa-tapped')).toBe(true);
    expect(svg.classList.contains('pa-joy')).toBe(true);
    const off = render(
      <PetAvatar characterId="togemaru" reactToTap={false} />,
    ).container.querySelector('svg')!;
    fireEvent.click(off);
    expect(off.classList.contains('pa-tapped')).toBe(false);
  });

  it('keeps the shape under the finger in place so a surrounding link or button still gets the tap', () => {
    const onClick = vi.fn();
    const { container } = render(
      <button type="button" onClick={onClick}>
        <PetAvatar characterId="togemaru" />
      </button>,
    );
    const part = container.querySelector('svg > g')!;
    fireEvent.pointerDown(part);
    expect(part.isConnected).toBe(true);
    fireEvent.click(part);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector('svg')!.classList.contains('pa-tapped')).toBe(true);
  });
});

describe('character meta', () => {
  it('has five selectable characters plus the hidden egg', () => {
    expect(SELECTABLE_CHARACTERS).toHaveLength(5);
    expect(SELECTABLE_CHARACTERS).not.toContain('hidden');
    for (const c of CHARACTER_IDS) expect(CHARACTER_META[c].tagline.length).toBeGreaterThan(0);
  });
});

describe('WeatherIcon', () => {
  it('renders all four weathers with labels per grade band', () => {
    for (const w of MOOD_WEATHERS) {
      const { container } = render(<WeatherIcon weather={w} />);
      expect(container.querySelector('svg')).not.toBeNull();
      for (const g of GRADE_BANDS) expect(WEATHER_LABELS[w][g].length).toBeGreaterThan(0);
    }
  });
});

describe('RuleCard', () => {
  it('has the same five rules in every grade band', () => {
    for (const g of GRADE_BANDS) expect(RULE_CARD_LINES[g]).toHaveLength(5);
    const { getAllByRole } = render(<RuleCard gradeBand="low" />);
    expect(getAllByRole('listitem')).toHaveLength(5);
  });

  it('matches the wording in docs/05-frontend.md for jhs and low', () => {
    const doc = readFileSync(join(repoRoot(), 'docs', '05-frontend.md'), 'utf8');
    const section = doc.slice(doc.indexOf('ルールカード（RuleCard）'));
    const blocks = [...section.matchAll(/```text\n([\s\S]*?)```/g)].map((m) =>
      m[1]!.trim().split('\n'),
    );
    expect(blocks[0]).toEqual([...RULE_CARD_LINES.jhs]);
    expect(blocks[1]).toEqual([...RULE_CARD_LINES.low]);
  });
});

describe('island sprites', () => {
  const catalog = readGame('island_items.yaml');
  const catalogIds = matchAll(catalog, /catalogId:\s*([a-z0-9_]+)/g);
  const sprites = matchAll(catalog, /sprite:\s*([a-z0-9_]+)/g);

  it('has a component for every catalog item', () => {
    expect(catalogIds.length).toBeGreaterThanOrEqual(40);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(sprites).toHaveLength(catalogIds.length);
    for (const id of sprites) expect(hasIslandSprite(id), id).toBe(true);
    expect(hasIslandSprite('nope_99')).toBe(false);
  });

  it('renders every sprite', () => {
    for (const id of Object.keys(ISLAND_SPRITES)) {
      const { container, unmount } = render(<IslandSprite id={id} size={48} />);
      const svg = container.querySelector('svg')!;
      expect(svg, id).not.toBeNull();
      expect(svg.getAttribute('data-sprite')).toBe(id);
      expect(svg.children.length).toBeGreaterThan(0);
      unmount();
    }
    const { container } = render(<IslandSprite id="nope_99" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('only rewards and seasonal items that exist in the catalog', () => {
    const ids = new Set(catalogIds);
    for (const file of ['drawing_requests.yaml', 'story_prompts.yaml', 'pet_worries.yaml']) {
      const rewards = matchAll(readGame(file), /reward_item:\s*([a-z0-9_]+)/g);
      expect(rewards.length, file).toBeGreaterThan(0);
      for (const r of rewards) expect(ids.has(r), `${file}: ${r}`).toBe(true);
    }
    const seasonal = matchAll(readGame('seasons.yaml'), /items:\s*\[([^\]]+)\]/g)
      .flatMap((list) => list.split(','))
      .map((s) => s.trim());
    expect(seasonal.length).toBeGreaterThan(0);
    for (const s of seasonal) expect(ids.has(s), s).toBe(true);
  });

  it('renders the ground for every stage and season and the sky for every weather', () => {
    for (const stage of ISLAND_STAGES) {
      for (const season of ISLAND_SEASONS) {
        const { container, unmount } = render(<IslandGround stage={stage} season={season} />);
        const svg = container.querySelector('svg')!;
        expect(svg.getAttribute('data-stage')).toBe(String(stage));
        expect(svg.getAttribute('data-season')).toBe(season);
        unmount();
      }
    }
    for (const w of [...MOOD_WEATHERS, ...ISLAND_TIMES_OF_DAY]) {
      const { container, unmount } = render(<IslandSky weather={w} />);
      expect(container.querySelector('svg')!.getAttribute('data-sky')).toBe(w);
      unmount();
    }
  });
});
