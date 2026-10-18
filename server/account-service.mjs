import { createHash, randomBytes } from 'node:crypto';
import { accountErrors, companyErrors, departmentErrors } from './account-errors.mjs';
import { createAccountStore, createDatabasePool } from './account-store.mjs';
import { formatEmployeeId, prefixPattern, reservedPrefix } from './employee-ids.mjs';
import { createFirestoreClient } from './firestore-client.mjs';
import { trackOf } from './onboarding-content.mjs';
import {
  DEFAULT_COMPANY_ID,
  companyIdFromName,
  companyIdPattern,
  companyNameMax,
  isCompanyId,
} from './companies.mjs';
import { departments as defaultDepartments } from './departments.mjs';
import { presentCompanyProfile, validateCompanyProfile } from './company-profile.mjs';
import {
  asProfileStorageError,
  createProfileStore,
  profileSummary,
  validateProfile,
} from './employee-profiles.mjs';
import {
  dummyPasswordHash,
  generatePassword,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from './password-hashing.mjs';

// HR and employee accounts: sign-in, sessions, forced password changes and the
// HR actions. PostgreSQL holds the accounts (account-store.mjs); Firestore holds
// the personal profiles (employee-profiles.mjs). No plaintext password or
// session token is stored or logged; only their scrypt hash and SHA-256.
export const SESSION_MS = 12 * 60 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
export const MAX_FAILED_SIGN_INS = 5;
export const usernamePattern = /^[A-Za-z0-9._-]{3,32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
// A well-formed ID that no account has.
const noAccount = '00000000-0000-0000-0000-000000000000';
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const iso = (value) => (value ? new Date(value).toISOString() : null);
const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
// A server-assigned Employee ID can only be taken by an account made outside
// the counter (hr:create); each try uses up a number, so a few are enough.
const employeeIdAttempts = 3;
const lockedAt = (row, at) => Boolean(row.locked_until) && new Date(row.locked_until) > at;

// Department names (issue #36): one line, trimmed, 1 to 60 characters.
export const departmentNameMax = 60;
const controlCharacters = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
// The check for one department field: { value } or { problem }.
function checkDepartmentField(field, raw) {
  if (raw === undefined || raw === null) return { problem: 'required' };
  if (typeof raw !== 'string') return { problem: 'invalid_format' };
  const value = raw.trim();
  if (!value) return { problem: 'required' };
  if (field === 'name') {
    if ([...value].length > departmentNameMax) return { problem: 'too_long' };
    if (controlCharacters.test(value)) return { problem: 'invalid_format' };
  } else {
    if (!prefixPattern.test(value)) return { problem: 'invalid_format' };
    if (value === reservedPrefix) return { problem: 'reserved' };
  }
  return { value };
}

// What a signed-in browser learns about its own account.
const selfView = (row, expiresAt) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  mustChangePassword: row.must_change_password,
  sessionExpiresAt: iso(expiresAt),
  companyId: row.company_id ?? null,
  company:
    row.company_id && row.company_name
      ? { id: row.company_id, name: row.company_name, status: row.company_status || 'active' }
      : null,
});
// What HR sees about an employee account. Never the password hash.
export const accountView = (row, at) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  status: row.status,
  mustChangePassword: row.must_change_password,
  locked: lockedAt(row, at),
  lockedUntil: lockedAt(row, at) ? iso(row.locked_until) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  lastSignInAt: iso(row.last_sign_in_at),
});

export const companySummaryView = (row) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  defaultHr: row.default_hr_account_id
    ? { id: row.default_hr_account_id, username: row.default_hr_username || null }
    : null,
  counts: row.counts || { hr: 0, employees: 0 },
  profileVersion: Number(row.profile_version) || 0,
  profileUpdatedAt: iso(row.profile_updated_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export const hrAccountView = (row, at, defaultHrId = null) => ({
  id: row.id,
  username: row.username,
  status: row.status,
  mustChangePassword: row.must_change_password,
  locked: lockedAt(row, at),
  createdAt: iso(row.created_at),
  lastSignInAt: iso(row.last_sign_in_at),
  isDefault: defaultHrId !== null ? row.id === defaultHrId : Boolean(row.is_default),
});

// Builds the real backends from accountSettings(env).
export function createAccountBackends(settings) {
  return {
    store: createAccountStore({ pool: createDatabasePool(settings.databaseUrl) }),
    profiles: createProfileStore({ firestore: createFirestoreClient(settings.firestore) }),
  };
}

export function createAccountService({
  store,
  profiles,
  now = () => new Date(),
  hashing = { hash: hashPassword, verify: verifyPassword, dummy: dummyPasswordHash },
  sessionMs = SESSION_MS,
  lockMs = LOCK_MS,
  maxFailures = MAX_FAILED_SIGN_INS,
  log = (line) => console.warn(line),
}) {
  // Made now, so the first unknown-ID sign-in costs no more than any other.
  hashing.dummy().catch(() => {});
  const newSession = (at) => {
    const token = randomBytes(32).toString('hex');
    return {
      token,
      tokenHash: tokenHash(token),
      createdAt: at,
      expiresAt: new Date(at.getTime() + sessionMs),
    };
  };
  const checkPassword = (password, username) => {
    const problem = passwordProblem(password, username);
    if (problem) throw accountErrors.passwordRejected(problem);
  };
  const validId = (id) => typeof id === 'string' && uuidPattern.test(id);
  const resolveCompanyScope = (actor) => {
    if (typeof actor === 'string' && isCompanyId(actor)) return actor;
    const fromActor = actor?.account?.companyId ?? actor?.companyId;
    return fromActor || DEFAULT_COMPANY_ID;
  };
  async function employeeOrThrow(companyId, id) {
    if (!validId(id)) throw accountErrors.employeeNotFound();
    const row = await store.employee(companyId, id);
    if (!row) throw accountErrors.employeeNotFound();
    return row;
  }

  // The session for a cookie value, or null when it is malformed, unknown,
  // expired, or its account is disabled. Expired rows are removed. A lock
  // blocks new sign-ins only: existing sessions keep working, so wrong guesses
  // by someone else cannot sign the account holder out.
  async function session(token) {
    if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
    const hash = tokenHash(token);
    const row = await store.sessionAccount(hash);
    const at = now();
    if (!row) return null;
    if (new Date(row.session_expires_at) <= at) {
      await store.deleteSession(hash);
      return null;
    }
    if (row.status !== 'active') return null;
    if (row.role !== 'admin' && row.company_status !== 'active') return null;
    return { account: selfView(row, row.session_expires_at), tokenHash: hash };
  }

  // Always runs exactly one scrypt check, against a dummy hash when the ID is
  // unknown, so the response time does not reveal which IDs exist. Every
  // failure is the same 401 SIGN_IN_FAILED.
  async function signIn(body, previousToken) {
    const { username, password } = body || {};
    if (
      typeof username !== 'string' ||
      !username.trim() ||
      typeof password !== 'string' ||
      !password
    )
      throw accountErrors.signInInvalid();
    const name = username.trim();
    const row = usernamePattern.test(name) ? await store.findForSignIn(name) : null;
    const matches = await hashing.verify(password, row?.password_hash ?? (await hashing.dummy()));
    const at = now();
    const usable =
      row &&
      row.status === 'active' &&
      !lockedAt(row, at) &&
      (row.role === 'admin' || row.company_status === 'active');
    if (!usable || !matches) {
      // The same database work for every failure: the update matches no row
      // for an unknown ID or a disabled or locked account.
      const { locked } = await store.recordFailure(usable ? row.id : noAccount, at, {
        limit: maxFailures,
        lockedUntil: new Date(at.getTime() + lockMs),
      });
      if (locked) log('Account locked after repeated failed sign-ins.');
      throw accountErrors.signInFailed();
    }
    const fresh = newSession(at);
    const replaced =
      typeof previousToken === 'string' && tokenPattern.test(previousToken)
        ? tokenHash(previousToken)
        : null;
    if (!(await store.signIn(row.id, at, fresh, replaced))) throw accountErrors.signInFailed();
    return { token: fresh.token, account: selfView(row, fresh.expiresAt), sessionMs };
  }

  async function signOut(token) {
    if (typeof token === 'string' && tokenPattern.test(token))
      await store.deleteSession(tokenHash(token));
  }

  // The signed-in account changes its own password. A wrong current password
  // counts towards the lockout; reaching it keeps this session. While locked,
  // no password is checked here (that would allow unlimited guesses with a
  // session). On success every session of the account ends and a new one is
  // returned (rotation).
  async function changePassword(current, body) {
    const { currentPassword, newPassword } = body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword)
      throw accountErrors.passwordChangeInvalid();
    const row = await store.findById(current.account.id);
    if (!row || row.status !== 'active') throw accountErrors.sessionExpired();
    const at = now();
    if (lockedAt(row, at)) throw accountErrors.accountLocked();
    if (!(await hashing.verify(currentPassword, row.password_hash))) {
      await store.recordFailure(row.id, at, {
        limit: maxFailures,
        lockedUntil: new Date(at.getTime() + lockMs),
      });
      throw accountErrors.currentPasswordIncorrect();
    }
    checkPassword(newPassword, row.username);
    if (newPassword === currentPassword)
      throw accountErrors.passwordRejected('Choose a password different from your current one.');
    const fresh = newSession(at);
    const updated = await store.changePassword(row.id, await hashing.hash(newPassword), at, fresh);
    if (!updated) {
      // Disabled or locked since the check above.
      const latest = await store.findById(row.id);
      if (latest?.status === 'active' && lockedAt(latest, at)) throw accountErrors.accountLocked();
      throw accountErrors.sessionExpired();
    }
    return { token: fresh.token, account: selfView(updated, fresh.expiresAt), sessionMs };
  }

  async function myProfile(account) {
    return profiles.read(account.id);
  }

  // Each item: { account, profile (the list summary), track }. The track is
  // job.track, or employee when the profile has none.
  async function listEmployees(actor = null) {
    const companyId = resolveCompanyScope(actor);
    const rows = await store.listEmployees(companyId);
    const found = await profiles.readMany(rows.map((row) => row.id));
    const at = now();
    return rows.map((row) => ({
      account: accountView(row, at),
      profile: profileSummary(found.get(row.id)) || null,
      track: trackOf(found.get(row.id)),
    }));
  }

  async function getEmployee(actorOrId, maybeId) {
    const [actor, id] = maybeId !== undefined ? [actorOrId, maybeId] : [null, actorOrId];
    const companyId = actor ? resolveCompanyScope(actor) : null;
    const row = await employeeOrThrow(companyId, id);
    return { account: accountView(row, now()), profile: await profiles.read(row.id) };
  }

  // Departments (issue #36), kept in the departments table. exampleId only
  // shows the format; employees counts the profiles whose job.department
  // equals the name.
  const departmentView = (row, employees) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    archived: row.archived,
    exampleId: formatEmployeeId(row.prefix, 1),
    employees,
  });
  // The count after a change is a courtesy: a Firestore failure there must not
  // turn a change that already succeeded into an error.
  async function employeesIn(name, companyId) {
    try {
      return (await profiles.countByDepartment(companyId)).get(name) || 0;
    } catch {
      return 0;
    }
  }
  // The names of the active departments, the choices for a new hire and the
  // autofill's enum.
  async function activeDepartmentNames(actor = null) {
    const companyId = resolveCompanyScope(actor);
    return (await store.activeDepartments(companyId)).map((row) => row.name);
  }
  // Active departments first, then by name, with their employee counts.
  async function listDepartments(actor = null) {
    const companyId = resolveCompanyScope(actor);
    const rows = await store.listDepartments(companyId);
    const counts = await profiles.countByDepartment(companyId);
    return rows.map((row) => departmentView(row, counts.get(row.name) || 0));
  }
  function departmentFields(body, keys) {
    if (!isPlainObject(body)) throw departmentErrors.invalid([]);
    const problems = [],
      values = {};
    for (const key of keys) {
      if (key === 'archived') {
        if (typeof body.archived !== 'boolean')
          problems.push({ field: key, problem: 'invalid_format' });
        else values.archived = body.archived;
        continue;
      }
      const checked = checkDepartmentField(key, body[key]);
      if (checked.problem) problems.push({ field: key, problem: checked.problem });
      else values[key] = checked.value;
    }
    if (problems.length) throw departmentErrors.invalid(problems);
    return values;
  }
  // POST /api/hr/departments { name, prefix } -> { department }.
  async function createDepartment(actor, body) {
    if (!isPlainObject(body)) throw departmentErrors.invalid([]);
    const unknown = Object.keys(body).filter((key) => !['name', 'prefix'].includes(key));
    if (unknown.length) throw departmentErrors.invalid([]);
    const values = departmentFields(body, ['name', 'prefix']);
    const companyId = resolveCompanyScope(actor);
    const row = await store.createDepartment(actor.account.id, companyId, values, now());
    return { department: departmentView(row, await employeesIn(row.name, companyId)) };
  }
  // PATCH /api/hr/departments/:id { name?, prefix?, archived? } ->
  // { department, updatedProfiles }. A new name is also written to every
  // profile with the old one, before the change is committed: if Firestore
  // fails, the department keeps its name (503/504) and a retry works.
  async function updateDepartment(actor, id, body) {
    if (!isPlainObject(body)) throw departmentErrors.invalid([]);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !['name', 'prefix', 'archived'].includes(key)))
      throw departmentErrors.invalid([]);
    const changes = departmentFields(body, keys);
    if (!validId(id)) throw departmentErrors.notFound();
    const companyId = resolveCompanyScope(actor);
    let renamed = null;
    let result;
    try {
      result = await store.updateDepartment(
        actor.account.id,
        companyId,
        id,
        changes,
        now(),
        async (before, after) => {
          if (before.name !== after.name)
            renamed = await profiles.renameDepartment(before.name, after.name, companyId);
        },
      );
    } catch (error) {
      // The commit failed after the profiles were renamed: put them back.
      if (renamed) await renamed.undo().catch(() => {});
      throw error;
    }
    if (!result) throw departmentErrors.notFound();
    const employees = renamed ? renamed.updated : await employeesIn(result.after.name, companyId);
    return {
      department: departmentView(result.after, employees),
      updatedProfiles: renamed ? renamed.updated : 0,
    };
  }

  // The one way an employee account is created: HR's "Add employee account"
  // (POST /api/hr/employees) and the employee form import approval (#27).
  async function createEmployeeAccount({ profile: input, actorId, companyId = null } = {}) {
    if (!validId(actorId)) throw new TypeError('createEmployeeAccount needs the HR actorId.');
    const actorRow = await store.findById(actorId);
    const company = companyId ?? actorRow?.company_id ?? DEFAULT_COMPANY_ID;
    const active = await store.activeDepartments(company);
    const profile = validateProfile(input, { activeDepartments: active.map((row) => row.name) });
    const prefix = active.find((row) => row.name === profile.job.department).prefix;
    const temporaryPassword = generatePassword();
    const passwordHash = await hashing.hash(temporaryPassword);
    const at = now();
    for (let attempt = 1; ; attempt++) {
      let createdId = null,
        saved = null;
      try {
        const row = await store.createEmployee(
          {
            prefix,
            role: 'employee',
            action: 'employee_created',
            passwordHash,
            createdBy: actorId,
            at,
            companyId: company,
          },
          async (account) => {
            if (passwordProblem(temporaryPassword, account.username))
              throw new Error('The generated password does not meet the password rules.');
            createdId = account.id;
            saved = await profiles.write(account.id, profile, actorId, at, company);
          },
        );
        return { employee: { account: accountView(row, at), profile: saved }, temporaryPassword };
      } catch (error) {
        if (createdId) await profiles.remove(createdId).catch(() => {});
        if (error?.code !== 'USERNAME_TAKEN') throw error;
        if (attempt >= employeeIdAttempts) throw accountErrors.unavailable();
      }
    }
  }

  // POST /api/hr/employees: { profile } only. The Employee ID and the
  // temporary password are the server's, so any other key (username,
  // temporaryPassword) is 400 EMPLOYEE_INVALID.
  async function createEmployee(actor, body) {
    if (!isPlainObject(body) || Object.keys(body).some((key) => key !== 'profile'))
      throw accountErrors.employeeInvalid();
    return createEmployeeAccount({
      profile: body.profile,
      actorId: actor.account.id,
      companyId: resolveCompanyScope(actor),
    });
  }

  // A department that is not active is accepted only when it is the one already
  // stored (archived since, or saved before the list existed), so it stays
  // editable.
  async function replaceProfile(actor, id, body) {
    if (!validId(id)) throw accountErrors.employeeNotFound();
    const companyId = resolveCompanyScope(actor);
    const job = isPlainObject(body?.profile) ? body.profile.job : undefined;
    const requested =
      isPlainObject(job) && typeof job.department === 'string' ? job.department.trim() : '';
    const activeDepartments = await activeDepartmentNames(companyId);
    const keepDepartment = activeDepartments.includes(requested)
      ? undefined
      : ((await profiles.read(id))?.job.department ?? '');
    const profile = validateProfile(body?.profile, { keepDepartment, activeDepartments });
    const at = now();
    let saved = null;
    const row = await store.employeeChange(
      actor.account.id,
      companyId,
      id,
      'profile_updated',
      at,
      async () => {
        saved = await profiles.write(id, profile, actor.account.id, at, companyId);
      },
    );
    if (!row) throw accountErrors.employeeNotFound();
    return { account: accountView(row, at), profile: saved };
  }

  async function resetPassword(actor, id, body) {
    const companyId = resolveCompanyScope(actor);
    const row = await employeeOrThrow(companyId, id);
    checkPassword(body?.temporaryPassword, row.username);
    const updated = await store.resetPassword(
      actor.account.id,
      companyId,
      id,
      await hashing.hash(body.temporaryPassword),
      now(),
    );
    if (!updated) throw accountErrors.employeeNotFound();
    return { account: accountView(updated, now()) };
  }

  async function setStatus(actor, id, body) {
    if (!['active', 'disabled'].includes(body?.status)) throw accountErrors.statusInvalid();
    if (!validId(id)) throw accountErrors.employeeNotFound();
    const companyId = resolveCompanyScope(actor);
    const updated = await store.setStatus(actor.account.id, companyId, id, body.status, now());
    if (!updated) throw accountErrors.employeeNotFound();
    return { account: accountView(updated, now()) };
  }

  // Deletes an employee's personal data, then the account.
  async function deleteEmployee(actor, id, { eraseChats, eraseAgentSessions = null }) {
    const companyId = resolveCompanyScope(actor);
    const row = await employeeOrThrow(companyId, id);
    await store.endEmployeeSessions(companyId, row.id);
    try {
      await eraseChats(`account:${row.id}`);
    } catch (error) {
      throw asProfileStorageError(error);
    }
    // The checklist agent's sessions (#51); never fails the deletion.
    if (eraseAgentSessions) await eraseAgentSessions(row.id);
    await profiles.removeAccountData(row.id);
    const deleted = await store.deleteEmployee(actor.account.id, companyId, row.id, now());
    if (!deleted) throw accountErrors.employeeNotFound();
  }

  // An HR change to an employee's Firestore data with its audit row: the
  // account_events row is inserted, then during(account) runs (the Firestore
  // write), then the commit. A failure in during() rolls the row back. Resolves
  // to what during() returned; 404 EMPLOYEE_NOT_FOUND for an unknown or HR id.
  async function recordEmployeeChange(actor, id, action, during, detail = null) {
    if (!validId(id)) throw accountErrors.employeeNotFound();
    const companyId = resolveCompanyScope(actor);
    let result;
    const row = await store.employeeChange(
      actor.account.id,
      companyId,
      id,
      action,
      now(),
      async (account) => {
        result = await during(account);
      },
      detail,
    );
    if (!row) throw accountErrors.employeeNotFound();
    return result;
  }

  // An HR change that is not about one employee (the company library), with
  // its audit row; see store.recordEvent. Resolves to what during() returned.
  const recordEvent = (actor, action, detail, during) =>
    store.recordEvent(actor.account.id, resolveCompanyScope(actor), action, now(), detail, during);

  function checkCompanyName(raw) {
    if (raw === undefined || raw === null) return { problem: 'required' };
    if (typeof raw !== 'string') return { problem: 'invalid_format' };
    const value = raw.trim();
    if (!value) return { problem: 'required' };
    if ([...value].length > companyNameMax) return { problem: 'too_long' };
    if (controlCharacters.test(value)) return { problem: 'invalid_format' };
    return { value };
  }

  function checkCompanyId(raw) {
    if (raw === undefined || raw === null) return { problem: 'required' };
    if (typeof raw !== 'string') return { problem: 'invalid_format' };
    const value = raw.trim();
    if (!value) return { problem: 'required' };
    if (value.length > 32) return { problem: 'too_long' };
    if (!companyIdPattern.test(value)) return { problem: 'invalid_format' };
    return { value };
  }

  async function listCompanies() {
    const rows = await store.listCompanies();
    return { companies: rows.map(companySummaryView) };
  }

  async function getCompany(companyId) {
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    const row = await store.company(companyId);
    if (!row) throw companyErrors.notFound();
    return { company: companySummaryView(row) };
  }

  async function createCompany(actor, body) {
    if (!isPlainObject(body)) throw companyErrors.invalid([]);
    const unknown = Object.keys(body).filter((key) => !['name', 'id'].includes(key));
    if (unknown.length) throw companyErrors.invalid([]);
    const problems = [];
    const checkedName = checkCompanyName(body.name);
    if (checkedName.problem) problems.push({ field: 'name', problem: checkedName.problem });
    let ids = null;
    if (body.id !== undefined) {
      const checkedId = checkCompanyId(body.id);
      if (checkedId.problem) problems.push({ field: 'id', problem: checkedId.problem });
      else ids = [checkedId.value];
    }
    if (problems.length) throw companyErrors.invalid(problems);
    const name = checkedName.value;
    if (!ids) {
      const base = companyIdFromName(name);
      ids = [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
    }
    const at = now();
    const createdId = await store.createCompany(
      actor.account.id,
      { ids, name },
      at,
      defaultDepartments,
    );
    return getCompany(createdId);
  }

  async function renameCompany(actor, companyId, body) {
    if (!isPlainObject(body)) throw companyErrors.invalid([]);
    const unknown = Object.keys(body).filter((key) => key !== 'name');
    if (unknown.length) throw companyErrors.invalid([]);
    const checkedName = checkCompanyName(body.name);
    if (checkedName.problem)
      throw companyErrors.invalid([{ field: 'name', problem: checkedName.problem }]);
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    const renamed = await store.renameCompany(
      actor.account.id,
      companyId,
      checkedName.value,
      now(),
    );
    if (!renamed) throw companyErrors.notFound();
    return getCompany(companyId);
  }

  async function setCompanyStatus(actor, companyId, body) {
    if (!isPlainObject(body) || !['active', 'disabled'].includes(body.status))
      throw companyErrors.statusInvalid();
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    const updated = await store.setCompanyStatus(actor.account.id, companyId, body.status, now());
    if (!updated) throw companyErrors.notFound();
    return getCompany(companyId);
  }

  async function companyProfile(companyId) {
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    const row = await store.companyProfile(companyId);
    if (!row) throw companyErrors.notFound();
    return {
      profile: presentCompanyProfile(row.profile),
      version: row.version,
      updatedAt: iso(row.updatedAt),
      updatedBy: row.updatedBy,
    };
  }

  async function saveCompanyProfile(actor, companyId, body) {
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    if (!isPlainObject(body))
      throw companyProfileErrors.invalid([{ field: 'profile', problem: 'not_object' }]);
    if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 0)
      throw companyProfileErrors.conflict();
    const profile = validateCompanyProfile(body.profile);
    const same = (stored) =>
      JSON.stringify(presentCompanyProfile(stored)) === JSON.stringify(profile);
    const at = now();
    const saved = await store.saveCompanyProfile(
      actor.account.id,
      companyId,
      profile,
      body.version,
      at,
      same,
    );
    if (!saved) throw companyErrors.notFound();
    return companyProfile(companyId);
  }

  async function listCompanyHr(companyId) {
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    const comp = await store.company(companyId);
    if (!comp) throw companyErrors.notFound();
    const rows = await store.listCompanyHr(companyId);
    const at = now();
    return {
      hrAccounts: rows.map((row) => hrAccountView(row, at, comp.default_hr_account_id)),
    };
  }

  async function createCompanyHr(actor, companyId, body) {
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    const comp = await store.company(companyId);
    if (!comp) throw companyErrors.notFound();
    if (body !== undefined && body !== null) {
      if (!isPlainObject(body)) throw companyErrors.hrAccountInvalid();
      const unknown = Object.keys(body).filter((key) => key !== 'makeDefault');
      if (unknown.length) throw companyErrors.hrAccountInvalid();
      if (body.makeDefault !== undefined && typeof body.makeDefault !== 'boolean')
        throw companyErrors.hrAccountInvalid();
    }
    const makeDefault =
      body?.makeDefault !== undefined ? body.makeDefault : !Boolean(comp.default_hr_account_id);
    const temporaryPassword = generatePassword();
    const passwordHash = await hashing.hash(temporaryPassword);
    const at = now();
    for (let attempt = 1; ; attempt++) {
      try {
        const row = await store.createNumbered(
          {
            prefix: 'HR',
            role: 'hr',
            action: 'hr_account_created',
            passwordHash,
            createdBy: actor.account.id,
            at,
            companyId,
          },
          async (account, query) => {
            if (passwordProblem(temporaryPassword, account.username))
              throw new Error('The generated password does not meet the password rules.');
            if (makeDefault) {
              await store.setDefaultHr(actor.account.id, companyId, account.id, at, query);
            }
          },
        );
        const latestCompany = await getCompany(companyId);
        return {
          hrAccount: hrAccountView(row, at, latestCompany.company.defaultHr?.id),
          temporaryPassword,
          company: latestCompany.company,
        };
      } catch (error) {
        if (error?.code === 'USERNAME_TAKEN') {
          if (attempt >= employeeIdAttempts) throw accountErrors.unavailable();
          continue;
        }
        throw error;
      }
    }
  }

  async function setDefaultHr(actor, companyId, body) {
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    if (!isPlainObject(body) || !validId(body.accountId)) throw companyErrors.hrAccountNotFound();
    const result = await store.setDefaultHr(actor.account.id, companyId, body.accountId, now());
    if (result === 'company') throw companyErrors.notFound();
    if (result === 'account') throw companyErrors.hrAccountNotFound();
    return getCompany(companyId);
  }

  async function resetHrPasswordByAdmin(actor, companyId, accountId) {
    if (!isCompanyId(companyId)) throw companyErrors.notFound();
    if (!validId(accountId)) throw companyErrors.hrAccountNotFound();
    const temporaryPassword = generatePassword();
    const passwordHash = await hashing.hash(temporaryPassword);
    const at = now();
    const result = await store.resetHrPasswordByAdmin(
      actor.account.id,
      companyId,
      accountId,
      passwordHash,
      at,
    );
    if (result === 'company') throw companyErrors.notFound();
    if (result === 'account') throw companyErrors.hrAccountNotFound();
    return {
      hrAccount: hrAccountView(result.account, at, result.isDefault ? result.account.id : null),
      temporaryPassword,
    };
  }

  async function listAdminEvents(query = {}) {
    if (!isPlainObject(query)) throw companyErrors.eventsQueryInvalid();
    const keys = Object.keys(query);
    if (keys.some((k) => !['companyId', 'before', 'limit'].includes(k)))
      throw companyErrors.eventsQueryInvalid();
    let companyId = null;
    if (query.companyId !== undefined && query.companyId !== '') {
      if (!isCompanyId(query.companyId)) throw companyErrors.eventsQueryInvalid();
      companyId = query.companyId;
    }
    let before = null;
    if (query.before !== undefined && query.before !== '') {
      if (!/^\d+$/.test(String(query.before))) throw companyErrors.eventsQueryInvalid();
      before = String(query.before);
    }
    let limit = 50;
    if (query.limit !== undefined && query.limit !== '') {
      if (!/^\d+$/.test(String(query.limit))) throw companyErrors.eventsQueryInvalid();
      limit = Number(query.limit);
      if (limit < 1 || limit > 100) throw companyErrors.eventsQueryInvalid();
    }
    const rows = await store.listAdminEvents({ companyId, before, limit });
    const events = rows.map((row) => ({
      id: String(row.id),
      action: row.action,
      createdAt: iso(row.created_at),
      companyId: row.company_id ?? null,
      actor: row.actor_id ? { id: row.actor_id, username: row.actor_username || null } : null,
      target: row.target_id ? { id: row.target_id, username: row.target_username || null } : null,
      targetLabel: row.target_label || null,
      detail: row.detail || null,
    }));
    return {
      events,
      nextBefore: events.length === limit ? events[events.length - 1].id : null,
    };
  }

  return {
    sessionMs,
    session,
    signIn,
    signOut,
    changePassword,
    myProfile,
    listEmployees,
    getEmployee,
    listDepartments,
    activeDepartmentNames,
    createDepartment,
    updateDepartment,
    createEmployeeAccount,
    createEmployee,
    replaceProfile,
    resetPassword,
    setStatus,
    deleteEmployee,
    recordEmployeeChange,
    recordEvent,
    listCompanies,
    getCompany,
    createCompany,
    renameCompany,
    setCompanyStatus,
    companyProfile,
    saveCompanyProfile,
    listCompanyHr,
    createCompanyHr,
    setDefaultHr,
    resetHrPasswordByAdmin,
    listAdminEvents,
    store,
    profiles,
    close: async () => {
      await Promise.allSettled([store.close?.(), profiles.close?.()]);
    },
  };
}
