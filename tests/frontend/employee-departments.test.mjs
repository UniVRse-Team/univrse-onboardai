import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyBothText,
  copyStatusMessage,
  copyToClipboard,
  createEmployeeBody,
  departmentOptions,
  departmentProblem,
  idFormatHint,
  manualCopyMessage,
  selectedDepartment,
} from '../../src/access/employee-departments.mjs';
import { formToProfileInput, profileToForm } from '../../src/access/profile-validation.mjs';

const dept = (id, name, prefix, archived = false) => ({
  id,
  name,
  prefix,
  archived,
  exampleId: `${prefix}-0001`,
  employees: 0,
});
const departments = [
  dept('d1', 'Product & Engineering', 'PE'),
  dept('d2', 'Finance', 'FN'),
  dept('d3', 'Legal', 'LG', true),
];

test('dropdown options are the active departments only, in the API order', () => {
  const options = departmentOptions(departments);
  assert.deepEqual(
    options.map((o) => o.value),
    ['Product & Engineering', 'Finance'],
  );
  assert.deepEqual(departmentOptions(null), []);
});

test('an archived or legacy current value becomes a first "(current)" option', () => {
  const archived = departmentOptions(departments, 'Legal');
  assert.deepEqual(archived[0], { value: 'Legal', label: 'Legal (current)', legacy: true });
  assert.equal(archived.length, 3);
  const legacy = departmentOptions(departments, 'Old Dept');
  assert.deepEqual(legacy[0], { value: 'Old Dept', label: 'Old Dept (current)', legacy: true });
  assert.equal(selectedDepartment(departments, 'Old Dept', 'Old Dept'), 'Old Dept');
  assert.equal(selectedDepartment(departments, 'Legal', 'Legal'), 'Legal');
  // an active current value adds nothing
  assert.equal(departmentOptions(departments, 'Finance').length, 2);
  assert.equal(departmentOptions(departments, '  ').length, 2);
  assert.equal(selectedDepartment(departments, 'Finance', 'Old Dept'), 'Finance');
  // archived and not the stored value: not selectable
  assert.equal(selectedDepartment(departments, 'Legal', ''), '');
  assert.equal(selectedDepartment(departments, 'Unknown', ''), '');
});

test('department is required on the add form and must be active', () => {
  assert.ok(departmentProblem(profileToForm(null), departments));
  assert.ok(departmentProblem({ job: { department: 'Made up' } }, departments));
  assert.ok(departmentProblem({ job: { department: 'Legal' } }, departments));
  assert.ok(departmentProblem({ job: { department: 'Finance' } }, null));
  const form = profileToForm({ job: { department: 'Finance' } });
  assert.equal(departmentProblem(form, departments), null);
});

test('ID format hint uses the prefix from the API', () => {
  for (const { name, prefix } of departments)
    assert.equal(idFormatHint(departments, name), `IDs look like ${prefix}-0001`);
  const changed = [dept('d2', 'Finance', 'ZZ')];
  assert.equal(idFormatHint(changed, 'Finance'), 'IDs look like ZZ-0001');
  assert.equal(idFormatHint(departments, ''), '');
  assert.equal(idFormatHint(departments, 'Other'), '');
  assert.equal(idFormatHint(null, 'Finance'), '');
});

test('create request body holds only the profile', () => {
  const profile = formToProfileInput(
    profileToForm({ job: { fullName: 'A', department: 'Finance' } }),
  );
  const body = createEmployeeBody(profile);
  assert.deepEqual(Object.keys(body), ['profile']);
  assert.equal(body.profile.job.department, 'Finance');
});

test('Copy both text', () => {
  assert.equal(
    copyBothText({ username: 'PE-0001', temporaryPassword: 'abc def' }),
    'Employee ID: PE-0001\nTemporary password: abc def',
  );
});

test('clipboard fallback decision', async () => {
  const written = [];
  const ok = { writeText: async (text) => written.push(text) };
  assert.deepEqual(await copyToClipboard('x', ok), { copied: true, fallback: false });
  assert.deepEqual(written, ['x']);
  const denied = {
    writeText: async () => {
      throw new Error('denied');
    },
  };
  assert.deepEqual(await copyToClipboard('x', denied), { copied: false, fallback: true });
  assert.deepEqual(await copyToClipboard('x', undefined), { copied: false, fallback: true });
  assert.deepEqual(await copyToClipboard('x', {}), { copied: false, fallback: true });
  assert.equal(copyStatusMessage('password', { copied: true }), 'Copied password');
  assert.equal(copyStatusMessage('password', { copied: false }), manualCopyMessage);
});

test('when departments list is empty, departmentProblem and idFormatHint return hint', () => {
  const form = profileToForm(null);
  assert.equal(departmentProblem(form, []), 'Add a department in Settings first');
  assert.equal(idFormatHint([], 'Any'), 'Add a department in Settings first');
});
