const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { commitImport, createExportWorkbook, IMPORT_BATCH_SIZE, validateImportRows } = require('../dist/services/importExport.service');

function validationPrisma(existingCodes = [], categories = []) {
  return {
    member: { findMany: async () => existingCodes.map((memberCode) => ({ memberCode })) },
    event: { findMany: async () => [] },
    socialWorkItem: { findMany: async () => [] },
    announcement: { findMany: async () => [] },
    socialWorkCategory: { findMany: async () => categories.map((name) => ({ name })) },
  };
}

test('member import rejects duplicates, impossible dates, and malformed JSON', async () => {
  const prisma = validationPrisma(['MEM-1']);
  const duplicate = await validateImportRows(prisma, 'org-1', 'members', [{ 'Member Code': 'mem-1', 'First Name': 'A' }]);
  assert.equal(duplicate.rejected.length, 1);
  const invalid = await validateImportRows(prisma, 'org-1', 'members', [{ 'Member Code': 'MEM-2', 'First Name': 'A', 'Date of Birth': '2026-02-30' }, { 'Member Code': 'MEM-3', 'First Name': 'B', 'Custom Fields JSON': '{bad' }]);
  assert.deepEqual(invalid.rejected.map((row) => row.rowNumber), [2, 3]);
});

test('social work import rejects an unknown category as a rejected row', async () => {
  const result = await validateImportRows(validationPrisma([], ['Education']), 'org-1', 'social_work', [{ 'Activity Code': 'SW-1', Title: 'Program', 'Social Work Category': 'Missing' }]);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0].error, /does not exist/);
});

test('member workbook contains relational sheets and complete scalar business fields', async () => {
  const empty = async () => [];
  const prisma = {
    member: { findMany: async () => [{ memberCode: 'M1', firstName: 'A', middleName: null, lastName: 'B', displayName: 'A B', gender: null, dateOfBirth: null, phone: null, email: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: 'India', membershipStatus: 'active', joinedOn: null, notes: null, metadata: { source: 'test' }, customFields: { category: 'General' } }] },
    managementPosition: { findMany: empty }, managementTerm: { findMany: empty }, managementAssignment: { findMany: empty },
  };
  const buffer = await createExportWorkbook(prisma, 'org-1', 'members');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Members', 'Management Positions', 'Management Terms', 'Management Assignments']);
  const row = XLSX.utils.sheet_to_json(workbook.Sheets.Members)[0];
  assert.equal(row['Member Code'], 'M1');
  assert.equal(row['Metadata JSON'], '{"source":"test"}');
  assert.equal(row['Custom Fields JSON'], '{"category":"General"}');
  assert.equal(Object.hasOwn(row, 'passwordHash'), false);
});

function memberImportPrisma(failingCode) {
  const transactionMemberCounts = [];
  let currentMemberCount = 0;
  let nextId = 0;
  const importBatch = {
    create: async ({ data }) => ({ id: 'batch-1', ...data }),
    update: async ({ data }) => ({ id: 'batch-1', ...data }),
  };
  const tx = {
    member: { create: async ({ data }) => {
      currentMemberCount += 1;
      if (data.memberCode === failingCode) throw new Error(`Database rejected ${failingCode}`);
      return { id: `member-${++nextId}` };
    } },
    importRecord: { create: async () => ({ id: `record-${nextId}` }) },
    rejectedRecord: { create: async () => ({}) },
    importBatch,
    auditLog: { create: async () => ({}) },
  };
  const prisma = {
    member: { findMany: async () => [] },
    importBatch,
    $transaction: async (callback) => {
      currentMemberCount = 0;
      const result = await callback(tx);
      transactionMemberCounts.push(currentMemberCount);
      return result;
    },
  };
  return { prisma, transactionMemberCounts };
}

function memberRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    'Member Code': `MEM-${index + 1}`,
    'First Name': `Member ${index + 1}`,
  }));
}

for (const [recordCount, expectedTransactions] of [[10, 1], [50, 1], [51, 2], [100, 2], [150, 3], [175, 4]]) {
  test(`member import commits ${recordCount} successful records in ${expectedTransactions} transaction(s)`, async () => {
    const { prisma, transactionMemberCounts } = memberImportPrisma();
    const result = await commitImport(prisma, { organizationId: 'org-1', actorUserId: 'user-1', actorRoleNames: ['Admin'] }, 'members', 'members.xlsx', memberRows(recordCount));

    assert.equal(IMPORT_BATCH_SIZE, 50);
    assert.equal(result.accepted, recordCount);
    assert.equal(result.rejected, 0);
    assert.deepEqual(transactionMemberCounts.filter((count) => count > 0), [
      ...Array(Math.floor(recordCount / 50)).fill(50),
      ...(recordCount % 50 ? [recordCount % 50] : []),
    ]);
  });
}

test('a persistence failure after the first 50 is reported without undoing earlier or later members', async () => {
  const { prisma, transactionMemberCounts } = memberImportPrisma('MEM-51');
  const result = await commitImport(prisma, { organizationId: 'org-1', actorUserId: 'user-1', actorRoleNames: ['Admin'] }, 'members', 'members.xlsx', memberRows(100));

  assert.equal(result.accepted, 99);
  assert.equal(result.rejected, 1);
  assert.equal(transactionMemberCounts[0], 50);
  assert.ok(transactionMemberCounts.some((count) => count > 1), 'failed batch was subdivided rather than making every normal record its own transaction');
});
