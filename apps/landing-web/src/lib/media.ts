import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveMedia, type MediaMap } from './media-shared';

export * from './media-shared';

let cached: MediaMap | undefined;

export function availableMedia(dir = join(process.cwd(), 'public', 'video')): MediaMap {
  if (cached && process.env.NODE_ENV === 'production') return cached;
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    files = [];
  }
  cached = resolveMedia(files);
  return cached;
}
