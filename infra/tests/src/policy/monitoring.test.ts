import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crisis, pilot } from '@ijime/config';
import { describe, expect, it } from 'vitest';

// アラートと予算は構造化ログのイベント名と packages/config のパイロット値に依存する。どちらかで名前や値を変えたら両方を合わせる
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tf = (name: string) => readFileSync(join(root, 'infra/terraform', name), 'utf8');

function sources(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'services'));
  walk(join(root, 'packages'));
  return out.join('\n');
}

const monitoring = tf('monitoring.tf');
const variables = tf('variables.tf');

function variableDefault(name: string): string {
  const block = new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*([^\\n]+)`).exec(
    variables,
  );
  expect(block, name).not.toBeNull();
  return block![1]!.trim();
}

function threshold(name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*([0-9.]+)`).exec(monitoring);
  expect(m, name).not.toBeNull();
  return Number(m![1]);
}

describe('monitoring matches service code and pilot targets', () => {
  it('every log event an alert depends on is emitted by some service', () => {
    const events = new Set(
      [...monitoring.matchAll(/\\?"((?:crisis|notify|chat|voice)\.[a-z_]+)\\?"/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(events.size).toBeGreaterThan(5);
    const src = sources();
    for (const e of events) expect(src.includes(`'${e}'`), e).toBe(true);
  });

  // 逆方向：危機対応経路で error として出すイベントにはすべてアラートが必要。そうしないと保護者に通知が届かないときに誰も気づけない
  it('every crisis error event emitted by a service is alerted', () => {
    const src = sources();
    const emitted = new Set(
      [...src.matchAll(/(?:\.error|logError)\(\s*'(crisis\.[a-z_]+)'/g)].map((m) => m[1]!),
    );
    expect(emitted.size).toBeGreaterThan(3);
    for (const e of emitted) expect(monitoring.includes(`"${e}"`), e).toBe(true);
  });

  it('crisis.check carries the method values the alerts filter on', () => {
    const detector = readFileSync(join(root, 'packages/crisis-detector/src/detector.ts'), 'utf8');
    for (const method of monitoring.matchAll(/metric\.label\.method=\\"([a-z_]+)\\"/g)) {
      expect(detector).toContain(`'${method[1]}'`);
    }
  });

  it('latency thresholds equal the pilot targets', () => {
    expect(threshold('first_token_p95_ms')).toBe(pilot.firstTokenP95Ms);
    expect(threshold('crisis_check_p95_ms')).toBe(pilot.crisisCheckP95Ms);
    expect(threshold('crisis_notify_late_ms')).toBe(crisis.notifyWithinSeconds * 1000);
  });

  it('budget defaults equal the pilot budget', () => {
    expect(Number(variableDefault('budget_amount_jpy'))).toBe(pilot.monthlyBudgetJpy);
    expect(JSON.parse(variableDefault('budget_alert_thresholds'))).toEqual(
      pilot.budgetAlertThresholds,
    );
    expect(pilot.budgetAlertThresholds.at(-1)).toBe(pilot.voiceBreakerThreshold);
  });

  it('the budget-alerts push lands on a path notifier registers', () => {
    const sub =
      /resource "google_pubsub_subscription" "budget_alerts_notifier" \{[\s\S]*?push_endpoint\s*=\s*"\$\{google_cloud_run_v2_service\.svc\["(\w[\w-]*)"\]\.uri\}([^"]+)"/.exec(
        monitoring,
      );
    expect(sub).not.toBeNull();
    expect(sub![1]).toBe('notifier');
    const budget = readFileSync(join(root, 'services/notifier/src/budget.ts'), 'utf8');
    expect(budget).toContain(`BUDGET_ALERT_PATH = '${sub![2]}'`);
    const app = readFileSync(join(root, 'services/notifier/src/app.ts'), 'utf8');
    expect(app).toMatch(/registerPushHandler\(app, BUDGET_ALERT_PATH/);
  });

  it('background queues stay under half of the Flash quota', () => {
    const tasks = tf('tasks.tf');
    for (const q of ['crisis_recheck', 'proactive_turns']) {
      const rate = new RegExp(
        `resource "google_cloud_tasks_queue" "${q}"[\\s\\S]*?max_dispatches_per_second\\s*=\\s*([0-9.]+)`,
      ).exec(tasks);
      expect(rate, q).not.toBeNull();
      expect(Number(rate![1]) * 60, q).toBeLessThanOrEqual(pilot.flashRequestsPerMinute / 2);
    }
  });
});
