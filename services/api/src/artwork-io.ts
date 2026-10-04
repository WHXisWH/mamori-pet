import { cloudRunIdToken } from '@ijime/service-kit';
import { limits } from '@ijime/config';

// 原画は、子どもが保存を選んだときだけ artworks バケットに書き込む（docs/03-database.md：families/{f}/children/{c}/artworks/{id}.png）
export interface ArtworkImageStore {
  save(path: string, png: Buffer): Promise<void>;
  // Called only after guardian/child/share checks. Existing write-only fixtures remain valid.
  readUrl?(path: string, expiresAt: Date): Promise<string | undefined>;
}

export const ARTWORK_URL_TTL_MS = 5 * 60_000;
const IMAGE_PATH =
  /^families\/[A-Za-z0-9_-]{1,128}\/children\/[A-Za-z0-9_-]{1,128}\/artworks\/[A-Za-z0-9_-]{1,128}\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Header/size validation, not a complete PNG decoder. Never serve another media type as data PNG.
export function isBoundedArtworkPng(png: Buffer): boolean {
  if (
    png.length < 33 ||
    png.length > limits.artworkImageMaxBytes ||
    !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  )
    return false;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 && Math.max(width, height) <= limits.artworkImageMaxEdgePx;
}

export class MemoryArtworkImages implements ArtworkImageStore {
  readonly saved = new Map<string, Buffer>();
  async save(path: string, png: Buffer): Promise<void> {
    this.saved.set(path, Buffer.from(png));
  }
  async readUrl(path: string, expiresAt: Date): Promise<string | undefined> {
    if (!IMAGE_PATH.test(path) || !(expiresAt.getTime() > Date.now())) return undefined;
    const png = this.saved.get(path);
    if (!png || !isBoundedArtworkPng(png)) return undefined;
    // Local-only adapter. Once delivered, data URLs cannot expire or be recalled.
    return `data:image/png;base64,${png.toString('base64')}`;
  }
}

export class GcsArtworkImages implements ArtworkImageStore {
  private readonly bucket: Promise<{
    file(path: string): {
      save(data: Buffer, opts: { contentType: string; resumable: boolean }): Promise<void>;
      getMetadata(): Promise<[{ size?: string | number; contentType?: string }, ...unknown[]]>;
      getSignedUrl(opts: {
        version: 'v4';
        action: 'read';
        expires: number;
        responseType: string;
      }): Promise<[string]>;
    };
  }>;

  constructor(bucketName: string) {
    this.bucket = import('@google-cloud/storage').then(({ Storage }) =>
      new Storage().bucket(bucketName),
    );
  }

  async save(path: string, png: Buffer): Promise<void> {
    await (await this.bucket).file(path).save(png, { contentType: 'image/png', resumable: false });
  }

  async readUrl(path: string, expiresAt: Date): Promise<string | undefined> {
    const expires = Math.min(expiresAt.getTime(), Date.now() + ARTWORK_URL_TTL_MS);
    if (!IMAGE_PATH.test(path) || !Number.isFinite(expires) || expires <= Date.now())
      return undefined;
    const file = (await this.bucket).file(path);
    const [meta] = await file.getMetadata();
    const bytes = Number(meta.size);
    if (
      meta.contentType !== 'image/png' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 33 ||
      bytes > limits.artworkImageMaxBytes ||
      expires <= Date.now()
    )
      return undefined;
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires,
      responseType: 'image/png',
    });
    return url;
  }
}

export type ArtworkFeatureRequest = {
  familyId: string;
  childId: string;
  artworkId: string;
  image: { mimeType: 'image/png'; data: string };
};

// 提出リクエストの中で、原画（メモリ上のみ）を signal-worker に渡して特徴を抽出する
export type ArtworkFeatureClient = (req: ArtworkFeatureRequest) => Promise<void>;

export function httpArtworkFeatureClient(
  baseUrl: string,
  opts: { timeoutMs: number; idToken?: () => Promise<string | undefined> },
  fetchImpl: typeof fetch = fetch,
): ArtworkFeatureClient {
  return async (req) => {
    const token = await opts.idToken?.();
    const res = await fetchImpl(`${baseUrl}/internal/artworks/features`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`signal-worker responded ${res.status}`);
  };
}

export function signalWorkerClientFromEnv(prod: boolean, timeoutMs: number): ArtworkFeatureClient {
  const url = process.env['SIGNAL_WORKER_URL'] ?? 'http://localhost:8084';
  return httpArtworkFeatureClient(url, {
    timeoutMs,
    ...(prod ? { idToken: cloudRunIdToken(url) } : {}),
  });
}
