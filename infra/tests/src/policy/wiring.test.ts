import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Terraform の push 先 URL とキュー名はサービスのコードと一致させる。ずれるとメッセージはデッドレターに入るだけになる
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tf = (name: string) => readFileSync(join(root, 'infra/terraform', name), 'utf8');

function sourceUnder(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, dir, 'src'));
  return out.join('\n');
}
const serviceSource = (svc: string) => sourceUnder(join('services', svc));

// サブスクリプションはあるが、サービス側が未実装の push（いまは無し）
const NOT_YET_IMPLEMENTED = new Set<string>();

const subscriptions = [
  ...tf('locals.tf').matchAll(
    /"([^"]+)"\s*=\s*\{\s*topic\s*=\s*"([^"]+)",\s*subscriber\s*=\s*"([^"]+)",\s*path\s*=\s*"([^"]+)"\s*\}/g,
  ),
].map(([, key, topic, subscriber, path]) => ({
  key: key!,
  topic: topic!,
  subscriber: subscriber!,
  path: path!,
}));

describe('Terraform wiring matches service code', () => {
  it('declares TTL for quota counters and idempotency receipts', () => {
    for (const collection of ['chatUsage', 'toolUsage', 'toolReceipts', 'toolBudgets']) {
      expect(tf('firestore.tf')).toMatch(new RegExp(`${collection}\\s*=\\s*"expireAt"`));
    }
    for (const collection of [
      'memoryProposals',
      'pairingCodeLookup',
      'pairingAttempts',
      'invitations',
      'invitationLookup',
      'petRequests',
      'jobRuns',
    ]) {
      expect(tf('firestore.tf')).toMatch(new RegExp(`${collection}\\s*=\\s*"expiresAt"`));
    }
  });

  it('indexes device token ownership without configuring token strings as TTL timestamps', () => {
    const source = tf('firestore.tf');
    const ttl = /ttl_fields\s*=\s*\{([^}]+)\}/.exec(source)?.[1];
    const indexes = /collection_group_fields\s*=\s*\{([^}]+)\}/.exec(source)?.[1];
    expect(ttl).not.toContain('fcmToken');
    expect(ttl).not.toMatch(/\bdevices\b/);
    expect(indexes).toMatch(/devices\s*=\s*"fcmToken"/);
  });

  it('parses the subscriptions', () => {
    expect(subscriptions.length).toBeGreaterThan(5);
  });

  it.each(subscriptions)('$key pushes to a path the subscriber registers', (s) => {
    const registered = serviceSource(s.subscriber).includes(`'${s.path}'`);
    expect(registered, `${s.subscriber} ${s.path}`).toBe(!NOT_YET_IMPLEMENTED.has(s.key));
  });

  it('every queue the services enqueue to exists', () => {
    const declared = new Set(
      [...tf('tasks.tf').matchAll(/name\s*=\s*"([a-z-]+)"/g)].map((m) => m[1]),
    );
    const used = [
      'services/notifier',
      'services/risk-engine',
      'services/api',
      'services/voice-relay',
      'packages/service-kit',
    ].flatMap((dir) => [...sourceUnder(dir).matchAll(/queue:\s*'([a-z-]+)'/g)].map((m) => m[1]!));
    expect(used).toContain('crisis-recheck');
    expect(used.length).toBeGreaterThan(0);
    for (const q of used) expect(declared, q).toContain(q);
  });

  it('the weekly report scheduler hits the notifier job endpoint', () => {
    const uri = /uri\s*=\s*"\$\{local\.service_urls\["notifier"\]\}([^"]+)"/.exec(
      tf('scheduler.tf'),
    );
    expect(uri?.[1]).toBeDefined();
    expect(serviceSource('notifier')).toContain(`'${uri![1]}'`);
  });
});
