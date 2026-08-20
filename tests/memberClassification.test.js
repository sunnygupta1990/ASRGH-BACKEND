const test = require('node:test');
const assert = require('node:assert/strict');
const { categoryFromMemberCode, classifiedCustomFields, compareMemberCodes } = require('../dist/services/memberClassification.service.js');
const { isAssignmentCurrent, publicAddressFields } = require('../dist/services/publicContent.service.js');
const { classifyExistingMembers } = require('../dist/scripts/classifyMembers.js');

test('member code authoritatively classifies category and designation', () => {
  for (const [code, expected] of [['T-1', 'Trustee'], ['t-002', 'Trustee'], ['L-1', 'Life Member'], ['l-002', 'Life Member'], ['O-1', 'Ordinary'], ['ABC-1', 'Ordinary'], [null, 'Ordinary']]) {
    assert.equal(categoryFromMemberCode(code), expected);
    const fields = classifiedCustomFields(code, { category: 'Wrong', designation: 'President', retained: true });
    assert.equal(fields.category, expected);
    assert.equal(fields.designation, expected);
    assert.equal(fields.retained, true);
  }
});

test('member codes sort by T, L, Ordinary groups and numeric values', () => {
  const codes = ['O-1', 'L-100', 'T-100', 'T-10', 'L-2', 'T-002', 'T-1', 'L-001', 'ABC-1'];
  assert.deepEqual(codes.sort(compareMemberCodes), ['T-1', 'T-002', 'T-10', 'T-100', 'L-001', 'L-2', 'L-100', 'ABC-1', 'O-1']);
});

test('public address exposes only address line 2 and city when enabled', () => {
  assert.deepEqual(publicAddressFields(true, { addressLine2: 'Apartment 4B', city: 'New Delhi' }), {
    addressLine1: null, addressLine2: 'Apartment 4B', city: 'New Delhi', state: null,
  });
  assert.deepEqual(publicAddressFields(false, { addressLine2: 'Apartment 4B', city: 'New Delhi' }), {
    addressLine1: null, addressLine2: null, city: null, state: null,
  });
  assert.equal(Object.values(publicAddressFields(true, { addressLine2: 'Apartment 4B', city: 'New Delhi' })).includes('123 Main Street'), false);
});

test('management assignment must have active position, active term, and current dates', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const current = {
    startDate: null, endDate: null,
    position: { isActive: true },
    term: { startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), status: 'active' },
  };
  assert.equal(isAssignmentCurrent(current, now), true);
  assert.equal(isAssignmentCurrent({ ...current, endDate: new Date('2025-12-31') }, now), false);
  assert.equal(isAssignmentCurrent({ ...current, position: { isActive: false } }, now), false);
  assert.equal(isAssignmentCurrent({ ...current, term: { ...current.term, status: 'inactive' } }, now), false);
});

test('one-time classification covers all records with an in-place JSONB update', async () => {
  const members = [
    { id: '1', memberCode: 'T-1', customFields: { note: 'keep', category: 'Old' } },
    { id: '2', memberCode: 'l-2', customFields: { note: 'keep' } },
    { id: '3', memberCode: 'ABC-3', customFields: { note: 'keep' } },
  ];
  let sql = '';
  const prisma = {
    member: {
      findMany: async () => members,
    },
    $executeRawUnsafe: async (statement) => { sql = statement; return members.length; },
  };
  const result = await classifyExistingMembers(prisma);
  assert.deepEqual(result.counts, { Trustee: 1, 'Life Member': 1, Ordinary: 1 });
  assert.match(sql, /jsonb_set/);
  assert.match(sql, /COALESCE\("customFields"/);
  assert.match(sql, /'\{category\}'/);
  assert.match(sql, /'\{designation\}'/);
  assert.doesNotMatch(sql, /"memberCode"\s*=/);
});
