import { resolve } from 'node:path';

import { FsKbSource, Kb } from '@ijime/kb-loader';

export const DEFAULT_KB_DIR = 'kb/v0.1.0';

let loading: Promise<Kb> | undefined;

export function loadKb(dir = process.env['KB_LOCAL_DIR'] ?? DEFAULT_KB_DIR): Promise<Kb> {
  loading ??= Kb.load(new FsKbSource(resolve(dir)));
  return loading;
}

export function resetKbForTests(): void {
  loading = undefined;
}
