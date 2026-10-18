import test from 'node:test';
import assert from 'node:assert/strict';
import {
  afterAccountAction,
  landingPath,
  routeDecision,
} from '../../src/access/account-routing.mjs';

const hr = { id: '1', username: 'H', role: 'hr', mustChangePassword: false };
const emp = { id: '2', username: 'E', role: 'employee', mustChangePassword: false };
const admin = { id: '0', username: 'A', role: 'admin', mustChangePassword: false };

test('accounts off: only the sign-in page exists, there is no guest fallback', () => {
  for (const path of ['/', '/login'])
    assert.deepEqual(routeDecision({ accounts: false, path }), { type: 'render' });
  for (const path of ['/signup', '/hr', '/profile', '/alya', '/dashboard', '/employee'])
    assert.deepEqual(routeDecision({ accounts: false, path }), { type: 'redirect', to: '/login' });
});
test('landing page follows account.role', () => {
  assert.equal(landingPath(hr), '/hr');
  assert.equal(landingPath(emp), '/onboarding');
});
test('signed-in users leave the login pages by role', () => {
  assert.deepEqual(routeDecision({ accounts: true, account: hr, path: '/login' }), {
    type: 'redirect',
    to: '/hr',
  });
  assert.deepEqual(routeDecision({ accounts: true, account: emp, path: '/' }), {
    type: 'redirect',
    to: '/onboarding',
  });
});
test('signed-out visitors to any app route go to /login', () => {
  for (const path of [
    '/signup',
    '/dashboard',
    '/onboarding',
    '/alya',
    '/support',
    '/profile',
    '/employee',
    '/employee/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    '/guest/employee',
    '/hr',
    '/hr-preview',
    '/nowhere',
  ])
    assert.deepEqual(routeDecision({ accounts: true, path }), { type: 'redirect', to: '/login' });
  for (const path of ['/', '/login'])
    assert.deepEqual(routeDecision({ accounts: true, path }), { type: 'render' });
});
test('an employee only sees employee pages; HR only sees /hr', () => {
  for (const path of ['/onboarding', '/alya', '/support', '/profile'])
    assert.deepEqual(routeDecision({ accounts: true, account: emp, path }), { type: 'render' });
  assert.deepEqual(routeDecision({ accounts: true, account: emp, path: '/hr' }), {
    type: 'redirect',
    to: '/onboarding',
  });
  // The retired /dashboard page is the same as My onboarding.
  assert.deepEqual(routeDecision({ accounts: true, account: emp, path: '/dashboard' }), {
    type: 'redirect',
    to: '/onboarding',
  });
  assert.deepEqual(routeDecision({ accounts: true, account: hr, path: '/hr' }), {
    type: 'render',
  });
  assert.deepEqual(routeDecision({ accounts: true, account: hr, path: '/alya' }), {
    type: 'redirect',
    to: '/hr',
  });
  assert.deepEqual(routeDecision({ accounts: true, account: emp, path: '/signup' }), {
    type: 'redirect',
    to: '/onboarding',
  });
});
test('forced change shows before anything else', () => {
  const account = { ...emp, mustChangePassword: true };
  for (const path of ['/login', '/alya', '/dashboard'])
    assert.equal(routeDecision({ accounts: true, account, path }).type, 'change-password');
});
test('every route waits for the session check', () => {
  for (const path of ['/login', '/hr', '/alya', '/dashboard'])
    assert.equal(routeDecision({ accounts: null, path }).type, 'loading');
  assert.equal(routeDecision({ accounts: true, loading: true, path: '/hr' }).type, 'loading');
});
test('app-wide account actions', () => {
  assert.deepEqual(afterAccountAction('sign-in', emp), {
    account: null,
    to: '/login',
    notice: true,
  });
  const r = afterAccountAction('change-password', emp);
  assert.equal(r.account.mustChangePassword, true);
  assert.equal(r.to, null);
  assert.equal(afterAccountAction('change-password', null).account, null);
  assert.deepEqual(afterAccountAction('company-account-required', admin), {
    account: admin,
    to: '/admin',
    notice: false,
  });
  assert.deepEqual(afterAccountAction('admin-role-required', emp), {
    account: emp,
    to: '/onboarding',
    notice: false,
  });
  assert.deepEqual(afterAccountAction('admin-role-required', hr), {
    account: hr,
    to: '/hr',
    notice: false,
  });
});

test('admin routing: admin lands on /admin and may only use /admin and /admin/companies/:id', () => {
  assert.equal(landingPath(admin), '/admin');
  assert.deepEqual(routeDecision({ accounts: true, account: admin, path: '/admin' }), {
    type: 'render',
  });
  assert.deepEqual(
    routeDecision({ accounts: true, account: admin, path: '/admin/companies/univrse' }),
    { type: 'render' },
  );
  assert.deepEqual(routeDecision({ accounts: true, account: admin, path: '/dashboard' }), {
    type: 'redirect',
    to: '/admin',
  });
  assert.deepEqual(routeDecision({ accounts: true, account: admin, path: '/hr' }), {
    type: 'redirect',
    to: '/admin',
  });
  assert.deepEqual(routeDecision({ accounts: true, account: admin, path: '/login' }), {
    type: 'redirect',
    to: '/admin',
  });
  assert.deepEqual(
    routeDecision({ accounts: true, account: admin, path: '/admin/companies/bad@id' }),
    { type: 'redirect', to: '/admin' },
  );
});

test('non-admin visiting /admin routes is redirected to landing', () => {
  assert.deepEqual(routeDecision({ accounts: true, account: hr, path: '/admin' }), {
    type: 'redirect',
    to: '/hr',
  });
  assert.deepEqual(
    routeDecision({ accounts: true, account: hr, path: '/admin/companies/univrse' }),
    { type: 'redirect', to: '/hr' },
  );
  assert.deepEqual(routeDecision({ accounts: true, account: emp, path: '/admin' }), {
    type: 'redirect',
    to: '/onboarding',
  });
  assert.deepEqual(
    routeDecision({ accounts: true, account: emp, path: '/admin/companies/univrse' }),
    { type: 'redirect', to: '/onboarding' },
  );
});

import { sessionCheckOutcome } from '../../src/access/account-routing.mjs';
import { ensureSession, registerSessionVerifier } from '../../src/access/account-api.mjs';

test('repeat session check: a missing or ended session returns to sign-in', () => {
  assert.equal(sessionCheckOutcome(emp, { account: null }).type, 'expired');
  assert.equal(
    sessionCheckOutcome(emp, { error: { status: 401, code: 'SESSION_EXPIRED' } }).type,
    'expired',
  );
  assert.equal(sessionCheckOutcome(emp, { account: { ...emp } }).type, 'ok');
  assert.equal(sessionCheckOutcome(null, { account: null }).type, 'ok');
});
test('repeat session check: other failures never sign the user out', () => {
  assert.equal(
    sessionCheckOutcome(emp, { error: { status: 503, code: 'ACCOUNTS_UNAVAILABLE' } }).type,
    'ok',
  );
  assert.equal(sessionCheckOutcome(emp, { error: { status: 0, code: '' } }).type, 'ok');
});
test('repeat session check: a changed account or forced change updates state', () => {
  const r = sessionCheckOutcome(emp, { account: { ...emp, mustChangePassword: true } });
  assert.equal(r.type, 'update');
  assert.equal(sessionCheckOutcome(emp, { account: hr }).type, 'update');
});
test('ensureSession allows sending without a verifier and obeys one', async () => {
  assert.equal(await ensureSession(), true);
  const off = registerSessionVerifier(async () => false);
  assert.equal(await ensureSession(), false);
  off();
  assert.equal(await ensureSession(), true);
});
