import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultHrSection, hrSections } from '../../src/access/hr-navigation.mjs';

test('HR sees all six sections in order, Settings last', () => {
  assert.deepEqual(
    hrSections.map((s) => s.label),
    [
      'Employee accounts',
      'Submissions',
      'People & Support',
      'Company Documentation',
      'Company profile',
      'Settings',
    ],
  );
  assert.equal(hrSections.at(-1).id, 'settings');
});

test('Employee accounts opens by default', () => {
  assert.equal(defaultHrSection(), 'accounts');
});
