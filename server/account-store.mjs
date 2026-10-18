import pg from 'pg';
import { ChatError } from './chat-errors.mjs';
import {
  accountErrors,
  companyErrors,
  companyProfileErrors,
  departmentErrors,
} from './account-errors.mjs';
import { formatEmployeeId, prefixPattern, reservedPrefix } from './employee-ids.mjs';
import { DEFAULT_COMPANY_ID, isCompanyId } from './companies.mjs';

// Sign-in data in PostgreSQL (tables in server/migrations/*.sql): accounts,
// sessions (SHA-256 of each token only) and account_events. Every
// time comes from the caller, so tests can move the clock. Database failures
// become 503 ACCOUNTS_UNAVAILABLE; the log records the operation and the
// SQLSTATE or error code only, never values, usernames or connection details.

export function createDatabasePool(databaseUrl, { log = (line) => console.warn(line) } = {}) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    query_timeout: 12000,
    application_name: 'onboardai',
  });
  // An idle client losing its connection must not crash the server.
  pool.on('error', (error) =>
    log('Account database connection error: ' + JSON.stringify({ code: safeCode(error) })),
  );
  return pool;
}

const safeCode = (error) =>
  typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : error?.name || 'UNKNOWN';

const columns =
  'id, username, role, status, must_change_password, failed_attempts, locked_until, ' +
  'created_at, updated_at, last_sign_in_at, created_by, company_id';
const accountColumns = (alias) =>
  columns
    .split(', ')
    .map((column) => `${alias}.${column}`)
    .join(', ');
const uniqueViolation = '23505';
// Active first, then by name (any letter case), then by name itself.
const byDepartment = (a, b) =>
  Number(a.archived) - Number(b.archived) ||
  a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const departmentColumns = 'id, name, prefix, archived, created_at, updated_at, company_id';
// A department as the audit trail records it: no timestamps, no secrets.
const departmentDetail = (row) => ({ id: row.id, name: row.name, prefix: row.prefix });
// Every tenant query needs its company (issue #86): a missing or malformed
// scope is a programming error and fails closed, never an unscoped query.
const scope = (companyId) => {
  if (!isCompanyId(companyId)) throw new TypeError('A company scope is required.');
  return companyId;
};
const companyColumns =
  'c.id, c.name, c.status, c.default_hr_account_id, c.profile_version, c.profile_updated_at, ' +
  'c.created_at, c.updated_at, h.username AS default_hr_username';
// The audit actions of the platform administration (GET /api/admin/events).
export const adminEventActions = Object.freeze([
  'company_created',
  'company_updated',
  'company_disabled',
  'company_enabled',
  'company_profile_updated',
  'company_default_hr_set',
  'hr_account_created',
  'hr_password_reset',
  'admin_created',
  'admin_password_reset',
]);

export function createAccountStore({ pool, log = (line) => console.warn(line) }) {
  function failure(operation, error) {
    if (error instanceof ChatError) return error;
    log('Account database request failed: ' + JSON.stringify({ operation, code: safeCode(error) }));
    return accountErrors.unavailable();
  }
  async function run(operation, text, values) {
    try {
      return await pool.query(text, values);
    } catch (error) {
      throw failure(operation, error);
    }
  }
  // Runs work(query) inside one transaction. Anything work throws (including a
  // Firestore failure) rolls the whole transaction back.
  async function transaction(operation, work) {
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      throw failure(operation, error);
    }
    try {
      await client.query('BEGIN');
      const result = await work((text, values) => client.query(text, values));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw failure(operation, error);
    } finally {
      client.release();
    }
  }
  // Every audit row names its company (null only for platform events such as
  // admin_created): the column's default exists for code from before #86.
  const event = (query, actorId, targetId, action, at, detail, companyId) => {
    if (companyId !== null && !isCompanyId(companyId))
      throw new TypeError('An audit row needs its company.');
    return detail
      ? query(
          'INSERT INTO account_events (actor_id, target_id, action, created_at, detail, company_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [actorId, targetId, action, at, JSON.stringify(detail), companyId],
        )
      : query(
          'INSERT INTO account_events (actor_id, target_id, action, created_at, company_id) VALUES ($1, $2, $3, $4, $5)',
          [actorId, targetId, action, at, companyId],
        );
  };
  // Throws the 409 for a name or prefix another department of the company
  // (exceptId aside) already has.
  async function departmentConflicts(query, companyId, exceptId, name, prefix) {
    const taken = await query(
      `SELECT lower(name) = lower($2) AS same_name, prefix = $3 AS same_prefix
       FROM departments WHERE (lower(name) = lower($2) OR prefix = $3)
         AND ($1::uuid IS NULL OR id <> $1::uuid) AND company_id = $4`,
      [exceptId, name, prefix, scope(companyId)],
    );
    if (taken.rows.some((row) => row.same_name)) throw departmentErrors.nameTaken();
    if (taken.rows.some((row) => row.same_prefix)) throw departmentErrors.prefixTaken();
  }
  // Two requests racing past the check above end here.
  const uniqueDepartmentFailure = (error) =>
    error?.code !== uniqueViolation
      ? error
      : /prefix/.test(String(error.constraint ?? ''))
        ? departmentErrors.prefixTaken()
        : departmentErrors.nameTaken();
  const insertSession = (query, accountId, session) =>
    query(
      'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [session.tokenHash, accountId, session.createdAt, session.expiresAt],
    );
  // Usable for sign-in: active, not locked at `at`, and its company (none for
  // an administrator) active.
  const usable =
    `status = 'active' AND (locked_until IS NULL OR locked_until <= $2) AND ` +
    `(company_id IS NULL OR company_id IN (SELECT id FROM companies WHERE status = 'active'))`;
  // An account row with its company's name and status (null for an administrator).
  const withCompany = (where) =>
    `SELECT ${accountColumns('a')}, a.password_hash, c.name AS company_name, c.status AS company_status
     FROM accounts a LEFT JOIN companies c ON c.id = a.company_id WHERE ${where}`;

  return {
    // The account row with its password hash, for sign-in only.
    async findForSignIn(username) {
      const found = await run('find account', withCompany('lower(a.username) = lower($1)'), [
        username,
      ]);
      return found.rows[0] || null;
    },
    async findById(id) {
      const found = await run('read account', withCompany('a.id = $1'), [id]);
      return found.rows[0] || null;
    },

    // Counts a wrong password for an active, unlocked account. Reaching `limit`
    // consecutive failures locks it until `lockedUntil`; a failure after a lock
    // has ended starts a new count. Returns { locked } for this failure.
    async recordFailure(id, at, { limit, lockedUntil }) {
      return transaction('record failed sign-in', async (query) => {
        const updated = await query(
          `UPDATE accounts SET
             failed_attempts = (CASE WHEN locked_until IS NULL THEN failed_attempts ELSE 0 END) + 1,
             locked_until = CASE
               WHEN (CASE WHEN locked_until IS NULL THEN failed_attempts ELSE 0 END) + 1 >= $3
               THEN $4::timestamptz ELSE NULL END
           WHERE id = $1 AND ${usable}
           RETURNING locked_until`,
          [id, at, limit, lockedUntil],
        );
        const locked = Boolean(updated.rows[0]?.locked_until);
        if (locked) {
          const owner = await query('SELECT company_id FROM accounts WHERE id = $1', [id]);
          await event(
            query,
            null,
            id,
            'account_locked',
            at,
            null,
            owner.rows[0]?.company_id ?? null,
          );
        }
        return { locked };
      });
    },

    // Opens a session for an account that is still active and unlocked; returns
    // false if it changed since the password was checked. A session cookie the
    // browser already had is deleted (rotation), as are expired sessions.
    async signIn(id, at, session, replacedHash) {
      return transaction('sign in', async (query) => {
        const updated = await query(
          `UPDATE accounts SET failed_attempts = 0, locked_until = NULL, last_sign_in_at = $2
           WHERE id = $1 AND ${usable} RETURNING id, company_id`,
          [id, at],
        );
        if (!updated.rows.length) return false;
        if (replacedHash) await query('DELETE FROM sessions WHERE token_hash = $1', [replacedHash]);
        await query('DELETE FROM sessions WHERE expires_at <= $1', [at]);
        await insertSession(query, id, session);
        await event(query, id, id, 'signed_in', at, null, updated.rows[0].company_id ?? null);
        return true;
      });
    },
    async sessionAccount(tokenHash) {
      const found = await run(
        'read session',
        `SELECT ${accountColumns('a')}, s.created_at AS session_created_at,
                s.expires_at AS session_expires_at, c.name AS company_name,
                c.status AS company_status
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         LEFT JOIN companies c ON c.id = a.company_id
         WHERE s.token_hash = $1`,
        [tokenHash],
      );
      return found.rows[0] || null;
    },
    async deleteSession(tokenHash) {
      await run('sign out', 'DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },

    // New password chosen by the account itself (active and unlocked): clears
    // the forced change, ends every session of the account and opens a fresh
    // one (rotation). Returns null if the account is disabled or locked.
    async changePassword(id, passwordHash, at, session) {
      return transaction('change password', async (query) => {
        const updated = await query(
          `UPDATE accounts SET password_hash = $3, must_change_password = false,
             failed_attempts = 0, locked_until = NULL, updated_at = $2
           WHERE id = $1 AND ${usable} RETURNING ${columns}`,
          [id, at, passwordHash],
        );
        if (!updated.rows.length) return null;
        await query('DELETE FROM sessions WHERE account_id = $1', [id]);
        await insertSession(query, id, session);
        await event(
          query,
          id,
          id,
          'password_changed',
          at,
          null,
          updated.rows[0].company_id ?? null,
        );
        return updated.rows[0];
      });
    },

    // Inserts an account and its event, then runs during(account, query)
    // before the commit. If during throws (for example the Firestore profile
    // write fails), nothing is kept. A taken username is 409 USERNAME_TAKEN.
    // companyId: the company of an hr or employee account; null for an admin.
    async createAccount(
      { username, passwordHash, role, mustChangePassword, createdBy = null, action, at, companyId },
      during = null,
    ) {
      const company = role === 'admin' ? null : companyId ? scope(companyId) : DEFAULT_COMPANY_ID;
      if (role === 'admin' && companyId != null)
        throw new TypeError('An administrator belongs to no company.');
      return transaction('create account', async (query) => {
        let inserted;
        try {
          inserted = await query(
            `INSERT INTO accounts (username, password_hash, role, must_change_password,
               created_at, updated_at, created_by, company_id)
             VALUES ($1, $2, $3, $4, $5, $5, $6, $7) RETURNING ${columns}`,
            [username, passwordHash, role, mustChangePassword, at, createdBy, company],
          );
        } catch (error) {
          if (error?.code === uniqueViolation) throw accountErrors.usernameTaken();
          throw error;
        }
        const account = inserted.rows[0];
        await event(query, createdBy, account.id, action, at, null, company);
        if (during) await during(account, query);
        return account;
      });
    },

    // Creates an employee account under the next Employee ID for `prefix`
    // (PE-0001, PE-0002, ...; see employee-ids.mjs), records employee_created
    // and runs during(account) before the commit. The number is taken from
    // employee_id_counters inside this transaction: the counter row stays
    // locked until the commit, so concurrent creates for one prefix get
    // distinct, consecutive numbers, and a counter never falls below the
    // highest existing username with its prefix. If the insert or during fails
    // (for example the Firestore profile write), the transaction rolls back to
    // the savepoint taken after the allocation and commits: the account, its
    // event and the profile are gone, but the number stays used (a gap), as it
    // does after a deletion. Only a database failure undoes the allocation too.
    // A username that is taken anyway (an account made outside this counter) is
    // 409 USERNAME_TAKEN; its number is used up as well.
    async createEmployee({ prefix, passwordHash, createdBy, at, companyId }, during = null) {
      if (prefix === reservedPrefix) throw new TypeError('HR is not an employee prefix.');
      return this.createNumbered(
        {
          prefix,
          role: 'employee',
          action: 'employee_created',
          passwordHash,
          createdBy,
          at,
          companyId,
        },
        during,
      );
    },
    // The numbered account behind createEmployee (PE-0001, role employee) and
    // the administrator's "Create HR account" (HR-0002, role hr, issue #86):
    // the next number for `prefix` from employee_id_counters, which is counted
    // across all companies so every username stays unique, a forced password
    // change, `action` as the audit row, and during(account, query) before the
    // commit, with the same savepoint rules.
    async createNumbered(
      { prefix, role, action, passwordHash, createdBy, at, companyId },
      during = null,
    ) {
      if (!prefixPattern.test(prefix)) throw new TypeError('Unknown Employee ID prefix.');
      if (!['hr', 'employee'].includes(role)) throw new TypeError('Unknown numbered role.');
      const company = companyId ? scope(companyId) : DEFAULT_COMPANY_ID;
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        throw failure(`create ${role}`, error);
      }
      let open = false;
      try {
        await client.query('BEGIN');
        open = true;
        const allocated = await client.query(
          `INSERT INTO employee_id_counters AS c (prefix, last_number)
           SELECT $1, COALESCE(MAX(CAST(substring(upper(username) FROM ${prefix.length + 2}) AS integer)), 0) + 1
           FROM accounts WHERE upper(username) ~ $2
           ON CONFLICT (prefix) DO UPDATE
             SET last_number = GREATEST(c.last_number + 1, EXCLUDED.last_number)
           RETURNING last_number`,
          [prefix, `^${prefix}-[0-9]{1,9}$`],
        );
        const username = formatEmployeeId(prefix, allocated.rows[0].last_number);
        await client.query('SAVEPOINT employee_account');
        let account;
        try {
          const inserted = await client.query(
            `INSERT INTO accounts (username, password_hash, role, must_change_password,
               created_at, updated_at, created_by, company_id)
             VALUES ($1, $2, $5, true, $3, $3, $4, $6) RETURNING ${columns}`,
            [username, passwordHash, at, createdBy, role, company],
          );
          account = inserted.rows[0];
          const query = (text, values) => client.query(text, values);
          await event(query, createdBy, account.id, action, at, null, company);
          if (during) await during(account, query);
        } catch (error) {
          // Keep the number: undo everything after the allocation, then commit.
          await client.query('ROLLBACK TO SAVEPOINT employee_account');
          await client.query('COMMIT');
          open = false;
          throw error?.code === uniqueViolation ? accountErrors.usernameTaken() : error;
        }
        await client.query('COMMIT');
        open = false;
        return account;
      } catch (error) {
        if (open) await client.query('ROLLBACK').catch(() => {});
        throw failure(`create ${role}`, error);
      } finally {
        client.release();
      }
    },

    // HR actions on employee accounts. Each returns the updated row, or null
    // when no employee account has that ID.
    async resetPassword(actorId, companyId, id, passwordHash, at) {
      const company = scope(companyId);
      return transaction('reset password', async (query) => {
        const updated = await query(
          `UPDATE accounts SET password_hash = $3, must_change_password = true,
             failed_attempts = 0, locked_until = NULL, updated_at = $2
           WHERE id = $1 AND role = 'employee' AND company_id = $4 RETURNING ${columns}`,
          [id, at, passwordHash, company],
        );
        if (!updated.rows.length) return null;
        await query('DELETE FROM sessions WHERE account_id = $1', [id]);
        await event(query, actorId, id, 'password_reset', at, null, company);
        return updated.rows[0];
      });
    },
    // Recovery for an HR or admin account (npm run hr:reset-password and
    // admin:reset-password, no actor): a new password with no forced change,
    // the lock cleared and every session ended. Returns null when no account
    // of that role has that ID (any letter case).
    async resetHrPassword(username, passwordHash, at, { role = 'hr' } = {}) {
      if (!['hr', 'admin'].includes(role)) throw new TypeError('Only hr or admin accounts.');
      return transaction(`reset ${role} password`, async (query) => {
        const updated = await query(
          `UPDATE accounts SET password_hash = $3, must_change_password = false,
             failed_attempts = 0, locked_until = NULL, updated_at = $2
           WHERE lower(username) = lower($1) AND role = $4 RETURNING ${columns}`,
          [username, at, passwordHash, role],
        );
        const account = updated.rows[0];
        if (!account) return null;
        await query('DELETE FROM sessions WHERE account_id = $1', [account.id]);
        await event(
          query,
          null,
          account.id,
          `${role}_password_reset`,
          at,
          null,
          account.company_id ?? null,
        );
        return account;
      });
    },
    async setStatus(actorId, companyId, id, status, at) {
      const company = scope(companyId);
      return transaction('set account status', async (query) => {
        const updated = await query(
          `UPDATE accounts SET status = $3, updated_at = $2
           WHERE id = $1 AND role = 'employee' AND company_id = $4 RETURNING ${columns}`,
          [id, at, status, company],
        );
        if (!updated.rows.length) return null;
        if (status === 'disabled') await query('DELETE FROM sessions WHERE account_id = $1', [id]);
        await event(
          query,
          actorId,
          id,
          status === 'disabled' ? 'account_disabled' : 'account_enabled',
          at,
          null,
          company,
        );
        return updated.rows[0];
      });
    },
    // Records an event for an employee and runs during(account) before the
    // commit; returns null when no employee account has that ID. `detail` is
    // optional ID-only context for the audit row (an onboarding step id and
    // status, a support request id), never personal values.
    // An audit row with no target account (company library changes): the
    // event is inserted, then during() runs (the Firestore write), then the
    // commit; a failure in during() rolls the row back. Resolves to what
    // during() returned. `detail` carries ids only.
    async recordEvent(actorId, companyId, action, at, detail, during) {
      const company = scope(companyId);
      return transaction(action.replaceAll('_', ' '), async (query) => {
        await event(query, actorId, null, action, at, detail, company);
        return during();
      });
    },
    async employeeChange(actorId, companyId, id, action, at, during, detail = null) {
      const company = scope(companyId);
      return transaction(action.replaceAll('_', ' '), async (query) => {
        const found = await query(
          `SELECT ${columns} FROM accounts WHERE id = $1 AND role = 'employee' AND company_id = $2`,
          [id, company],
        );
        const account = found.rows[0];
        if (!account) return null;
        await event(query, actorId, id, action, at, detail, company);
        await during(account);
        return account;
      });
    },
    // Signs an employee out everywhere (the first step of deleting the account,
    // so no new chat data is made while Firestore is cleaned up).
    async endEmployeeSessions(companyId, id) {
      await run(
        'end employee sessions',
        `DELETE FROM sessions WHERE account_id IN
           (SELECT id FROM accounts WHERE id = $1 AND role = 'employee' AND company_id = $2)`,
        [id, scope(companyId)],
      );
    },
    // Deletes an employee account (sessions cascade) and records
    // employee_deleted. Every event about the account keeps its username in
    // target_label, since target_id becomes NULL. Returns the deleted row, or
    // null when no employee account has that ID (HR accounts included).
    async deleteEmployee(actorId, companyId, id, at) {
      const company = scope(companyId);
      return transaction('delete employee', async (query) => {
        const found = await query(
          `SELECT ${columns} FROM accounts WHERE id = $1 AND role = 'employee' AND company_id = $2`,
          [id, company],
        );
        const account = found.rows[0];
        if (!account) return null;
        await query('UPDATE account_events SET target_label = $2 WHERE target_id = $1', [
          id,
          account.username,
        ]);
        await query(`DELETE FROM accounts WHERE id = $1 AND role = 'employee'`, [id]);
        await query(
          `INSERT INTO account_events (actor_id, target_id, target_label, action, created_at, company_id)
           VALUES ($1, NULL, $2, 'employee_deleted', $3, $4)`,
          [actorId, account.username, at, company],
        );
        return account;
      });
    },
    // Departments (issue #36). The table is the one list of departments and
    // prefixes; archived ones are kept. Order: active first, then by name.
    async listDepartments(companyId) {
      const found = await run(
        'list departments',
        `SELECT ${departmentColumns} FROM departments WHERE company_id = $1`,
        [scope(companyId)],
      );
      return found.rows.sort(byDepartment);
    },
    async activeDepartments(companyId) {
      const found = await run(
        'list active departments',
        `SELECT ${departmentColumns} FROM departments WHERE archived = false AND company_id = $1`,
        [scope(companyId)],
      );
      return found.rows.sort(byDepartment);
    },
    async department(companyId, id) {
      const found = await run(
        'read department',
        `SELECT ${departmentColumns} FROM departments WHERE id = $1 AND company_id = $2`,
        [id, scope(companyId)],
      );
      return found.rows[0] || null;
    },
    // 409 DEPARTMENT_NAME_TAKEN / DEPARTMENT_PREFIX_TAKEN when another
    // department of the company (archived ones too) has the name (any letter
    // case) or prefix.
    async createDepartment(actorId, companyId, { name, prefix }, at) {
      const company = scope(companyId);
      return transaction('create department', async (query) => {
        await departmentConflicts(query, company, null, name, prefix);
        let inserted;
        try {
          inserted = await query(
            `INSERT INTO departments (name, prefix, archived, created_at, updated_at, company_id)
             VALUES ($1, $2, false, $3, $3, $4) RETURNING ${departmentColumns}`,
            [name, prefix, at, company],
          );
        } catch (error) {
          throw uniqueDepartmentFailure(error);
        }
        const department = inserted.rows[0];
        await event(
          query,
          actorId,
          null,
          'department_created',
          at,
          { department: departmentDetail(department) },
          company,
        );
        return department;
      });
    },
    // Applies changes ({ name?, prefix?, archived? }) and records the events,
    // then runs during(before, after) before the commit; if it throws (the
    // Firestore profile rename), nothing is kept. Returns { before, after },
    // or null when no department has that ID. Nothing changes (and no event is
    // recorded) when the values are the ones already stored.
    async updateDepartment(actorId, companyId, id, changes, at, during = null) {
      const company = scope(companyId);
      return transaction('update department', async (query) => {
        const found = await query(
          `SELECT ${departmentColumns} FROM departments WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [id, company],
        );
        const before = found.rows[0];
        if (!before) return null;
        const next = {
          name: changes.name ?? before.name,
          prefix: changes.prefix ?? before.prefix,
          archived: changes.archived ?? before.archived,
        };
        const nameChanged = next.name !== before.name,
          prefixChanged = next.prefix !== before.prefix,
          archivedChanged = next.archived !== before.archived;
        if (!nameChanged && !prefixChanged && !archivedChanged) return { before, after: before };
        await departmentConflicts(query, company, id, next.name, next.prefix);
        let updated;
        try {
          updated = await query(
            `UPDATE departments SET name = $2, prefix = $3, archived = $4, updated_at = $5
             WHERE id = $1 RETURNING ${departmentColumns}`,
            [id, next.name, next.prefix, next.archived, at],
          );
        } catch (error) {
          throw uniqueDepartmentFailure(error);
        }
        const after = updated.rows[0];
        if (nameChanged || prefixChanged)
          await event(
            query,
            actorId,
            null,
            'department_updated',
            at,
            {
              department: departmentDetail(after),
              changes: {
                ...(nameChanged ? { name: { from: before.name, to: after.name } } : {}),
                ...(prefixChanged ? { prefix: { from: before.prefix, to: after.prefix } } : {}),
              },
            },
            company,
          );
        if (archivedChanged)
          await event(
            query,
            actorId,
            null,
            after.archived ? 'department_archived' : 'department_restored',
            at,
            { department: departmentDetail(after) },
            company,
          );
        if (during) await during(before, after);
        return { before, after };
      });
    },
    async employee(companyId, id) {
      const found = companyId
        ? await run(
            'read employee',
            `SELECT ${columns} FROM accounts WHERE id = $1 AND role = 'employee' AND company_id = $2`,
            [id, scope(companyId)],
          )
        : await run(
            'read employee',
            `SELECT ${columns} FROM accounts WHERE id = $1 AND role = 'employee'`,
            [id],
          );
      return found.rows[0] || null;
    },
    async listEmployees(companyId, limit = 500) {
      const found = await run(
        'list employees',
        `SELECT ${columns} FROM accounts WHERE role = 'employee' AND company_id = $2
         ORDER BY lower(username) LIMIT $1`,
        [limit, scope(companyId)],
      );
      return found.rows;
    },

    // --- Companies (issue #86, the platform administrator) --------------------
    // Rows: companyColumns plus counts { hr, employees }, by status then name.
    async listCompanies() {
      const [companies, counts] = await Promise.all([
        run(
          'list companies',
          `SELECT ${companyColumns} FROM companies c
           LEFT JOIN accounts h ON h.id = c.default_hr_account_id`,
        ),
        run(
          'count company accounts',
          `SELECT company_id, role, count(*)::int AS n FROM accounts
           WHERE company_id IS NOT NULL GROUP BY company_id, role`,
        ),
      ]);
      const tally = new Map();
      for (const row of counts.rows) {
        const entry = tally.get(row.company_id) || { hr: 0, employees: 0 };
        if (row.role === 'hr') entry.hr = Number(row.n);
        if (row.role === 'employee') entry.employees = Number(row.n);
        tally.set(row.company_id, entry);
      }
      return companies.rows
        .map((row) => ({ ...row, counts: tally.get(row.id) || { hr: 0, employees: 0 } }))
        .sort(
          (a, b) =>
            Number(a.status !== 'active') - Number(b.status !== 'active') ||
            a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en'),
        );
    },
    async company(id) {
      if (!isCompanyId(id)) return null;
      const [found, counts] = await Promise.all([
        run(
          'read company',
          `SELECT ${companyColumns} FROM companies c
           LEFT JOIN accounts h ON h.id = c.default_hr_account_id WHERE c.id = $1`,
          [id],
        ),
        run(
          'count company accounts',
          `SELECT role, count(*)::int AS n FROM accounts WHERE company_id = $1 GROUP BY role`,
          [id],
        ),
      ]);
      const row = found.rows[0];
      if (!row) return null;
      const pick = (role) => Number(counts.rows.find((r) => r.role === role)?.n || 0);
      return { ...row, counts: { hr: pick('hr'), employees: pick('employee') } };
    },
    // Creates the company under the first free id of `ids` (an explicit id is
    // the only candidate), with `departments` ([{ name, prefix }]) seeded in the
    // same transaction and one company_created event. 409 COMPANY_NAME_TAKEN /
    // COMPANY_ID_TAKEN.
    async createCompany(actorId, { ids, name }, at, departments = []) {
      return transaction('create company', async (query) => {
        const sameName = await query('SELECT id FROM companies WHERE lower(name) = lower($1)', [
          name,
        ]);
        if (sameName.rows.length) throw companyErrors.nameTaken();
        let id = null;
        for (const candidate of ids) {
          const taken = await query('SELECT id FROM companies WHERE id = $1', [candidate]);
          if (!taken.rows.length) {
            id = candidate;
            break;
          }
        }
        if (!id) throw companyErrors.idTaken();
        try {
          await query(
            `INSERT INTO companies (id, name, status, created_at, updated_at, created_by)
             VALUES ($1, $2, 'active', $3, $3, $4)`,
            [id, name, at, actorId],
          );
        } catch (error) {
          if (error?.code === uniqueViolation) throw companyErrors.nameTaken();
          throw error;
        }
        for (const department of departments)
          await query(
            `INSERT INTO departments (name, prefix, archived, created_at, updated_at, company_id)
             VALUES ($1, $2, false, $3, $3, $4)`,
            [department.name, department.prefix, at, id],
          );
        await event(
          query,
          actorId,
          null,
          'company_created',
          at,
          { company: { id, name }, seededDepartments: departments.length },
          id,
        );
        return id;
      });
    },
    // Renames a company; nothing changes (and no event) for the same name.
    // Resolves to false for an unknown id.
    async renameCompany(actorId, id, name, at) {
      return transaction('rename company', async (query) => {
        const found = await query('SELECT id, name FROM companies WHERE id = $1 FOR UPDATE', [id]);
        const before = found.rows[0];
        if (!before) return false;
        if (before.name === name) return true;
        const taken = await query(
          'SELECT id FROM companies WHERE lower(name) = lower($1) AND id <> $2',
          [name, id],
        );
        if (taken.rows.length) throw companyErrors.nameTaken();
        try {
          await query('UPDATE companies SET name = $2, updated_at = $3 WHERE id = $1', [
            id,
            name,
            at,
          ]);
        } catch (error) {
          if (error?.code === uniqueViolation) throw companyErrors.nameTaken();
          throw error;
        }
        await event(
          query,
          actorId,
          null,
          'company_updated',
          at,
          { changes: { name: { from: before.name, to: name } } },
          id,
        );
        return true;
      });
    },
    // Disabling ends every session of the company's accounts in the same
    // transaction (sign-in and session checks also read the status).
    async setCompanyStatus(actorId, id, status, at) {
      return transaction('set company status', async (query) => {
        const found = await query('SELECT id, status FROM companies WHERE id = $1 FOR UPDATE', [
          id,
        ]);
        const before = found.rows[0];
        if (!before) return false;
        if (before.status === status) return true;
        await query('UPDATE companies SET status = $2, updated_at = $3 WHERE id = $1', [
          id,
          status,
          at,
        ]);
        if (status === 'disabled')
          await query(
            'DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE company_id = $1)',
            [id],
          );
        await event(
          query,
          actorId,
          null,
          status === 'disabled' ? 'company_disabled' : 'company_enabled',
          at,
          { company: { id } },
          id,
        );
        return true;
      });
    },
    // { profile, version, updatedAt, updatedBy: { id, username } | null }, or null.
    async companyProfile(id) {
      if (!isCompanyId(id)) return null;
      const found = await run(
        'read company profile',
        `SELECT c.profile, c.profile_version, c.profile_updated_at, c.profile_updated_by,
                u.username AS profile_updated_by_username
         FROM companies c LEFT JOIN accounts u ON u.id = c.profile_updated_by WHERE c.id = $1`,
        [id],
      );
      const row = found.rows[0];
      if (!row) return null;
      return {
        profile: typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile || {},
        version: Number(row.profile_version) || 0,
        updatedAt: row.profile_updated_at,
        updatedBy: row.profile_updated_by
          ? { id: row.profile_updated_by, username: row.profile_updated_by_username || null }
          : null,
      };
    },
    // Replaces the profile when `version` is the stored one (else 409
    // COMPANY_PROFILE_CONFLICT). same(stored) tells whether the stored profile
    // already equals the new one: then nothing changes and no event is written.
    // Resolves to false for an unknown company.
    async saveCompanyProfile(actorId, id, profile, version, at, same) {
      return transaction('save company profile', async (query) => {
        const found = await query(
          'SELECT profile, profile_version FROM companies WHERE id = $1 FOR UPDATE',
          [id],
        );
        const row = found.rows[0];
        if (!row) return false;
        if (Number(row.profile_version) !== version) throw companyProfileErrors.conflict();
        const stored = typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile;
        if (same(stored || {})) return true;
        const next = version + 1;
        await query(
          `UPDATE companies SET profile = $2::jsonb, profile_version = $3, profile_updated_at = $4,
             profile_updated_by = $5, updated_at = $4 WHERE id = $1`,
          [id, JSON.stringify(profile), next, at, actorId],
        );
        await event(query, actorId, null, 'company_profile_updated', at, { version: next }, id);
        return true;
      });
    },
    async listCompanyHr(companyId) {
      const found = await run(
        'list company HR accounts',
        `SELECT ${columns} FROM accounts WHERE role = 'hr' AND company_id = $1
         ORDER BY lower(username)`,
        [scope(companyId)],
      );
      return found.rows;
    },
    // Makes an HR account of the company its default HR. Resolves to
    // 'company' (unknown company), 'account' (not an HR account of it) or true.
    async setDefaultHr(actorId, companyId, accountId, at, query = null) {
      const work = async (q) => {
        const found = await q(
          'SELECT id, default_hr_account_id FROM companies WHERE id = $1 FOR UPDATE',
          [companyId],
        );
        if (!found.rows[0]) return 'company';
        const account = await q(
          `SELECT id, username FROM accounts WHERE id = $1 AND role = 'hr' AND company_id = $2`,
          [accountId, companyId],
        );
        if (!account.rows[0]) return 'account';
        if (found.rows[0].default_hr_account_id === accountId) return true;
        await q('UPDATE companies SET default_hr_account_id = $2, updated_at = $3 WHERE id = $1', [
          companyId,
          accountId,
          at,
        ]);
        await event(
          q,
          actorId,
          accountId,
          'company_default_hr_set',
          at,
          { accountId, username: account.rows[0].username },
          companyId,
        );
        return true;
      };
      if (query) return work(query);
      return transaction('set default HR', work);
    },
    async resetHrPasswordByAdmin(actorId, companyId, accountId, passwordHash, at) {
      const company = scope(companyId);
      return transaction('reset hr password by admin', async (query) => {
        const found = await query('SELECT id, default_hr_account_id FROM companies WHERE id = $1', [
          company,
        ]);
        if (!found.rows[0]) return 'company';
        const updated = await query(
          `UPDATE accounts SET password_hash = $3, must_change_password = true,
             failed_attempts = 0, locked_until = NULL, updated_at = $2
           WHERE id = $1 AND role = 'hr' AND company_id = $4 RETURNING ${columns}`,
          [accountId, at, passwordHash, company],
        );
        const account = updated.rows[0];
        if (!account) return 'account';
        await query('DELETE FROM sessions WHERE account_id = $1', [account.id]);
        await event(query, actorId, account.id, 'hr_password_reset', at, null, company);
        return { account, isDefault: account.id === found.rows[0].default_hr_account_id };
      });
    },
    // GET /api/admin/events: the administration's audit rows, newest first.
    async listAdminEvents({ companyId = null, before = null, limit = 50 } = {}) {
      const found = await run(
        'list admin events',
        `SELECT e.id, e.action, e.created_at, e.company_id, e.detail, e.target_label,
                e.actor_id, ac.username AS actor_username,
                e.target_id, t.username AS target_username
         FROM account_events e
         LEFT JOIN accounts ac ON ac.id = e.actor_id
         LEFT JOIN accounts t ON t.id = e.target_id
         WHERE e.action IN (${adminEventActions.map((action) => `'${action}'`).join(', ')})
           AND ($1::text IS NULL OR e.company_id = $1)
           AND ($2::bigint IS NULL OR e.id < $2)
         ORDER BY e.id DESC LIMIT $3`,
        [companyId, before, limit],
      );
      return found.rows;
    },
    close: () => pool.end(),
  };
}
