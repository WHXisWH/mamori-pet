import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isLocalManualPreview, loadEnv } from './env.js';
import { PENDING_DECISIONS } from './pending.js';
import * as values from './values.js';

const here = dirname(fileURLToPath(import.meta.url));

function resolveKey(key: string): unknown {
  const [group, field] = key.split('.');
  const obj = (values as Record<string, unknown>)[group!];
  if (field === '*') return obj;
  return (obj as Record<string, unknown> | undefined)?.[field!];
}

describe('pending decisions', () => {
  it('every registered key exists in values', () => {
    for (const d of PENDING_DECISIONS) {
      expect(resolveKey(d.key), d.key).not.toBeUndefined();
    }
  });

  it('every entry cites a docs/ section', () => {
    for (const d of PENDING_DECISIONS) {
      expect(d.source, d.key).toMatch(/docs\/0[1-5]-[a-z-]+\.md/);
    }
  });

  it('every TODO(未定|推奨値) comment in values.ts is registered', () => {
    const src = readFileSync(join(here, 'values.ts'), 'utf8');
    const lines = src.split('\n');
    const registered = new Set(PENDING_DECISIONS.map((d) => d.key));
    let group = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const g = /^export const (\w+)[:= ]/.exec(line);
      if (g) group = g[1]!;
      if (!/TODO\((未定|推奨値)\)/.test(line)) continue;
      let j = i + 1;
      while (j < lines.length && /^\s*\/\//.test(lines[j]!)) j++;
      const next = lines[j] ?? '';
      const exported = /^export const (\w+)/.exec(next)?.[1];
      const field = /^\s*(\w+):/.exec(next)?.[1];
      const key = exported ? `${exported}.*` : field ? `${group}.${field}` : `${group}.*`;
      const ok = registered.has(key) || registered.has(`${group}.*`);
      expect(ok, `${key} (line ${i + 1}) not registered in PENDING_DECISIONS`).toBe(true);
    }
  });
});

describe('values', () => {
  it('region is Tokyo', () => {
    expect(values.REGION).toBe('asia-northeast1');
    expect(values.TIMEZONE).toBe('Asia/Tokyo');
  });

  it('crisis review failure is treated as a hit', () => {
    expect(values.models.crisisReview.onFailure).toBe('treat_as_hit');
    expect(values.models.crisisReview.timeoutMs).toBe(values.crisis.reviewTimeoutMs);
  });

  it('uses one realistic deadline per safety stage, distinct from the response SLO', () => {
    expect(values.crisis.screenTimeoutMs).toBe(8000);
    expect(values.crisis.reviewTimeoutMs).toBe(15000);
    expect(values.models.crisisScreen.timeoutMs).toBe(values.crisis.screenTimeoutMs);
    expect(values.models.petChat.timeoutMs).toBe(values.agent.turnTimeoutMs);
    expect(values.slo.firstTokenTargetMs).toBe(2000);
  });

  it('cold start is 28 days', () => {
    expect(values.risk.coldStartDays).toBe(28);
  });
});

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(8080);
    expect(env.GCP_REGION).toBe('asia-northeast1');
  });

  it('rejects a non-Tokyo region in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', GCP_REGION: 'us-central1' })).toThrow(
      /asia-northeast1/,
    );
  });

  it('rejects an invalid port', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('local manual preview', () => {
  const manual = {
    NODE_ENV: 'test',
    LOCAL_MANUAL_PREVIEW: '1',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:9295',
  };

  it('requires an explicit non-production local emulator', () => {
    expect(isLocalManualPreview(manual)).toBe(true);
    expect(isLocalManualPreview({ ...manual, NODE_ENV: 'development' })).toBe(true);
    expect(isLocalManualPreview({ ...manual, FIRESTORE_EMULATOR_HOST: 'localhost:9295' })).toBe(
      true,
    );
    for (const change of [
      { NODE_ENV: 'production' },
      { NODE_ENV: '' },
      { LOCAL_MANUAL_PREVIEW: '' },
      { FIRESTORE_EMULATOR_HOST: '' },
      { FIRESTORE_EMULATOR_HOST: 'remote.test:9295' },
      { FIRESTORE_EMULATOR_HOST: '127.0.0.1:0' },
      { FIRESTORE_EMULATOR_HOST: '127.0.0.1:65536' },
      { FIRESTORE_EMULATOR_HOST: '127.0.0.1:9295/path' },
    ])
      expect(isLocalManualPreview({ ...manual, ...change })).toBe(false);
  });
});
