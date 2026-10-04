import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { availableMedia } from './media';
import { resolveMedia } from './media-shared';

describe('resolveMedia', () => {
  it('returns nothing when no footage has been generated', () => {
    expect(resolveMedia([])).toEqual({});
    expect(resolveMedia(['README.md', '.gitkeep'])).toEqual({});
  });

  it('matches shots by prefix and pairs posters with the same stem', () => {
    const media = resolveMedia([
      's0-hero-room.mp4',
      's0-hero-room.jpg',
      's3-night.webm',
      's5.mp4',
      's5.png',
      's9-extra.mp4',
    ]);
    expect(media).toEqual({
      s0: { src: '/video/s0-hero-room.mp4', poster: '/video/s0-hero-room.jpg' },
      s3: { src: '/video/s3-night.webm' },
      s5: { src: '/video/s5.mp4', poster: '/video/s5.png' },
    });
  });

  it('ignores files that only look similar to a shot id', () => {
    expect(resolveMedia(['s10-long.mp4', 's1.mov', 's2-poster.jpg'])).toEqual({});
  });
});

describe('availableMedia', () => {
  it('treats a missing folder as no footage', () => {
    expect(availableMedia(join(tmpdir(), 'mamori-does-not-exist'))).toEqual({});
  });

  it('reads the folder it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mamori-video-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's2-talk.mp4'), '');
    expect(availableMedia(dir)).toEqual({ s2: { src: '/video/s2-talk.mp4' } });
  });
});
