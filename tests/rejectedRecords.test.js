const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { manageRejectedRecord, clearClosedRejectedRecords, listRejectedRecords } = require('../dist/services/rejectedRecords.service');
const router = require('../dist/routes/adminOperations').default;
const audit = { organizationId: 'org-1', actorUserId: 'admin-1', actorRoleNames: ['Admin'] };
const id = '00000000-0000-4000-8000-000000000001';

function database(options = {}) {
  let state = {
    warnings: [{ id, organizationId: 'org-1', importRecordId: 'row-1', correctionStatus: 'open', correctedData: {}, rejectionReason: 'First Name is required', updatedAt: new Date(), ...options.warning }],
    row: { id: 'row-1', batchId: 'batch-1', organizationId: 'org-1', rowNumber: 2, sourceData: { 'Member Code': 'MEM-1', 'First Name': '' }, targetEntityId: null, ...options.row },
    batch: { id: 'batch-1', organizationId: 'org-1', entityType: 'members', acceptedRecords: 0, committedRecords: 0, rejectedRecords: 1, ...options.batch },
    members: [], logs: [],
  };
  const matches = (r, w = {}) => (!w.id || r.id === w.id) && (!w.organizationId || r.organizationId === w.organizationId)
    && (!w.updatedAt || r.updatedAt.getTime() === w.updatedAt.getTime())
    && (!w.correctionStatus || (typeof w.correctionStatus === 'string' ? r.correctionStatus === w.correctionStatus : w.correctionStatus.in.includes(r.correctionStatus)))
    && (!w.importRecord?.batch || w.importRecord.batch.entityType === state.batch.entityType)
    && (!w.importRecord || !Object.hasOwn(w.importRecord, 'targetEntityId') || state.row.targetEntityId === w.importRecord.targetEntityId);
  const included = r => r && structuredClone({ ...r, importRecord: { ...state.row, batch: state.batch } });
  const update = ({ where, data }) => { const r = state.warnings.find(r => matches(r, where)); if (!r) throw Error('Missing'); Object.assign(r, data); return included(r); };
  const db = {
    rejectedRecord: {
      findFirst: async ({ where }) => included(state.warnings.find(r => matches(r, where))),
      findMany: async ({ where, skip = 0, take = 50 }) => state.warnings.filter(r => matches(r, where)).slice(skip, skip + take).map(included),
      count: async ({ where }) => state.warnings.filter(r => matches(r, where)).length,
      update: async args => update(args),
      updateMany: async ({ where, data }) => { const rows = state.warnings.filter(r => matches(r, where)); rows.forEach(r => Object.assign(r, data)); return { count: rows.length }; },
      delete: async ({ where }) => { state.warnings = state.warnings.filter(r => !matches(r, where)); },
      deleteMany: async ({ where }) => { const count = state.warnings.filter(r => matches(r, where)).length; state.warnings = state.warnings.filter(r => !matches(r, where)); return { count }; },
    },
    member: {
      findMany: async () => state.members,
      create: async ({ data }) => { if (options.persistenceFailure) throw Error('private database detail'); state.members.push({ id: 'member-1', membershipStatus: 'active', ...data }); return { id: 'member-1' }; },
      update: async ({ data }) => { Object.assign(state.members[0], data); return { id: 'member-1' }; },
    },
    importRecord: { update: async ({ data }) => Object.assign(state.row, data) },
    importBatch: { update: async ({ data }) => { for (const [k, v] of Object.entries(data)) state.batch[k] += v.increment ?? -v.decrement; return state.batch; } },
    auditLog: { create: async ({ data }) => { if (options.auditFailure) throw Error('audit unavailable'); state.logs.push(data); } },
    $transaction: async fn => { const before = structuredClone(state); try { return await fn(db); } catch (e) { state = before; throw e; } },
  };
  return { db, state: () => state };
}

test('save preserves uploaded data; corrected retry imports once and resolves atomically', async () => {
  const { db, state } = database();
  await manageRejectedRecord(db, audit, id, 'save', { 'First Name': 'Asha' });
  assert.equal(state().row.sourceData['First Name'], '');
  const result = await manageRejectedRecord(db, audit, id, 'retry');
  assert.equal(result.outcome, 'imported');
  assert.equal(state().members[0].firstName, 'Asha');
  assert.equal(state().warnings[0].correctionStatus, 'resolved');
  assert.equal(state().batch.rejectedRecords, 0);
  assert.equal(state().batch.committedRecords, 1);
  await assert.rejects(manageRejectedRecord(db, audit, id, 'retry'), /already imported/);
  assert.equal(state().members.length, 1);
  assert.equal(state().logs.length, 2);
});

test('failed validation retains new reason and corrected values without relaxing date validation', async () => {
  const { db, state } = database();
  const result = await manageRejectedRecord(db, audit, id, 'retry', { 'First Name': 'Asha', 'Date of Birth': '2026-02-30' });
  assert.equal(result.outcome, 'failed');
  assert.match(result.record.rejectionReason, /YYYY-MM-DD/);
  assert.equal(state().warnings[0].correctionStatus, 'open');
  assert.equal(state().warnings[0].correctedData['Date of Birth'], '2026-02-30');
  assert.equal(state().members.length, 0);
  assert.deepEqual(state().row.validationErrors, ['Date of Birth must be YYYY-MM-DD']);
});

test('database failure keeps correction and safe new reason on the same warning', async () => {
  const { db, state } = database({ persistenceFailure: true });
  const result = await manageRejectedRecord(db, audit, id, 'retry', { 'First Name': 'Asha' });
  assert.equal(result.outcome, 'failed');
  assert.equal(state().warnings.length, 1);
  assert.equal(state().warnings[0].correctedData['First Name'], 'Asha');
  assert.match(state().warnings[0].rejectionReason, /Unable to save/);
  assert.equal(state().row.targetEntityId, null);
  assert.equal(state().logs.length, 1);
});

test('audit failure rolls back the imported entity and warning resolution', async () => {
  const { db, state } = database({ auditFailure: true });
  await assert.rejects(manageRejectedRecord(db, audit, id, 'retry', { 'First Name': 'Asha' }));
  assert.equal(state().members.length, 0);
  assert.equal(state().warnings[0].correctionStatus, 'open');
});

test('dismiss and delete retain original import history and audit both actions', async () => {
  const { db, state } = database();
  await manageRejectedRecord(db, audit, id, 'dismiss');
  assert.equal(state().warnings[0].correctionStatus, 'dismissed');
  assert.equal(state().members.length, 0);
  await manageRejectedRecord(db, audit, id, 'delete');
  assert.equal(state().warnings.length, 0);
  assert.ok(state().row.sourceData);
  assert.deepEqual(state().logs.map(l => l.action), ['IMPORT_REJECTION_DISMISS', 'IMPORT_REJECTION_DELETE']);
});

test('legacy dismissed-as-resolved rows can still be retried when never imported', async () => {
  const { db } = database({ warning: { correctionStatus: 'resolved' } });
  assert.equal((await manageRejectedRecord(db, audit, id, 'retry', { 'First Name': 'Asha' })).outcome, 'imported');
});

test('clear includes old closed warnings beyond 500 and protects open/other-organization rows', async () => {
  const { db, state } = database();
  state().warnings.push(...Array.from({ length: 550 }, (_, i) => ({ id: `old-${i}`, organizationId: 'org-1', correctionStatus: i % 2 ? 'resolved' : 'dismissed' })));
  state().warnings.push({ id: 'other', organizationId: 'org-2', correctionStatus: 'resolved' });
  assert.equal((await clearClosedRejectedRecords(db, audit, 'events')).count, 0);
  assert.equal((await clearClosedRejectedRecords(db, audit, 'all')).count, 550);
  assert.equal(state().warnings.length, 2);
});

test('list paginates old records and filters actual module/status/organization', async () => {
  const { db, state } = database();
  state().warnings.push(...Array.from({ length: 550 }, (_, i) => ({ id: `old-${i}`, organizationId: 'org-1', correctionStatus: 'open' })));
  const result = await listRejectedRecords(db, 'org-1', 'open', 'members', 11);
  assert.equal(result.total, 551);
  assert.equal(result.records.length, 50);
  assert.equal((await listRejectedRecords(db, 'org-1', 'closed', 'members', 1)).total, 0);
  assert.equal((await listRejectedRecords(db, 'org-1', 'all', 'events', 1)).total, 0);
});

test('all per-record actions reject another organization', async () => {
  const { db, state } = database({ warning: { organizationId: 'org-2' } });
  for (const action of ['save', 'retry', 'dismiss', 'delete']) await assert.rejects(manageRejectedRecord(db, audit, id, action), /not found/);
  assert.equal(state().logs.length, 0);
});

for (const [entityType, model, sourceData] of [
  ['events', 'event', { 'Event Code': 'EV-1', 'Event Title': 'Gathering', 'Event Date': '2026-10-10' }],
  ['social_work', 'socialWorkItem', { 'Activity Code': 'SW-1', Title: 'Education' }],
  ['announcements', 'announcement', { 'Announcement Code': 'AN-1', Title: 'Notice', Content: 'Meeting' }],
]) test(`retry reuses ${entityType} import persistence`, async () => {
  const { db, state } = database({ batch: { entityType }, row: { sourceData } });
  let written;
  db[model] = { findMany: async () => [], create: async ({ data }) => { written = data; return { id: 'entity-1' }; } };
  db.socialWorkCategory = { findMany: async () => [] };
  assert.equal((await manageRejectedRecord(db, audit, id, 'retry')).outcome, 'imported');
  assert.equal(written.organizationId, audit.organizationId);
  assert.equal(state().row.targetEntityId, 'entity-1');
  if (entityType === 'events') assert.equal(written.album.create.organizationId, audit.organizationId);
});

test('clear rolls back deletion if audit logging fails', async () => {
  const { db, state } = database({ auditFailure: true, warning: { correctionStatus: 'dismissed' } });
  await assert.rejects(clearClosedRejectedRecords(db, audit, 'all'));
  assert.equal(state().warnings.length, 1);
});

async function server(t, permitted = true) {
  const fixture = database();
  fixture.db.adminUser = { findFirst: async () => ({ roles: [{ role: { id: 'role', name: 'Importer', organizationId: 'org-1', isActive: true, isSystemRole: false, permissions: permitted ? [{ permission: { code: 'import_export.manage' } }] : [] } }] }) };
  process.env.JWT_SECRET = 'rejection-test-secret';
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.prisma = fixture.db; next(); }); app.use(router);
  const instance = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => instance.close());
  const request = (path, body, auth = true) => fetch(`http://127.0.0.1:${instance.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${jwt.sign({ userId: 'admin-1', organizationId: 'org-1' }, process.env.JWT_SECRET)}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ...fixture, request };
}

test('management routes require authentication and import permission', async t => {
  const { request } = await server(t, false);
  for (const [path, body] of [['/rejected-records', null], ['/rejected-records/actions', { action: 'delete', ids: [id] }], ['/rejected-records/clear', { module: 'all' }]]) {
    assert.equal((await request(path, body, false)).status, 401);
    assert.equal((await request(path, body)).status, 403);
  }
});

test('bulk routes return partial outcomes, reject malformed input and support clear', async t => {
  const { request, state } = await server(t);
  for (const body of [{ action: 'delete', ids: [] }, { action: 'retry', ids: [id], correctedData: { name: 1 } }, { action: 'delete', ids: Array(51).fill(id) }]) assert.equal((await request('/rejected-records/actions', body)).status, 400);
  const response = await request('/rejected-records/actions', { action: 'dismiss', ids: [id, '00000000-0000-4000-8000-000000000002'] });
  assert.deepEqual((await response.json()).data.results.map(r => r.outcome), ['dismissed', 'error']);
  assert.equal((await request('/rejected-records/clear', { module: 'all' })).status, 200);
  assert.equal(state().warnings.length, 0);
});
