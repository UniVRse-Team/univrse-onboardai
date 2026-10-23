import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountApiError,
  accountErrorAction,
  accountRequest,
  subscribeAccountErrors,
} from '../../src/access/account-api.mjs';

const reply = (status, body) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

test('error codes map to app-wide actions', () => {
  assert.equal(accountErrorAction({ status: 401, code: 'SESSION_EXPIRED' }), 'sign-in');
  assert.equal(
    accountErrorAction({ status: 403, code: 'PASSWORD_CHANGE_REQUIRED' }),
    'change-password',
  );
  assert.equal(
    accountErrorAction({ status: 403, code: 'COMPANY_ACCOUNT_REQUIRED' }),
    'company-account-required',
  );
  assert.equal(
    accountErrorAction({ status: 403, code: 'ADMIN_ROLE_REQUIRED' }),
    'admin-role-required',
  );
  assert.equal(accountErrorAction({ status: 401, code: 'SIGN_IN_FAILED' }), null);
  assert.equal(accountErrorAction({ status: 429, code: 'ACCOUNT_LOCKED' }), null);
  assert.equal(accountErrorAction({ status: 401, code: 'AUTH_REQUIRED' }), null);
});

test('failed requests throw code, message and fields, and notify listeners', async () => {
  const seen = [];
  const off = subscribeAccountErrors((a) => seen.push(a));
  await assert.rejects(
    accountRequest('/api/hr/employees', {
      fetchImpl: reply(401, { code: 'SESSION_EXPIRED', error: 'Ended.' }),
    }),
    (e) => e instanceof AccountApiError && e.code === 'SESSION_EXPIRED' && e.message === 'Ended.',
  );
  await assert.rejects(
    accountRequest('/api/chat', {
      fetchImpl: reply(403, { code: 'PASSWORD_CHANGE_REQUIRED', error: 'x' }),
    }),
  );
  await assert.rejects(
    accountRequest('/api/auth/password', {
      method: 'POST',
      body: {},
      fetchImpl: reply(429, { code: 'ACCOUNT_LOCKED', error: 'Wait.' }),
    }),
    (e) => e.code === 'ACCOUNT_LOCKED' && e.status === 429,
  );
  off();
  assert.deepEqual(seen, ['sign-in', 'change-password']);
});

test('report:false skips listeners; 204 returns null; network failure is friendly', async () => {
  const seen = [];
  const off = subscribeAccountErrors((a) => seen.push(a));
  await assert.rejects(
    accountRequest('/api/auth/session', {
      report: false,
      fetchImpl: reply(401, { code: 'SESSION_EXPIRED', error: 'x' }),
    }),
  );
  off();
  assert.deepEqual(seen, []);
  assert.equal(await accountRequest('/x', { fetchImpl: reply(204) }), null);
  await assert.rejects(
    accountRequest('/x', {
      fetchImpl: async () => {
        throw new TypeError('fail');
      },
    }),
    /Could not reach the server/,
  );
});

test('request sends JSON body and same-origin credentials', async () => {
  let call;
  await accountRequest('/api/auth/sign-in', {
    method: 'POST',
    body: { username: 'a', password: 'b' },
    fetchImpl: async (url, init) => {
      call = { url, init };
      return { status: 200, ok: true, json: async () => ({}) };
    },
  });
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.body, '{"username":"a","password":"b"}');
  assert.ok(!call.url.includes('b'));
});

test('autofillProfile sends the raw file with the upload headers', async () => {
  const { accountApi } = await import('../../src/access/account-api.mjs');
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return { status: 200, ok: true, json: async () => ({ profile: {}, filled: [], warnings: [] }) };
  };
  try {
    const file = { name: 'Ada Löve.pdf', size: 3 };
    await accountApi.autofillProfile(file);
    assert.equal(calls[0].path, '/api/hr/employees/autofill');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, file);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
    assert.equal(calls[0].init.headers['X-File-Name'], encodeURIComponent('Ada Löve.pdf'));
  } finally {
    globalThis.fetch = real;
  }
});

test('accountApi.config GETs /api/config with no scope parameter or header (#117)', async () => {
  const { accountApi } = await import('../../src/access/account-api.mjs');
  const calls = [];
  const out = await accountApi.config({
    fetchImpl: async (path, init) => {
      calls.push({ path, init });
      return { status: 200, ok: true, json: async () => ({ accounts: true }) };
    },
  });
  assert.deepEqual(out, { accounts: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/config');
  assert.equal(calls[0].init.method, 'GET');
});

test('every accountApi.<name> used in src/ exists on accountApi (#117 guard)', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { accountApi } = await import('../../src/access/account-api.mjs');
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(full);
    }
  };
  await walk(root);
  const used = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/\baccountApi\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  }
  assert.ok(used.has('config') && used.has('session'), 'scan found the known usages');
  for (const name of used) {
    assert.equal(typeof accountApi[name], 'function', `accountApi.${name} is missing`);
  }
});
