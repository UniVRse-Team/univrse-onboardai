import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startAccountsApp, syntheticProfile } from './account-harness.mjs';
import { verifyPassword } from '../../server/password-hashing.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const MINUTE = 60 * 1000,
  HOUR = 60 * MINUTE;
const failedSignIn = {
  code: 'SIGN_IN_FAILED',
  error:
    'The ID or password is incorrect, or this account cannot sign in right now. Check your details or contact HR.',
};

async function withApp(options, check) {
  if (typeof options === 'function') [options, check] = [{}, options];
  const app = await startAccountsApp(options);
  try {
    await check(app);
  } finally {
    await app.close();
  }
}

test('HR signs in with a session cookie that is HttpOnly, SameSite=Strict, /api-scoped and 12 hours long', async () => {
  await withApp(async (app) => {
    await app.createHr();
    const hr = app.browser();
    const response = await fetch(app.url + '/api/auth/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'hr-0001', password: 'synthetic-hr-pass-1' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const [cookie] = response.headers.getSetCookie();
    assert.match(
      cookie,
      /^onboardai_account=[0-9a-f]{64}; Max-Age=43200; Path=\/api; Expires=[^;]+; HttpOnly; SameSite=Strict$/,
    );
    const body = await response.json();
    assert.deepEqual(Object.keys(body.account).sort(), [
      'company',
      'companyId',
      'id',
      'mustChangePassword',
      'role',
      'sessionExpiresAt',
      'username',
    ]);
    assert.equal(body.account.username, 'HR-0001');
    assert.equal(body.account.role, 'hr');
    assert.equal(body.account.mustChangePassword, false);
    assert.equal(body.account.sessionExpiresAt, '2026-10-15T13:00:00.000Z');
    // Only the token's SHA-256 is stored.
    const token = cookie.slice('onboardai_account='.length, cookie.indexOf(';'));
    const sessions = await app.rows('SELECT token_hash FROM sessions');
    assert.deepEqual(
      sessions.map((row) => row.token_hash),
      [sha256(token)],
    );
    hr.remember(response);
    const session = await hr.get('/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.account.id, body.account.id);
    // No cookie is not an error: the browser is simply signed out.
    assert.deepEqual((await app.browser().get('/api/auth/session')).body, { account: null });
    // Secure on HTTPS deployments.
  });
  await withApp({ env: { NODE_ENV: 'production' } }, async (app) => {
    await app.createHr();
    const response = await app.browser().signIn('HR-0001', 'synthetic-hr-pass-1');
    assert.match(response.headers.getSetCookie()[0], /; Secure; SameSite=Strict$/);
  });
});

test('every failed sign-in looks the same, and an unknown ID still costs one password check', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const first = await app.createEmployee(hr);
    const second = await app.createEmployee(hr);
    assert.deepEqual(
      [first.employee.account.username, second.employee.account.username],
      ['PC-0001', 'PC-0002'],
    );
    const secondId = second.employee.account.id;
    assert.equal(
      (await hr.put(`/api/hr/employees/${secondId}/status`, { status: 'disabled' })).status,
      200,
    );
    const browser = app.browser();
    const attempts = [
      ['NO-SUCH-USER', first.temporaryPassword], // unknown ID
      ['PC-0001', 'wrong-password-1'], // wrong password
      ['PC-0002', second.temporaryPassword], // right password, disabled account
      ['x', first.temporaryPassword], // an ID that cannot exist
      ['PC-0001', 'p'.repeat(500)], // longer than any password
    ];
    const work = [];
    for (const [username, password] of attempts) {
      const before = app.hashing.counts.verify,
        statements = app.database.statements.length;
      const response = await browser.signIn(username, password);
      assert.equal(response.status, 401, username);
      assert.deepEqual(response.body, failedSignIn, username);
      assert.equal(app.hashing.counts.verify - before, 1, username);
      assert.equal(response.headers.getSetCookie().length, 0);
      // The same database statements, in the same order, whatever the reason
      // (the ID that cannot exist skips only the lookup).
      work.push(app.database.statements.slice(statements).filter((s) => !/^SELECT/.test(s.trim())));
    }
    for (const statements of work) assert.deepEqual(statements, work[0]);
    assert.match(work[0][0], /^UPDATE accounts SET/);
    // Malformed requests are a 400 that says nothing about accounts.
    for (const body of [{}, { username: 'PC-0001' }, { username: 5, password: 'x' }, []]) {
      const response = await browser.post('/api/auth/sign-in', body);
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'SIGN_IN_INVALID');
    }
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 1); // HR only
  });
});

test('five consecutive wrong passwords lock the account for 15 minutes with the same response as an unknown ID', async () => {
  await withApp(async (app) => {
    await app.createHr('HR-0002', 'synthetic-hr-pass-2');
    const browser = app.browser();
    const unknown = await browser.signIn('HR-9999', 'synthetic-hr-pass-2');
    // Four failures, then a success: the count starts again.
    for (let i = 0; i < 4; i++) await browser.signIn('HR-0002', `wrong-pass-${i}`);
    assert.equal((await app.rows('SELECT failed_attempts FROM accounts'))[0].failed_attempts, 4);
    assert.equal((await browser.signIn('HR-0002', 'synthetic-hr-pass-2')).status, 200);
    assert.equal((await app.rows('SELECT failed_attempts FROM accounts'))[0].failed_attempts, 0);
    await browser.post('/api/auth/sign-out');
    for (let i = 0; i < 5; i++) {
      const response = await browser.signIn('HR-0002', `wrong-pass-${i}`);
      assert.deepEqual([response.status, response.body], [unknown.status, unknown.body]);
    }
    const [row] = await app.rows('SELECT failed_attempts, locked_until FROM accounts');
    assert.equal(row.failed_attempts, 5);
    assert.equal(row.locked_until.toISOString(), '2026-10-15T01:15:00.000Z');
    // Locked: even the right password gets the identical response.
    const locked = await browser.signIn('HR-0002', 'synthetic-hr-pass-2');
    assert.deepEqual([locked.status, locked.body], [unknown.status, unknown.body]);
    app.clock.advance(14 * MINUTE);
    assert.equal((await browser.signIn('HR-0002', 'synthetic-hr-pass-2')).status, 401);
    app.clock.advance(MINUTE);
    const unlocked = await browser.signIn('HR-0002', 'synthetic-hr-pass-2');
    assert.equal(unlocked.status, 200);
    const [after] = await app.rows('SELECT failed_attempts, locked_until FROM accounts');
    assert.deepEqual(after, { failed_attempts: 0, locked_until: null });
    const events = await app.rows('SELECT action FROM account_events ORDER BY id');
    assert.deepEqual(
      events.map((e) => e.action),
      ['hr_account_created', 'signed_in', 'account_locked', 'signed_in'],
    );
    assert.ok(app.logs.includes('Account locked after repeated failed sign-ins.'));
    assert.ok(!app.logs.join('\n').includes('HR-0002'));
  });
});

test('a lock blocks new sign-ins only: sessions that already exist keep working', async () => {
  await withApp(async (app) => {
    await app.createHr('HR-0002', 'synthetic-hr-pass-2');
    const holder = app.browser();
    assert.equal((await holder.signIn('HR-0002', 'synthetic-hr-pass-2')).status, 200);
    const guesser = app.browser();
    for (let i = 0; i < 5; i++) await guesser.signIn('HR-0002', `wrong-pass-${i}`);
    const [row] = await app.rows("SELECT locked_until FROM accounts WHERE username = 'HR-0002'");
    assert.ok(row.locked_until > app.clock.now());
    // Someone else's wrong guesses do not sign the account holder out.
    const session = await holder.get('/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.account.username, 'HR-0002');
    assert.equal((await holder.get('/api/hr/employees')).status, 200);
    assert.equal(holder.cookies.has('onboardai_account'), true);
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 1);
    // New sign-ins stay blocked, even with the right password.
    const blocked = await app.browser().signIn('HR-0002', 'synthetic-hr-pass-2');
    assert.deepEqual([blocked.status, blocked.body], [401, failedSignIn]);
    // Sign-out still ends the session.
    assert.equal((await holder.post('/api/auth/sign-out')).status, 204);
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 0);
  });
});

test('wrong current passwords lock the account but keep the session; no password is checked while locked', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    const change = (currentPassword, newPassword = 'employee-next-pass-1') =>
      browser.post('/api/auth/password', { currentPassword, newPassword });
    for (let i = 0; i < 5; i++) {
      const wrong = await change(`not-my-password-${i}`);
      assert.deepEqual([wrong.status, wrong.body.code], [400, 'CURRENT_PASSWORD_INCORRECT']);
    }
    const seen = (await hr.get(`/api/hr/employees/${employee.account.id}`)).body.employee.account;
    assert.equal(seen.locked, true);
    assert.equal(seen.lockedUntil, '2026-10-15T01:15:00.000Z');
    // The session that reached the lock still works, chats included.
    assert.equal((await browser.get('/api/auth/session')).status, 200);
    assert.equal((await browser.get('/api/me/profile')).status, 200);
    assert.equal((await browser.get('/api/config')).body.conversationMemory, true);
    assert.equal((await browser.post('/api/conversations')).status, 201);
    // While locked, the form neither checks nor accepts a password, so a held
    // session cannot be used to keep guessing.
    const verifies = app.hashing.counts.verify;
    for (const attempt of ['employee-own-pass-1', 'another-guess-1']) {
      const locked = await change(attempt);
      assert.deepEqual([locked.status, locked.body.code], [429, 'ACCOUNT_LOCKED']);
    }
    assert.equal(app.hashing.counts.verify, verifies);
    assert.equal((await app.browser().signIn('PC-0001', 'employee-own-pass-1')).status, 401);
    // After the lock ends the password can be changed, which clears the count.
    app.clock.advance(15 * MINUTE);
    const changed = await change('employee-own-pass-1');
    assert.equal(changed.status, 200);
    const [after] = await app.rows(
      "SELECT failed_attempts, locked_until FROM accounts WHERE username = 'PC-0001'",
    );
    assert.deepEqual(after, { failed_attempts: 0, locked_until: null });
  });
});

test('sessions rotate on sign-in and password change, end after 12 hours, and sign-out deletes them', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const first = hr.copy();
    // Signing in again replaces this browser's session (rotation).
    assert.equal((await hr.signIn('HR-0001', 'synthetic-hr-pass-1')).status, 200);
    assert.notEqual(hr.cookies.get('onboardai_account'), first.cookies.get('onboardai_account'));
    const stale = await first.get('/api/auth/session');
    assert.equal(stale.status, 401);
    assert.equal(stale.body.code, 'SESSION_EXPIRED');
    assert.equal(first.cookies.has('onboardai_account'), false); // cleared
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 1);

    // A password change ends every session of the account and issues a new one.
    const elsewhere = app.browser();
    await elsewhere.signIn('HR-0001', 'synthetic-hr-pass-1');
    const before = hr.cookies.get('onboardai_account');
    const changed = await hr.post('/api/auth/password', {
      currentPassword: 'synthetic-hr-pass-1',
      newPassword: 'synthetic-hr-pass-new',
    });
    assert.equal(changed.status, 200);
    assert.notEqual(hr.cookies.get('onboardai_account'), before);
    assert.equal((await hr.get('/api/auth/session')).status, 200);
    assert.equal((await elsewhere.get('/api/auth/session')).body.code, 'SESSION_EXPIRED');
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 1);

    // Twelve hours after the session started, it ends and its row is removed.
    app.clock.advance(12 * HOUR - 1);
    assert.equal((await hr.get('/api/hr/employees')).status, 200);
    app.clock.advance(1);
    const expired = await hr.get('/api/hr/employees');
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, 'SESSION_EXPIRED');
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 0);

    // Sign-out deletes the session on the server, not just the cookie.
    await hr.signIn('HR-0001', 'synthetic-hr-pass-new');
    const kept = hr.copy();
    const out = await hr.post('/api/auth/sign-out');
    assert.equal(out.status, 204);
    assert.match(
      out.headers.getSetCookie()[0],
      /^onboardai_account=; Path=\/api; Expires=Thu, 01 Jan 1970/,
    );
    assert.equal((await kept.get('/api/auth/session')).body.code, 'SESSION_EXPIRED');
    assert.equal((await app.rows('SELECT count(*)::int AS n FROM sessions'))[0].n, 0);
    // Signing out twice, or without a session, is harmless.
    assert.equal((await hr.post('/api/auth/sign-out')).status, 204);
    // A forged cookie is an expired session, never a signed-in one.
    const forged = app.browser();
    forged.cookies.set('onboardai_account', 'f'.repeat(64));
    assert.equal((await forged.get('/api/auth/session')).body.code, 'SESSION_EXPIRED');
  });
});

test('role gates: no session is 401, an employee is 403 and HR is allowed on every HR route', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { employee, browser: staff } = await app.readyEmployee(hr);
    const id = employee.account.id;
    const routes = [
      ['get', '/api/hr/employees'],
      ['post', '/api/hr/employees', { profile: syntheticProfile('Gate Example', 'Finance') }],
      ['get', `/api/hr/employees/${id}`],
      ['put', `/api/hr/employees/${id}/profile`, { profile: syntheticProfile() }],
      ['post', `/api/hr/employees/${id}/password`, { temporaryPassword: 'temporary-pass-2' }],
      ['put', `/api/hr/employees/${id}/status`, { status: 'active' }],
    ];
    const nobody = app.browser();
    for (const [method, path, body] of routes) {
      const anonymous = await nobody[method](path, body);
      assert.deepEqual([anonymous.status, anonymous.body.code], [401, 'AUTH_REQUIRED'], path);
      const denied = await staff[method](path, body);
      assert.deepEqual([denied.status, denied.body.code], [403, 'HR_ROLE_REQUIRED'], path);
    }
    // Nothing the employee tried changed anything.
    assert.equal(
      (await app.rows("SELECT count(*)::int AS n FROM accounts WHERE username LIKE 'FN-%'"))[0].n,
      0,
    );
    assert.deepEqual(await app.rows('SELECT prefix FROM employee_id_counters'), [{ prefix: 'PC' }]);
    for (const [method, path, body] of routes) {
      const allowed = await hr[method](path, body);
      assert.ok([200, 201].includes(allowed.status), `${path}: ${allowed.text}`);
    }
    // The employee's own profile needs a session too.
    assert.equal((await nobody.get('/api/me/profile')).body.code, 'AUTH_REQUIRED');
    // Unknown account routes are JSON 404s, not the website.
    const missing = await hr.get('/api/hr/nothing-here');
    assert.deepEqual([missing.status, missing.body.code], [404, 'NOT_FOUND']);
  });
});

test('a forced password change blocks everything except session, change password and sign-out', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { employee, temporaryPassword } = await app.createEmployee(hr);
    assert.equal(employee.account.mustChangePassword, true);
    const staff = app.browser();
    const signed = await staff.signIn('PC-0001', temporaryPassword);
    assert.equal(signed.status, 200);
    assert.equal(signed.body.account.mustChangePassword, true);
    assert.equal((await staff.get('/api/auth/session')).body.account.mustChangePassword, true);
    const config = (await staff.get('/api/config')).body;
    assert.equal(config.conversationMemory, false);
    for (const [method, path, body] of [
      ['get', '/api/me/profile'],
      ['get', '/api/conversations'],
      ['post', '/api/conversations'],
      ['post', '/api/chat', { question: 'What should I wear?', taskId: 'company-resources' }],
      ['get', '/api/hr/employees'],
    ]) {
      const blocked = await staff[method](path, body);
      assert.deepEqual(
        [blocked.status, blocked.body.code],
        [403, 'PASSWORD_CHANGE_REQUIRED'],
        path,
      );
    }
    // Wrong current password, the same password again, or the ID as a password.
    const attempts = [
      [
        { currentPassword: 'not-the-temporary', newPassword: 'employee-own-pass-1' },
        'CURRENT_PASSWORD_INCORRECT',
      ],
      [{ currentPassword: temporaryPassword, newPassword: temporaryPassword }, 'PASSWORD_REJECTED'],
      [{ currentPassword: temporaryPassword, newPassword: 'pc-0001' }, 'PASSWORD_REJECTED'],
      [{ currentPassword: temporaryPassword, newPassword: 'short' }, 'PASSWORD_REJECTED'],
      [{ currentPassword: temporaryPassword }, 'PASSWORD_CHANGE_INVALID'],
    ];
    for (const [body, code] of attempts) {
      const rejected = await staff.post('/api/auth/password', body);
      assert.deepEqual([rejected.status, rejected.body.code], [400, code]);
    }
    // The wrong current password counted towards the lockout.
    assert.equal(
      (await app.rows("SELECT failed_attempts FROM accounts WHERE username = 'PC-0001'"))[0]
        .failed_attempts,
      1,
    );
    const changed = await staff.post('/api/auth/password', {
      currentPassword: temporaryPassword,
      newPassword: 'employee-own-pass-1',
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.account.mustChangePassword, false);
    const profile = await staff.get('/api/me/profile');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.job.fullName, 'Avery Example');
    assert.equal(profile.body.profile.contact.workEmail, 'avery.example@example.com');
    assert.equal((await staff.get('/api/config')).body.conversationMemory, true);
    // Responses never echo a password.
    const answers = JSON.stringify([signed.body, changed.body, profile.body]);
    assert.ok(!answers.includes(temporaryPassword) && !answers.includes('pass-1'));
  });
});

test('HR creates, reads, lists and edits employees; every change writes an account event', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const hrId = (await hr.get('/api/auth/session')).body.account.id;
    const created = await hr.post('/api/hr/employees', { profile: syntheticProfile() });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(created.body).sort(), ['employee', 'temporaryPassword']);
    const { account, profile } = created.body.employee;
    assert.deepEqual(Object.keys(account).sort(), [
      'createdAt',
      'id',
      'lastSignInAt',
      'locked',
      'lockedUntil',
      'mustChangePassword',
      'role',
      'status',
      'updatedAt',
      'username',
    ]);
    assert.deepEqual(
      [account.username, account.role, account.status, account.mustChangePassword, account.locked],
      ['PC-0001', 'employee', 'active', true, false],
    );
    assert.equal(profile.updatedBy, hrId);
    assert.equal(profile.updatedAt, '2026-10-15T01:00:00.000Z');
    // job.track (issue #47) is stored as '' when not given: an employee.
    assert.deepEqual(app.firestore.read(`employeeProfiles/${account.id}`).job, {
      ...syntheticProfile().job,
      track: '',
    });
    const [row] = await app.rows(
      "SELECT password_hash, created_by FROM accounts WHERE username = 'PC-0001'",
    );
    assert.match(row.password_hash, /^scrypt\$n=1024,r=8,p=1\$/);
    assert.ok(await verifyPassword(created.body.temporaryPassword, row.password_hash));
    assert.equal(row.created_by, hrId);

    // The Employee ID and the temporary password are the server's: a body that
    // names either (or anything but the profile) is refused; nothing is written.
    const job = { fullName: 'A', department: 'Finance' };
    for (const [body, code] of [
      [{ username: 'FN-0001', profile: syntheticProfile() }, 'EMPLOYEE_INVALID'],
      [{ temporaryPassword: 'temporary-pass-1', profile: syntheticProfile() }, 'EMPLOYEE_INVALID'],
      [{ profile: syntheticProfile(), note: 'x' }, 'EMPLOYEE_INVALID'],
      [[], 'EMPLOYEE_INVALID'],
      [{ profile: { job: { ...job, ssn: '1' } } }, 'PROFILE_INVALID'],
      [{ profile: { job, contact: { workEmail: 'bad' } } }, 'PROFILE_INVALID'],
      [{}, 'PROFILE_INVALID'],
    ]) {
      const rejected = await hr.post('/api/hr/employees', body);
      assert.deepEqual([rejected.status, rejected.body.code], [400, code], JSON.stringify(body));
    }
    const invalid = await hr.post('/api/hr/employees', {
      profile: { job: { ...job, startDate: '2026-13-01' }, extra: 'x' },
    });
    assert.deepEqual(invalid.body.fields, [
      { field: 'extra', problem: 'unknown' },
      { field: 'job.startDate', problem: 'invalid_date' },
    ]);
    assert.equal(
      (await app.rows("SELECT count(*)::int AS n FROM accounts WHERE role = 'employee'"))[0].n,
      1,
    );
    assert.equal(app.firestore.paths('employeeProfiles/').length, 1);
    assert.deepEqual(await app.rows('SELECT prefix FROM employee_id_counters'), [{ prefix: 'PC' }]);

    const list = await hr.get('/api/hr/employees');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.employees, [
      {
        account,
        profile: {
          fullName: 'Avery Example',
          preferredName: 'Avery',
          jobTitle: 'Onboarding Analyst',
          department: 'People & Culture',
          startDate: '2026-11-02',
        },
        // Issue #47: the track (employee when the profile has none) and the
        // onboarding progress at the top level of each item.
        track: 'employee',
        onboarding: { percent: 0, waitingOnHr: 0, complete: false },
      },
    ]);
    // HR accounts are not in the employee list or reachable as employees.
    const hrAsEmployee = await hr.get(`/api/hr/employees/${hrId}`);
    assert.deepEqual([hrAsEmployee.status, hrAsEmployee.body.code], [404, 'EMPLOYEE_NOT_FOUND']);
    assert.equal((await hr.get('/api/hr/employees/not-a-uuid')).body.code, 'EMPLOYEE_NOT_FOUND');
    assert.equal(
      (await hr.put(`/api/hr/employees/${hrId}/status`, { status: 'disabled' })).status,
      404,
    );

    const read = await hr.get(`/api/hr/employees/${account.id}`);
    assert.deepEqual(read.body.employee, { account, profile });

    app.clock.advance(60 * 1000);
    const edited = syntheticProfile('Avery Q. Example');
    edited.homeAddress.city = 'New Sample City';
    const replaced = await hr.put(`/api/hr/employees/${account.id}/profile`, { profile: edited });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.employee.profile.job.fullName, 'Avery Q. Example');
    assert.equal(replaced.body.employee.profile.updatedAt, '2026-10-15T01:01:00.000Z');
    assert.equal(
      app.firestore.read(`employeeProfiles/${account.id}`).homeAddress.city,
      'New Sample City',
    );
    const badEdit = await hr.put(`/api/hr/employees/${account.id}/profile`, {
      profile: { job: {} },
    });
    assert.deepEqual([badEdit.status, badEdit.body.code], [400, 'PROFILE_INVALID']);
    const statusBad = await hr.put(`/api/hr/employees/${account.id}/status`, { status: 'paused' });
    assert.deepEqual([statusBad.status, statusBad.body.code], [400, 'STATUS_INVALID']);

    const events = await app.rows(
      'SELECT actor_id, target_id, action FROM account_events ORDER BY id',
    );
    assert.deepEqual(
      events.map((e) => [e.action, e.actor_id === hrId, e.target_id]),
      [
        ['hr_account_created', false, hrId],
        ['signed_in', true, hrId],
        ['employee_created', true, account.id],
        ['profile_updated', true, account.id],
      ],
    );
  });
});

test('a password reset or a disabled account ends that employee’s sessions; enabling restores sign-in', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { employee, browser: first } = await app.readyEmployee(hr);
    const id = employee.account.id;
    const second = app.browser();
    assert.equal((await second.signIn('PC-0001', 'employee-own-pass-1')).status, 200);
    const hrSessions = async () =>
      (await app.rows(`SELECT count(*)::int AS n FROM sessions WHERE account_id = '${id}'`))[0].n;
    assert.equal(await hrSessions(), 2);

    const reset = await hr.post(`/api/hr/employees/${id}/password`, {
      temporaryPassword: 'temporary-pass-2',
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.account.mustChangePassword, true);
    assert.equal(await hrSessions(), 0);
    for (const browser of [first, second])
      assert.equal((await browser.get('/api/me/profile')).body.code, 'SESSION_EXPIRED');
    assert.deepEqual((await second.signIn('PC-0001', 'employee-own-pass-1')).body, failedSignIn);
    const again = await second.signIn('PC-0001', 'temporary-pass-2');
    assert.equal(again.body.account.mustChangePassword, true);
    assert.equal((await second.get('/api/me/profile')).body.code, 'PASSWORD_CHANGE_REQUIRED');
    // HR's own session is untouched.
    assert.equal((await hr.get('/api/hr/employees')).status, 200);

    const disabled = await hr.put(`/api/hr/employees/${id}/status`, { status: 'disabled' });
    assert.equal(disabled.body.account.status, 'disabled');
    assert.equal(await hrSessions(), 0);
    assert.equal((await second.get('/api/auth/session')).body.code, 'SESSION_EXPIRED');
    assert.deepEqual((await second.signIn('PC-0001', 'temporary-pass-2')).body, failedSignIn);

    const enabled = await hr.put(`/api/hr/employees/${id}/status`, { status: 'active' });
    assert.equal(enabled.body.account.status, 'active');
    assert.equal((await second.signIn('PC-0001', 'temporary-pass-2')).status, 200);

    // A reset also clears a lock, so HR can let a locked-out employee back in.
    await second.post('/api/auth/sign-out');
    for (let i = 0; i < 5; i++) await second.signIn('PC-0001', `wrong-pass-${i}`);
    assert.equal((await hr.get(`/api/hr/employees/${id}`)).body.employee.account.locked, true);
    await hr.post(`/api/hr/employees/${id}/password`, { temporaryPassword: 'temporary-pass-3' });
    assert.equal((await second.signIn('PC-0001', 'temporary-pass-3')).status, 200);
    const actions = (
      await app.rows(`SELECT action FROM account_events WHERE target_id = '${id}' ORDER BY id`)
    ).map((e) => e.action);
    assert.deepEqual(actions, [
      'employee_created',
      'signed_in',
      'password_changed',
      'signed_in',
      'password_reset',
      'signed_in',
      'account_disabled',
      'account_enabled',
      'signed_in',
      'account_locked',
      'password_reset',
      'signed_in',
    ]);
  });
});

test('creating an employee rolls back the account when the Firestore profile write fails or stalls', async () => {
  await withApp({ storageTimeoutMs: 100 }, async (app) => {
    const hr = await app.hrBrowser();
    const create = () =>
      hr.post('/api/hr/employees', { profile: syntheticProfile('PRIVATE-NAME Example') });
    const count = async () =>
      (await app.rows("SELECT count(*)::int AS n FROM accounts WHERE role = 'employee'"))[0].n;
    app.firestore.fail(14, { only: ['set'] });
    const failed = await create();
    assert.deepEqual([failed.status, failed.body.code], [503, 'PROFILE_STORAGE_UNAVAILABLE']);
    assert.equal(await count(), 0);
    assert.deepEqual(app.firestore.paths('employeeProfiles/'), []);
    // A stalled write times out and is rolled back too.
    app.firestore.fail(0, { only: ['set'], hang: true });
    const stalled = await create();
    assert.deepEqual([stalled.status, stalled.body.code], [504, 'PROFILE_STORAGE_TIMEOUT']);
    assert.equal(await count(), 0);
    const events = await app.rows(
      "SELECT action FROM account_events WHERE action = 'employee_created'",
    );
    assert.deepEqual(events, []);
    // Nothing half-made blocks the next creation. The failed ones used up
    // PC-0001 and PC-0002 (numbers are never handed out twice).
    const created = await create();
    assert.equal(created.status, 201);
    assert.equal(created.body.employee.account.username, 'PC-0003');
    assert.equal(await count(), 1);
    assert.equal(app.firestore.paths('employeeProfiles/').length, 1);
    for (const line of app.logs)
      for (const secret of ['PRIVATE', 'PC-000', created.body.temporaryPassword])
        assert.ok(!line.includes(secret), line);
  });
});

test('account routes reject other origins and report database failures without details', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const foreign = await hr.get('/api/hr/employees', { Origin: 'https://attacker.example' });
    assert.deepEqual([foreign.status, foreign.body.code], [403, 'CROSS_ORIGIN_REJECTED']);
    const signIn = await app
      .browser()
      .post(
        '/api/auth/sign-in',
        { username: 'HR-0001', password: 'synthetic-hr-pass-1' },
        { Origin: 'null' },
      );
    assert.equal(signIn.status, 403);
    assert.equal((await hr.get('/api/hr/employees', { Origin: app.url })).status, 200);
    app.database.fail('08006');
    const down = await hr.get('/api/hr/employees');
    assert.deepEqual(down.body, {
      code: 'ACCOUNTS_UNAVAILABLE',
      error: 'Accounts are temporarily unavailable. Please try again shortly.',
    });
    assert.equal(down.status, 503);
    assert.ok(
      app.logs.includes(
        'Account database request failed: {"operation":"read session","code":"08006"}',
      ),
    );
  });
});
