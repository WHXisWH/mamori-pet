import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HelpResourcesRes } from '@ijime/api-types';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { describe, expect, it } from 'vitest';

import { createApp, SERVICE_NAME } from './app.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const kb = Kb.load(new FsKbSource(KB_DIR));
const app = createApp({ getKb: () => kb, allowedOrigins: ['http://localhost:3000'] });

describe('api', () => {
  it('answers /healthz and /readyz', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('GET /v1/child/help-resources returns the 4 hotlines without auth', async () => {
    const res = await app.request('/v1/child/help-resources');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('public');
    const body = (await res.json()) as HelpResourcesRes;
    expect(body.version).toMatch(/^0\.1\.0\//);
    expect(body.resources.map((r) => r.name)).toEqual([
      '24時間子供SOSダイヤル',
      'チャイルドライン',
      '児童相談所虐待対応ダイヤル',
      '警察・救急',
    ]);
    expect(body.resources.find((r) => r.id === 'sos_dial')?.phone).toBe('0120-0-78310');
    for (const r of body.resources) expect(r.audience.length).toBeGreaterThan(0);
  });

  it('allows the child-web origin and rejects others', async () => {
    const ok = await app.request('/v1/child/help-resources', {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    const bad = await app.request('/v1/child/help-resources', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('reports not ready when the knowledge base fails to load', async () => {
    const broken = createApp({
      getKb: () => Promise.reject(new Error('no kb')),
      allowedOrigins: [],
    });
    expect((await broken.request('/readyz')).status).toBe(503);
    const res = await broken.request('/v1/child/help-resources');
    expect(res.status).toBe(500);
  });
});
