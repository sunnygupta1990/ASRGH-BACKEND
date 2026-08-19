const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createPublicationRouter } = require('../dist/routes/publication.js');

process.env.JWT_SECRET = 'publication-test-secret';

async function startServer(isSystemRole, publish) {
  const app = express();
  app.use((req, _res, next) => {
    req.prisma = {
      adminUser: {
        findFirst: async () => ({
          roles: [{ role: {
            isActive: true,
            isSystemRole,
            organizationId: 'org-1',
            name: isSystemRole ? 'System Administrator' : 'Editor',
            permissions: [],
          } }],
        }),
      },
    };
    next();
  });
  app.use('/api/admin/public-content', createPublicationRouter(publish));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  return server;
}

function token() {
  return jwt.sign({ userId: 'user-1', organizationId: 'org-1' }, process.env.JWT_SECRET);
}

test('non-super-admin cannot publish', async (t) => {
  let publishes = 0;
  const server = await startServer(false, async () => { publishes += 1; });
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/admin/public-content/publish`, {
    method: 'POST', headers: { authorization: `Bearer ${token()}` },
  });
  assert.equal(response.status, 403);
  assert.equal(publishes, 0);
});

test('super-admin can publish and invalidation failure is reported', async (t) => {
  const successful = await startServer(true, async () => {});
  t.after(() => successful.close());
  let response = await fetch(`http://127.0.0.1:${successful.address().port}/api/admin/public-content/publish`, {
    method: 'POST', headers: { authorization: `Bearer ${token()}` },
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).data.publishedAt);

  const failing = await startServer(true, async () => { throw new Error('purge failed'); });
  t.after(() => failing.close());
  response = await fetch(`http://127.0.0.1:${failing.address().port}/api/admin/public-content/publish`, {
    method: 'POST', headers: { authorization: `Bearer ${token()}` },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).success, false);
});
