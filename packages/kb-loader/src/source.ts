import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface KbSource {
  list(): Promise<string[]>;
  read(path: string): Promise<Buffer>;
}

export class FsKbSource implements KbSource {
  constructor(private readonly rootDir: string) {}

  async list(): Promise<string[]> {
    const entries = await readdir(this.rootDir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => relative(this.rootDir, join(e.parentPath, e.name)).split(sep).join('/'))
      .sort();
  }

  read(path: string): Promise<Buffer> {
    return readFile(join(this.rootDir, ...path.split('/')));
  }
}

type BucketLike = {
  getFiles(opts: { prefix: string }): Promise<[{ name: string }[]]>;
  file(name: string): { download(): Promise<[Buffer]> };
};

export class GcsKbSource implements KbSource {
  private readonly prefix: string;

  constructor(
    private readonly bucket: BucketLike,
    prefix: string,
  ) {
    this.prefix = prefix.replace(/\/+$/, '') + '/';
  }

  async list(): Promise<string[]> {
    const [files] = await this.bucket.getFiles({ prefix: this.prefix });
    return files
      .map((f) => f.name.slice(this.prefix.length))
      .filter((n) => n.length > 0 && !n.endsWith('/'))
      .sort();
  }

  async read(path: string): Promise<Buffer> {
    const [buf] = await this.bucket.file(this.prefix + path).download();
    return buf;
  }
}
