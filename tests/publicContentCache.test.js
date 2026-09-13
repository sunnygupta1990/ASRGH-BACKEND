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
const productionOrigin = 'https://aggarwalsabha.co.in';
const workersOrigin = 'https://asrgh.sunnygupta1990.workers.dev';

function originRequest(path, origin = productionOrigin) {
  return new Request(`https://api.example.com${path}`, {
    headers: origin ? { Origin: origin } : undefined,
  });
}

test('public cache miss queries origin and stores the successful response', async () => {
  const cache = new MemoryCache();
  let neonQueries = 0;
  const request = originRequest('/api/public/members');
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
  const request = originRequest('/api/public/events');
  await cache.put(createPublicContentCacheKey(request, 'ASRGH'), Response.json({ cached: true }));
  let neonQueries = 0;
  const response = await serveWithPublicContentCache(request, async () => {
    neonQueries += 1;
    return Response.json({ cached: false });
  }, options(cache));
  assert.equal(neonQueries, 0);
  assert.deepEqual(await response.json(), { cached: true });
});

test('different request origins never share a public cache entry', async () => {
  const cache = new MemoryCache();
  let neonQueries = 0;

  const productionRequest = originRequest('/api/public/content', productionOrigin);
  const workersRequest = originRequest('/api/public/content', workersOrigin);

  const first = await serveWithPublicContentCache(productionRequest, async () => {
    neonQueries += 1;
    return new Response(JSON.stringify({ source: 'production' }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': productionOrigin,
      },
    });
  }, options(cache));
  assert.equal(first.headers.get('access-control-allow-origin'), productionOrigin);

  const second = await serveWithPublicContentCache(workersRequest, async () => {
    neonQueries += 1;
    return new Response(JSON.stringify({ source: 'workers' }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': workersOrigin,
      },
    });
  }, options(cache));
  assert.equal(second.headers.get('access-control-allow-origin'), workersOrigin);
  assert.equal(neonQueries, 2);
  assert.equal(cache.entries.size, 2);

  const productionHit = await serveWithPublicContentCache(productionRequest, async () => {
    throw new Error('production cache should have been hit');
  }, options(cache));
  assert.equal(productionHit.headers.get('access-control-allow-origin'), productionOrigin);
});

test('requests without an Origin header use a separate cache partition', async () => {
  const cache = new MemoryCache();
  const noOriginRequest = originRequest('/api/public/settings', null);
  const browserRequest = originRequest('/api/public/settings', productionOrigin);

  assert.notEqual(
    createPublicContentCacheKey(noOriginRequest, 'ASRGH').url,
    createPublicContentCacheKey(browserRequest, 'ASRGH').url,
  );
});

test('cache expiry uses the configured TTL and v2 namespace marker', async () => {
  const cache = new MemoryCache();
  await serveWithPublicContentCache(
    originRequest('/api/public/settings'),
    async () => Response.json({ ok: true }),
    options(cache, 300),
  );
  assert.equal(cache.putResponses[0].headers.get('cache-control'), 'public, max-age=300');
  assert.equal(cache.putResponses[0].headers.get('x-asrgh-cache-namespace'), 'public-content-v2');
});

test('publish invalidates every public-content key for every configured origin', async () => {
  const cache = new MemoryCache();
  const origins = [productionOrigin, workersOrigin];

  for (const path of PUBLIC_CONTENT_PATHS) {
    await cache.put(createPublicContentCacheKey(path, 'ASRGH'), Response.json({ stale: true }));
    for (const origin of origins) {
      await cache.put(createPublicContentCacheKey(path, 'ASRGH', origin), Response.json({ stale: true }));
    }
  }

  await purgePublicContentCache({ cache, namespace: 'ASRGH', origins });
  assert.equal(cache.entries.size, 0);

  let neonQueries = 0;
  const response = await serveWithPublicContentCache(
    originRequest('/api/public/content'),
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
    originRequest('/api/public/members'),
    async () => { neonQueries += 1; return Response.json({ available: true }); },
    options(cache),
  );
  assert.equal(neonQueries, 1);
  assert.deepEqual(await response.json(), { available: true });
  await assert.rejects(() => purgePublicContentCache({
    cache,
    namespace: 'ASRGH',
    origins: [productionOrigin, workersOrigin],
  }));
});
