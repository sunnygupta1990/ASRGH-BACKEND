const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { createExportWorkbook, validateImportRows } = require('../dist/services/importExport.service');

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
