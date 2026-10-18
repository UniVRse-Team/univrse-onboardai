import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, migrationFiles, migrationsDirectory } from '../../server/database-migrations.mjs';
import { createAccountStore } from '../../server/account-store.mjs';
import { DEFAULT_COMPANY_ID } from '../../server/companies.mjs';
import { createTestDatabase } from './test-database.mjs';

const at = new Date('2026-10-15T01:00:00.000Z');
const hash = 'scrypt$n=1024,r=8,p=1$synthetic$synthetic';

test('migrations are plain SQL files, applied once and recorded in schema_migrations', async () => {
  const all = [
    '001_accounts.sql',
    '002_account_event_labels.sql',
    '003_employee_id_counters.sql',
    '004_departments.sql',
    '005_companies.sql',
    '006_company_luna_digital.sql',
  ];
  assert.deepEqual(migrationFiles(), all);
  const sql = readFileSync(join(migrationsDirectory, '001_accounts.sql'), 'utf8');
  for (const table of ['accounts', 'sessions', 'account_events'])
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
  const database = await createTestDatabase();
  assert.deepEqual(database.migrated, { applied: all, skipped: [] });
  // Running again changes nothing.
  assert.deepEqual(await migrate(database.pool), { applied: [], skipped: all });
  assert.deepEqual(await migrate(database.pool), { applied: [], skipped: all });
  assert.deepEqual(
    (await database.rows('SELECT name FROM schema_migrations ORDER BY name')).map(
      (row) => row.name,
    ),
    all,
  );
  const columns = await database.rows(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name IN ('accounts', 'sessions', 'account_events')`,
  );
  const of = (table) =>
    columns
      .filter((c) => c.table_name === table)
      .map((c) => c.column_name)
      .sort();
  assert.deepEqual(of('accounts'), [
    'company_id',
    'created_at',
    'created_by',
    'failed_attempts',
    'id',
    'last_sign_in_at',
    'locked_until',
    'must_change_password',
    'password_hash',
    'role',
    'status',
    'updated_at',
    'username',
  ]);
  assert.deepEqual(of('sessions'), ['account_id', 'created_at', 'expires_at', 'token_hash']);
  // Events hold who, whom (and a deleted account's username), what and when,
  // and for department changes a detail object: no column for secrets or
  // profile values.
  assert.deepEqual(of('account_events'), [
    'action',
    'actor_id',
    'company_id',
    'created_at',
    'detail',
    'id',
    'target_id',
    'target_label',
  ]);
});

test('002 adds target_label safely: its statements can run again, and only an ID fits', async () => {
  const database = await createTestDatabase();
  // The file itself is idempotent, not only its record in schema_migrations.
  const sql = readFileSync(join(migrationsDirectory, '002_account_event_labels.sql'), 'utf8');
  await database.pool.query(sql);
  await database.pool.query(sql);
  await database.pool.query(
    "INSERT INTO account_events (target_label, action) VALUES ('EMP-0001', 'employee_deleted')",
  );
  for (const label of ['not an id', 'x', 'a'.repeat(33)])
    await assert.rejects(
      database.pool.query(
        "INSERT INTO account_events (target_label, action) VALUES ($1, 'employee_deleted')",
        [label],
      ),
    );
});

test('the database enforces unique IDs regardless of case, the ID format, roles, statuses and hash format', async () => {
  const database = await createTestDatabase();
  const insert = (username, { role = 'employee', status = 'active', password = hash } = {}) =>
    database.pool.query(
      'INSERT INTO accounts (username, password_hash, role, status) VALUES ($1, $2, $3, $4)',
      [username, password, role, status],
    );
  await insert('EMP-0001');
  await assert.rejects(insert('emp-0001'), (error) => error.code === '23505');
  await insert('EMP.0002_x');
  for (const bad of ['ab', 'x'.repeat(33), 'has space', 'EMP/0003', 'émp-0004'])
    await assert.rejects(insert(bad), undefined, bad);
  await assert.rejects(insert('EMP-0005', { role: 'admin' }));
  await assert.rejects(insert('EMP-0006', { status: 'paused' }));
  await assert.rejects(insert('EMP-0007', { password: 'plain-text-password' }));
  await assert.rejects(
    database.pool.query(
      `INSERT INTO sessions (token_hash, account_id, expires_at)
       SELECT 'NOT-A-HASH', id, now() FROM accounts LIMIT 1`,
    ),
  );
});

test('the account store maps a taken username to 409 and database failures to a fixed 503 with a code-only log', async () => {
  const database = await createTestDatabase(),
    logs = [];
  const store = createAccountStore({ pool: database.pool, log: (line) => logs.push(line) });
  const fields = {
    username: 'EMP-0001',
    passwordHash: hash,
    role: 'employee',
    mustChangePassword: true,
    action: 'employee_created',
    at,
    companyId: DEFAULT_COMPANY_ID,
  };
  const account = await store.createAccount(fields);
  assert.equal(account.username, 'EMP-0001');
  assert.equal(account.must_change_password, true);
  await assert.rejects(store.createAccount({ ...fields, username: 'Emp-0001' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'USERNAME_TAKEN');
    return true;
  });
  // The failed insert left nothing behind, including its event.
  assert.equal((await database.rows('SELECT count(*)::int AS n FROM accounts'))[0].n, 1);
  assert.equal((await database.rows('SELECT count(*)::int AS n FROM account_events'))[0].n, 1);
  database.fail('57P01');
  await assert.rejects(store.findForSignIn('EMP-0001'), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'ACCOUNTS_UNAVAILABLE');
    return true;
  });
  assert.deepEqual(logs, [
    'Account database request failed: {"operation":"find account","code":"57P01"}',
  ]);
});
