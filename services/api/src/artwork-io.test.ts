import { limits } from '@ijime/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  signed: vi.fn(),
  save: vi.fn(),
  file: vi.fn(),
}));
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file: mocks.file.mockReturnValue({
          save: mocks.save,
          getMetadata: mocks.metadata,
          getSignedUrl: mocks.signed,
        }),
      };
    }
  },
}));
import {
  ARTWORK_URL_TTL_MS,
  GcsArtworkImages,
  isBoundedArtworkPng,
  MemoryArtworkImages,
} from './artwork-io.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',
  'base64',
);
const path = 'families/f/children/c/artworks/a.png';
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('artwork image reads', () => {
  it('validates PNG header, positive dimensions and byte/edge ceilings', () => {
    expect(isBoundedArtworkPng(PNG)).toBe(true);
    expect(isBoundedArtworkPng(Buffer.from('<svg/>'))).toBe(false);
    expect(isBoundedArtworkPng(Buffer.alloc(limits.artworkImageMaxBytes + 1))).toBe(false);
    for (const dimension of [0, limits.artworkImageMaxEdgePx + 1]) {
      const png = Buffer.from(PNG);
      png.writeUInt32BE(dimension, 16);
      expect(isBoundedArtworkPng(png)).toBe(false);
    }
    const badHeader = Buffer.from(PNG);
    badHeader.writeUInt32BE(1, 8);
    expect(isBoundedArtworkPng(badHeader)).toBe(false);
  });

  it('only returns bounded local PNGs at canonical, unexpired paths', async () => {
    const store = new MemoryArtworkImages();
    await store.save(path, PNG);
    const expires = new Date(Date.now() + 300_000);
    expect(await store.readUrl(path, expires)).toBe(
      `data:image/png;base64,${PNG.toString('base64')}`,
    );
    expect(await store.readUrl(path, new Date(1))).toBeUndefined();
    expect(await store.readUrl('../a.png', expires)).toBeUndefined();
    expect(
      await store.readUrl('families/f/children/c/artworks/missing.png', expires),
    ).toBeUndefined();
    store.saved.set(path, Buffer.from('<svg/>'));
    expect(await store.readUrl(path, expires)).toBeUndefined();
  });

  it('signs GCS PNG reads for at most five minutes and never beyond artwork expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    mocks.metadata.mockResolvedValue([{ size: PNG.length, contentType: 'image/png' }]);
    mocks.signed.mockResolvedValue(['https://storage.example.test/signed']);
    const store = new GcsArtworkImages('configured-not-real');
    expect(await store.readUrl(path, new Date(Date.now() + 600_000))).toContain('/signed');
    expect(mocks.signed).toHaveBeenLastCalledWith({
      version: 'v4',
      action: 'read',
      expires: Date.now() + ARTWORK_URL_TTL_MS,
      responseType: 'image/png',
    });
    await store.readUrl(path, new Date(Date.now() + 1000));
    expect(mocks.signed.mock.calls.at(-1)![0].expires).toBe(Date.now() + 1000);
  });

  it.each([
    { size: limits.artworkImageMaxBytes + 1, contentType: 'image/png' },
    { size: 100, contentType: 'image/svg+xml' },
    { size: 'NaN', contentType: 'image/png' },
  ])('does not sign invalid storage metadata %j', async (metadata) => {
    mocks.metadata.mockResolvedValue([metadata]);
    const store = new GcsArtworkImages('configured-not-real');
    expect(await store.readUrl(path, new Date(Date.now() + 300_000))).toBeUndefined();
    expect(mocks.signed).not.toHaveBeenCalled();
  });
});
