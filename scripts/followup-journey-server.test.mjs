import assert from 'node:assert/strict';
import test from 'node:test';
import { installJourneyClock } from './followup-journey-server.mjs';

test('journey clock advances constructors and captured now functions without rewriting stored dates', () => {
  const RealDate = Date,
    before = new Date('2026-10-07T00:00:00Z');
  const clock = installJourneyClock();
  try {
    const capturedNow = Date.now;
    const start = Date.now();
    clock.advance(3);
    assert.ok(capturedNow() - start >= 3 * 86_400_000);
    assert.ok(new Date().getTime() - start >= 3 * 86_400_000);
    assert.equal(new Date(before).getTime(), before.getTime());
    assert.ok(new Date() instanceof RealDate);
    assert.throws(() => clock.advance(-1));
    assert.throws(() => clock.advance(8));
    assert.throws(() => clock.advance('3'));
  } finally {
    clock.restore();
  }
  assert.equal(Date, RealDate);
});
