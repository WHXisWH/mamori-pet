import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { resolveMedia } from '../src/lib/media-shared';

const VIDEO_DIR = fileURLToPath(new URL('../public/video/', import.meta.url));
const MEDIA = resolveMedia(existsSync(VIDEO_DIR) ? readdirSync(VIDEO_DIR) : []);

test('hero, sections and hotlines are present', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('言ってくれる相棒');
  for (const id of ['story', 'characters', 'guardians', 'safety', 'promise']) {
    await expect(page.locator(`#${id}`)).toBeAttached();
  }
  await expect(page.getByText('0120-0-78310')).toBeVisible();
  await expect(page.getByTestId('rule-card')).toHaveCount(2);
});

test('story avatar changes character and expression while scrolling', async ({ page }) => {
  await page.goto('/');
  const story = page.locator('#story');
  const avatar = page.locator('[data-testid="story-avatar"] svg');

  await page.locator('[data-frame="morning"]').scrollIntoViewIfNeeded();
  await expect(story).toHaveAttribute('data-active-frame', 'morning');
  await expect(avatar).toHaveAttribute('data-character', 'togemaru');

  await page.locator('[data-frame="family"]').scrollIntoViewIfNeeded();
  await expect(story).toHaveAttribute('data-active-frame', 'family');
  await expect(avatar).toHaveAttribute('data-character', 'nami');
  await expect(avatar).toHaveAttribute('data-expression', 'caring');

  await page.locator('[data-frame="night"]').scrollIntoViewIfNeeded();
  await expect(story).toHaveAttribute('data-active-frame', 'night');
  await expect(avatar).toHaveAttribute('data-character', 'hoshi');
  await expect(story).toHaveClass(/bg-night/);
});

test('the story is about everyday life, not about bullying or crisis', async ({ page }) => {
  await page.goto('/?nointro');
  const hero = page.locator('section[aria-labelledby="hero-title"]');
  const story = page.locator('#story');
  for (const word of ['いじめ', '危機', '相談', '通報', '命']) {
    await expect(hero).not.toContainText(word);
    await expect(story).not.toContainText(word);
  }
});

test('all five characters and the egg are shown', async ({ page }) => {
  await page.goto('/');
  await page.locator('#characters').scrollIntoViewIfNeeded();
  for (const name of ['もこ', 'ぽっけ', 'トゲまる', 'なみ', 'ほし']) {
    await expect(page.locator('#characters').getByRole('heading', { name })).toBeVisible();
  }
  await expect(page.locator('#characters svg[data-character="hidden"]')).toBeVisible();
});

test('intro title card plays once, then the hero title is revealed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('intro')).toBeVisible();
  await expect(page.getByTestId('intro')).toHaveCount(0, { timeout: 6000 });
  await expect(page.locator('#hero-title')).toHaveClass(/is-revealed/);
  await page.reload();
  await expect(page.getByTestId('intro')).toHaveCount(0);
  await expect(page.locator('#hero-title')).toHaveClass(/is-revealed/);
});

test('each stage plays generated footage when present, otherwise the drawn scene', async ({
  page,
}) => {
  await page.goto('/?nointro');
  const hero = page.locator('section[aria-labelledby="hero-title"]');
  if (MEDIA.s0) {
    await expect(hero.locator('[data-media="video"]')).toHaveAttribute('src', MEDIA.s0.src);
    await expect(hero.locator('[data-media="scene"]')).toHaveCount(0);
  } else {
    await expect(hero.locator('[data-media="video"]')).toHaveCount(0);
    await expect(hero.locator('[data-media="scene"]')).toHaveCount(1);
    await expect(page.getByTestId('hero-avatar')).toBeVisible();
  }
  const story = page.locator('#story');
  const storyShots = ['s1', 's2', 's3', 's4', 's5'] as const;
  const storyVideos = storyShots.filter((id) => MEDIA[id]).length;
  await expect(story.locator('[data-media="video"]')).toHaveCount(storyVideos);
  await expect(page.getByRole('button', { name: /音を(出す|消す)/ })).toHaveCount(
    Object.keys(MEDIA).length > 0 ? 1 : 0,
  );
});

test('story bubble stays inside a phone screen and points at the pet', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
  });
  const page = await ctx.newPage();
  await page.goto('/?nointro');
  for (const frame of ['chatter', 'family', 'night']) {
    await page.locator(`[data-frame="${frame}"]`).scrollIntoViewIfNeeded();
    await expect(page.locator('#story')).toHaveAttribute('data-active-frame', frame);
    const bubble = page.getByTestId('story-bubble');
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveCSS('opacity', '1');
    const box = (await bubble.boundingBox())!;
    const pet = (await page.getByTestId('story-avatar').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(pet.y + pet.height * 0.2);
    expect(pet.y + pet.height).toBeLessThanOrEqual(844);
  }
  await ctx.close();
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('skips the intro, smooth scrolling and reveal animations', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByTestId('intro')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/lenis/);
    await expect(page.locator('#hero-title .reveal-line').first()).toHaveCSS('opacity', '1');
    await page.locator('#promise').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('rule-card').first()).toBeVisible();
  });
});
