import assert from 'node:assert/strict';
import test from 'node:test';
import { localEnvironment, localPorts } from './local-ports.mjs';

test('default ports remain compatible with the existing demo', () => {
  assert.deepEqual(localPorts({}), {
    child: 3100,
    guardian: 3101,
    api: 8080,
    pet: 8082,
    voice: 8083,
    firestore: 8095,
    hub: 4405,
    logging: 4505,
  });
});
test('one offset moves all services without collisions', () => {
  const original = localPorts({});
  const shifted = localPorts({ LOCAL_PORT_OFFSET: '100' });
  for (const [key, port] of Object.entries(original)) assert.equal(shifted[key], port + 100);
  assert.equal(new Set(Object.values(shifted)).size, Object.keys(shifted).length);
});
test('invalid offsets fail before binding a server', () => {
  for (const LOCAL_PORT_OFFSET of ['NaN', '-1', '1.5', '50001']) {
    assert.throws(() => localPorts({ LOCAL_PORT_OFFSET }), /LOCAL_PORT_OFFSET/);
  }
});

test('the documented offset does not collide with any default service', () => {
  const original = new Set(Object.values(localPorts({})));
  for (const port of Object.values(localPorts({ LOCAL_PORT_OFFSET: '200' }))) {
    assert.equal(original.has(port), false);
  }
});

test('build and startup derive the same browser URLs and isolated output directory', () => {
  assert.deepEqual(localEnvironment({ LOCAL_PORT_OFFSET: '100' }), {
    NEXT_DIST_DIR: '.next/local-3200',
    NEXT_PUBLIC_LOCAL_DEMO: '1',
    NEXT_PUBLIC_API_BASE_URL: 'http://localhost:8180',
    NEXT_PUBLIC_VOICE_WS_URL: 'ws://localhost:8183',
  });
  assert.equal(localEnvironment({}).NEXT_DIST_DIR, '.next/local-3100');
  assert.equal(
    localEnvironment({ NEXT_DIST_DIR: '.next/local-prd' }).NEXT_DIST_DIR,
    '.next/local-prd',
  );
  for (const NEXT_DIST_DIR of ['../outside', '.next', '.next/prd', '.next/local-a/b'])
    assert.throws(() => localEnvironment({ NEXT_DIST_DIR }), /NEXT_DIST_DIR/);
});
