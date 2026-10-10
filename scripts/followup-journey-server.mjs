import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createManualRuntime, preflight, startServices, workerEnv } from './manual-preview.mjs';

// Test-process-only clock: requests, workers and ADK share the same virtual date.
// It is never imported into a production service or the ordinary manual preview.
export function installJourneyClock() {
  const RealDate = globalThis.Date;
  let offset = 0;
  const now = () => RealDate.now() + offset;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [now()]);
    },
    apply() {
      return new RealDate(now()).toString();
    },
    get(target, key) {
      return key === 'now' ? now : Reflect.get(target, key);
    },
  });
  return {
    now,
    advance(days) {
      if (
        !Number.isFinite(days) ||
        days < 0 ||
        days > 7 ||
        offset + days * 86_400_000 > 120 * 86_400_000
      )
        throw new Error('invalid_time_advance');
      offset += days * 86_400_000;
      return new Date().toISOString();
    },
    restore() {
      globalThis.Date = RealDate;
    },
  };
}

export async function main() {
  const key = process.env.LOCAL_JOURNEY_KEY;
  if (process.argv.at(-1) !== '--run' || !key || key.length < 24)
    throw new Error('journey_opt_in_required');
  const config = preflight(process.env);
  if (config.voiceEnabled) throw new Error('journey_voice_must_be_disabled');
  const clean = workerEnv(process.env, config.adcPath);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, clean);
  const clock = installJourneyClock();
  const runtime = await createManualRuntime({ project: `demo-manual-${randomUUID()}` });
  runtime.app.post('/local/test-clock', async (c) => {
    const supplied = Buffer.from(c.req.header('X-Local-Test-Key') ?? '');
    const expected = Buffer.from(key);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json().catch(() => null);
    if (!body || Object.keys(body).some((field) => field !== 'advanceDays'))
      return c.json({ error: 'invalid_time_advance' }, 400);
    try {
      const now = clock.advance(body.advanceDays);
      await runtime.drain();
      return c.json({ now, ...runtime.getStatus() });
    } catch {
      return c.json({ error: 'invalid_time_advance' }, 400);
    }
  });
  const server = await startServices(runtime);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(
      signal,
      () =>
        void server.close().finally(() => {
          clock.restore();
          process.exit();
        }),
    );
  process.stdout.write(
    JSON.stringify({
      ready: true,
      api: runtime.ports.api,
      realGemini: true,
      externalDelivery: false,
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write('Journey server failed; check explicit test configuration and builds.\n');
    process.exitCode = 1;
  });
