const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PUBLIC_CONTENT_PATHS,
  createPublicContentCacheKey,
  purgePublicContentCache,
  serveWithPublicContentCache,
} = require('../dist/services/publicContentCache.service.js');

class MemoryCache {
  constructor() {
    this.entries = new Map();
    this.putResponses = [];
  }
  key(request) { return request.url; }
  async match(request) { return this.entries.get(this.key(request))?.clone(); }
  async put(request, response) {
    this.putResponses.push(response.clone());
    this.entries.set(this.key(request), response.clone());
  }
  async delete(request) { return this.entries.delete(this.key(request)); }
}

const options = (cache, ttlSeconds = 3600) => ({ cache, ttlSeconds, namespace: 'ASRGH' });

test('public cache miss queries origin and stores the successful response', async () => {
  const cache = new MemoryCache();
  let neonQueries = 0;
  const request = new Request('https://api.example.com/api/public/members');
  const response = await serveWithPublicContentCache(request, async () => {
    neonQueries += 1;
    return Response.json({ data: ['all', 'members'] });
  }, options(cache));
  assert.equal(neonQueries, 1);
  assert.deepEqual(await response.json(), { data: ['all', 'members'] });
  assert.equal(cache.entries.size, 1);
});

test('public cache hit does not query origin', async () => {
  const cache = new MemoryCache();
  const request = new Request('https://api.example.com/api/public/events');
  await cache.put(createPublicContentCacheKey(request, 'ASRGH'), Response.json({ cached: true }));
  let neonQueries = 0;
  const response = await serveWithPublicContentCache(request, async () => {
    neonQueries += 1;
    return Response.json({ cached: false });
  }, options(cache));
  assert.equal(neonQueries, 0);
  assert.deepEqual(await response.json(), { cached: true });
});

test('cache expiry uses the configured TTL', async () => {
  const cache = new MemoryCache();
  await serveWithPublicContentCache(
    new Request('https://api.example.com/api/public/settings'),
    async () => Response.json({ ok: true }),
    options(cache, 300),
  );
  assert.equal(cache.putResponses[0].headers.get('cache-control'), 'public, max-age=300');
});

test('publish invalidates every public-content key and next request is fresh', async () => {
  const cache = new MemoryCache();
  for (const path of PUBLIC_CONTENT_PATHS) {
    await cache.put(createPublicContentCacheKey(path, 'ASRGH'), Response.json({ stale: true }));
  }
  await purgePublicContentCache({ cache, namespace: 'ASRGH' });
  assert.equal(cache.entries.size, 0);
  let neonQueries = 0;
  const response = await serveWithPublicContentCache(
    new Request('https://api.example.com/api/public/content'),
    async () => { neonQueries += 1; return Response.json({ fresh: true }); },
    options(cache),
  );
  assert.equal(neonQueries, 1);
  assert.deepEqual(await response.json(), { fresh: true });
});

test('admin and private endpoints are never cached', async () => {
  const cache = new MemoryCache();
  let calls = 0;
  for (const path of ['/api/admin/portal/state', '/api/auth/login', '/api/admin/staff']) {
    await serveWithPublicContentCache(
      new Request(`https://api.example.com${path}`),
      async () => { calls += 1; return Response.json({ ok: true }); },
      options(cache),
    );
  }
  assert.equal(calls, 3);
  assert.equal(cache.entries.size, 0);
});

test('cache read and write failure falls back to the origin response', async () => {
  const cache = {
    async match() { throw new Error('cache unavailable'); },
    async put() { throw new Error('cache unavailable'); },
    async delete() { throw new Error('cache unavailable'); },
  };
  let neonQueries = 0;
  const response = await serveWithPublicContentCache(
    new Request('https://api.example.com/api/public/members'),
    async () => { neonQueries += 1; return Response.json({ available: true }); },
    options(cache),
  );
  assert.equal(neonQueries, 1);
  assert.deepEqual(await response.json(), { available: true });
  await assert.rejects(() => purgePublicContentCache({ cache, namespace: 'ASRGH' }));
});
