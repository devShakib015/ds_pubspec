'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPubDevClient } = require('../lib/pubdev');

function response(status, body, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const PKG = {
  latest: { version: '2.0.0', published: '2026-09-01T00:00:00Z' },
  versions: [{ version: '1.0.0' }, { version: '1.5.0', retracted: true }, { version: '2.0.0' }],
  isDiscontinued: true,
  replacedBy: 'better_pkg',
};

test('maps pub.dev JSON: latest, retracted versions, discontinued and replacement', async () => {
  const client = createPubDevClient({ fetch: async () => response(200, PKG) });
  const info = await client.packageInfo('old_pkg');
  assert.deepEqual(info, {
    name: 'old_pkg', latest: '2.0.0', isDiscontinued: true, replacedBy: 'better_pkg',
    retracted: ['1.5.0'], published: '2026-09-01T00:00:00Z',
  });
});

test('a 404 is "no such package", not an error', async () => {
  const client = createPubDevClient({ fetch: async () => response(404, {}) });
  assert.equal(await client.packageInfo('nope'), null);
});

test('backs off on 429 and honours Retry-After', async () => {
  const waits = [];
  let calls = 0;
  const client = createPubDevClient({
    sleep: async (ms) => { waits.push(ms); },
    fetch: async () => (++calls < 3 ? response(429, {}, { 'retry-after': '2' }) : response(200, PKG)),
  });
  const info = await client.packageInfo('busy');
  assert.equal(info.latest, '2.0.0');
  assert.deepEqual(waits, [2000, 2000]);
});

test('caches for the TTL, refetches after it, and shares one request between callers', async () => {
  let calls = 0;
  let clock = 0;
  const client = createPubDevClient({
    now: () => clock, ttlMs: 1000,
    fetch: async () => { calls++; return response(200, PKG); },
  });
  await Promise.all([client.packageInfo('a'), client.packageInfo('a'), client.packageInfo('a')]);
  assert.equal(calls, 1, 'concurrent callers share the request');
  clock = 999;
  await client.packageInfo('a');
  assert.equal(calls, 1, 'fresh within the TTL');
  clock = 1001;
  await client.packageInfo('a');
  assert.equal(calls, 2, 'refetched after the TTL');
});

test('never runs more requests at once than the pool allows', async () => {
  let running = 0;
  let peak = 0;
  const client = createPubDevClient({
    concurrency: 2,
    fetch: async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return response(200, PKG);
    },
  });
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => client.packageInfo(n)));
  assert.equal(peak, 2);
});
