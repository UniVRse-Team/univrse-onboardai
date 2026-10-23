import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shouldNavigateAfterSignOut,
  signedOutPath,
} from '../../src/access/sign-out-destination.mjs';

test('employee and HR return to their company link', () => {
  assert.equal(
    signedOutPath({ role: 'employee', companyId: 'luna-digital' }),
    '/companies/luna-digital',
  );
  assert.equal(signedOutPath({ role: 'hr', companyId: 'acme-co' }), '/companies/acme-co');
});

test('company id may come from account.company.id', () => {
  assert.equal(
    signedOutPath({ role: 'employee', company: { id: 'beta-inc' } }),
    '/companies/beta-inc',
  );
});

test('no company, no account, or admin goes to /login', () => {
  assert.equal(signedOutPath({ role: 'employee' }), '/login');
  assert.equal(signedOutPath(null), '/login');
  assert.equal(signedOutPath(undefined), '/login');
  assert.equal(signedOutPath({ role: 'admin' }), '/login');
  assert.equal(signedOutPath({ role: 'admin', companyId: 'luna-digital' }), '/login');
});

test('only an explicit navigate:false suppresses navigation', () => {
  assert.equal(shouldNavigateAfterSignOut(), true);
  assert.equal(shouldNavigateAfterSignOut({ type: 'click' }), true);
  assert.equal(shouldNavigateAfterSignOut({ navigate: false }), false);
});
