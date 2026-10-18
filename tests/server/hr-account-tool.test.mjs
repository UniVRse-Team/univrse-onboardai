import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkHrCredentials,
  createAdminAccount,
  createHrAccount,
  parsePipedInput,
  resetAdminAccountPassword,
  resetHrAccountPassword,
} from '../../scripts/hr-account-tool.mjs';
import { startAccountsApp } from './account-harness.mjs';

const entered = (username, password, confirmation = password) => ({
  username,
  password,
  confirmation,
});

async function withApp(check) {
  const app = await startAccountsApp();
  try {
    await check(app);
  } finally {
    await app.close();
  }
}

test('piped input is read as lines: ID, password and an optional confirmation', () => {
  assert.deepEqual(parsePipedInput('HR-0001\nsecret pass 1\nsecret pass 1\n'), {
    username: 'HR-0001',
    password: 'secret pass 1',
    confirmation: 'secret pass 1',
  });
  // Two lines, Windows line endings, spaces inside the password are kept.
  assert.deepEqual(parsePipedInput('HR-0001\r\n  spaced pass  \r\n'), {
    username: 'HR-0001',
    password: '  spaced pass  ',
    confirmation: '  spaced pass  ',
  });
});

test('both HR scripts apply the ID format and the password rules before touching the database', () => {
  assert.equal(checkHrCredentials(entered(' HR-0001 ', 'long enough 1')), 'HR-0001');
  for (const [input, message] of [
    [entered('x', 'long enough 1'), /3 to 32 letters/],
    [entered('HR 0001', 'long enough 1'), /3 to 32 letters/],
    [entered('HR-0001', 'short'), /at least 8/],
    [entered('HR-00001', 'hr-00001'), /same as the ID/],
    [entered('HR-0001', 'p'.repeat(201)), /at most 200/],
    [entered('HR-0001', 'long enough 1', 'long enough 2'), /do not match/],
  ])
    assert.throws(() => checkHrCredentials(input), message);
});

test('hr:create makes an HR account without a forced change and refuses a taken ID', async () => {
  await withApp(async (app) => {
    const options = { hash: app.hashing.hash, at: app.clock.now() };
    const made = await createHrAccount(
      app.store,
      entered('HR-0001', 'synthetic-hr-pass-1'),
      options,
    );
    assert.equal(made.ok, true);
    assert.match(made.message, /^Created HR account HR-0001 \([0-9a-f-]{36}\)\.$/);
    const taken = await createHrAccount(
      app.store,
      entered('hr-0001', 'synthetic-hr-pass-2'),
      options,
    );
    assert.deepEqual(taken, { ok: false, message: 'That HR ID is already in use.' });
    const [row] = await app.rows('SELECT role, must_change_password FROM accounts');
    assert.deepEqual(row, { role: 'hr', must_change_password: false });
    assert.equal((await app.browser().signIn('HR-0001', 'synthetic-hr-pass-1')).status, 200);
  });
});

test('hr:reset-password sets a new password, clears the lock, ends every session and records an event', async () => {
  await withApp(async (app) => {
    await app.createHr('HR-0001', 'synthetic-hr-pass-1');
    const laptop = app.browser(),
      phone = app.browser();
    await laptop.signIn('HR-0001', 'synthetic-hr-pass-1');
    await phone.signIn('HR-0001', 'synthetic-hr-pass-1');
    for (let i = 0; i < 5; i++) await app.browser().signIn('HR-0001', `wrong-pass-${i}`);
    assert.equal((await laptop.get('/api/auth/session')).status, 200); // locked, still signed in

    const reset = await resetHrAccountPassword(
      app.store,
      entered('hr-0001', 'synthetic-hr-new-1'),
      { hash: app.hashing.hash, at: app.clock.now() },
    );
    assert.deepEqual(reset, {
      ok: true,
      message:
        'Reset the password for HR account HR-0001. Its sessions have ended and any lock is cleared.',
    });
    const [row] = await app.rows(
      'SELECT failed_attempts, locked_until, must_change_password FROM accounts',
    );
    assert.deepEqual(row, { failed_attempts: 0, locked_until: null, must_change_password: false });
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 0);
    for (const browser of [laptop, phone])
      assert.equal((await browser.get('/api/auth/session')).body.code, 'SESSION_EXPIRED');
    assert.equal((await app.browser().signIn('HR-0001', 'synthetic-hr-pass-1')).status, 401);
    const signed = await app.browser().signIn('HR-0001', 'synthetic-hr-new-1');
    assert.equal(signed.status, 200);
    assert.equal(signed.body.account.mustChangePassword, false);
    const events = await app.rows(
      "SELECT actor_id, action FROM account_events WHERE action = 'hr_password_reset'",
    );
    assert.deepEqual(events, [{ actor_id: null, action: 'hr_password_reset' }]);
  });
});

test('hr:reset-password only touches HR accounts and reports failures without the password', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    await app.createEmployee(hr);
    const before = await app.rows("SELECT password_hash FROM accounts WHERE username = 'PC-0001'");
    const options = { hash: app.hashing.hash, at: app.clock.now() };
    for (const id of ['PC-0001', 'HR-9999'])
      assert.deepEqual(
        await resetHrAccountPassword(app.store, entered(id, 'synthetic-new-pass-1'), options),
        { ok: false, message: 'No HR account with that ID.' },
      );
    assert.deepEqual(
      await app.rows("SELECT password_hash FROM accounts WHERE username = 'PC-0001'"),
      before,
    );
    assert.equal(
      (
        await app.rows(
          "SELECT count(*)::int AS n FROM account_events WHERE action = 'hr_password_reset'",
        )
      )[0].n,
      0,
    );
    // HR's own session is untouched by a refused reset.
    assert.equal((await hr.get('/api/hr/employees')).status, 200);
    app.database.fail('08006');
    const down = await resetHrAccountPassword(
      app.store,
      entered('HR-0001', 'synthetic-secret-9'),
      options,
    );
    assert.equal(down.ok, false);
    assert.match(down.message, /could not be reset/);
    assert.ok(!down.message.includes('synthetic-secret-9'));
  });
});

test('admin:create makes an admin account without company, and admin:reset-password resets it', async () => {
  await withApp(async (app) => {
    const options = { hash: app.hashing.hash, at: app.clock.now() };
    const created = await createAdminAccount(
      app.store,
      entered('admin', 'synthetic-admin-pass-1'),
      options,
    );
    assert.equal(created.ok, true);
    assert.match(created.message, /Created Admin account admin/);

    const accounts = await app.rows(
      "SELECT username, role, company_id FROM accounts WHERE username = 'admin'",
    );
    assert.deepEqual(accounts, [{ username: 'admin', role: 'admin', company_id: null }]);

    const signed = await app.browser().signIn('admin', 'synthetic-admin-pass-1');
    assert.equal(signed.status, 200);
    assert.equal(signed.body.account.role, 'admin');

    const reset = await resetAdminAccountPassword(
      app.store,
      entered('admin', 'synthetic-admin-new-1'),
      options,
    );
    assert.equal(reset.ok, true);
    assert.match(reset.message, /Reset the password for Admin account admin/);

    assert.equal((await app.browser().signIn('admin', 'synthetic-admin-pass-1')).status, 401);
    assert.equal((await app.browser().signIn('admin', 'synthetic-admin-new-1')).status, 200);
  });
});
