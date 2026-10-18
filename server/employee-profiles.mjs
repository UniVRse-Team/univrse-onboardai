import { AccountError } from './account-errors.mjs';
import { commitInBatches, deleteOperation } from './firestore-checkpointer.mjs';
import { createStorageCall } from './firestore-client.mjs';
import { departments as seedDepartments } from './departments.mjs';
import { journeyCollections } from './onboarding-collections.mjs';
import { tracks } from './onboarding-content.mjs';
import { DEFAULT_COMPANY_ID } from './companies.mjs';

// Each employee's personal profile is one Firestore document,
// employeeProfiles/{accountId}. Only HR writes it; an employee reads their own.
// Every call is bounded by the storage deadline in firestore-client.mjs, and its
// log line names the operation and Firestore status only, never profile values.
export const profileCollection = 'employeeProfiles';
// Draft employee imports (issue #27), employeeImports/{importId}. A draft names
// an account as its target, as a possible duplicate or as its creator.
export const importCollection = 'employeeImports';
export const importMentions = (data, accountId) =>
  data?.targetEmployee?.accountId === accountId ||
  data?.createdBy?.accountId === accountId ||
  (Array.isArray(data?.possibleDuplicates) &&
    data.possibleDuplicates.some((match) => match?.accountId === accountId));

// group -> field -> rule. Every field is optional text except job.fullName and
// job.department, which validateProfile requires to be one of the
// active departments (departmentProblem below; `max` still bounds stored values).
// job.track (issue #47) is employee, intern or contractor, stored in lower
// case; '' (missing) means employee.
export const profileSchema = Object.freeze({
  job: {
    fullName: { max: 120, required: true },
    preferredName: { max: 80 },
    jobTitle: { max: 120 },
    department: { max: 120 },
    startDate: { max: 10, kind: 'date' },
    manager: { max: 120 },
    track: { max: 20, kind: 'track' },
  },
  contact: {
    workEmail: { max: 254, kind: 'email' },
    personalEmail: { max: 254, kind: 'email' },
    mobileNumber: { max: 32, kind: 'phone' },
  },
  emergencyContact: {
    name: { max: 120 },
    relationship: { max: 60 },
    phoneNumber: { max: 32, kind: 'phone' },
  },
  homeAddress: {
    line1: { max: 200 },
    line2: { max: 200 },
    city: { max: 100 },
    state: { max: 100 },
    postcode: { max: 20 },
    country: { max: 100 },
  },
});
// Set by the server; accepted in a request body and ignored, so a profile read
// from the API can be sent back unchanged.
const serverFields = new Set(['updatedAt', 'updatedBy']);

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9 ().-]*[0-9][0-9 ().-]*$/;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const isObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const problemText = {
  required: 'is required',
  unknown: 'is not a profile field',
  not_object: 'must be a group of fields',
  not_text: 'must be text',
  too_long: 'is too long',
  invalid_characters: 'contains line breaks or control characters',
  invalid_email: 'is not a valid email address',
  invalid_date: 'must be a date in YYYY-MM-DD form',
  invalid_phone: 'must be a phone number using digits, spaces, +, -, ( ) or .',
  invalid_department: 'must be one of the departments in the list',
  invalid_track: 'must be employee, intern or contractor',
};

function fieldProblem(value, rule) {
  if (value === undefined || value === null) return rule.required ? ['required', ''] : [null, ''];
  if (typeof value !== 'string') return ['not_text'];
  const text = value.trim();
  if (!text) return rule.required ? ['required', ''] : [null, ''];
  if (controlCharacters.test(text)) return ['invalid_characters'];
  if ([...text].length > rule.max) return ['too_long'];
  if (rule.kind === 'email' && !emailPattern.test(text)) return ['invalid_email'];
  if (rule.kind === 'date' && !validDate(text)) return ['invalid_date'];
  if (rule.kind === 'phone' && !phonePattern.test(text)) return ['invalid_phone'];
  if (rule.kind === 'track') {
    const track = text.toLowerCase();
    return tracks.includes(track) ? [null, track] : ['invalid_track'];
  }
  return [null, text];
}

// One optional value checked against its field's rule, for callers that take
// fields one at a time (profile autofill): { value } with the trimmed text, ''
// when empty, or { problem } with one of the PROFILE_INVALID problem codes.
export function checkProfileValue(group, name, value) {
  const fields = Object.hasOwn(profileSchema, group) ? profileSchema[group] : {};
  if (!Object.hasOwn(fields, name)) return { problem: 'unknown' };
  const rule = fields[name];
  const [problem, text] = fieldProblem(value, { ...rule, required: false });
  return problem ? { problem } : { value: text };
}

// The department names a profile may be saved with when the caller does not
// pass the active ones from the database: the seed list. Tests only; the
// account service always passes the departments table's active names.
const seedDepartmentNames = Object.freeze(seedDepartments.map((department) => department.name));

// job.department is the name of an active department (the departments table),
// which also decides the Employee ID prefix. `keep`, when given, is the value
// already stored for the employee: it is accepted unchanged, so a profile saved
// before the list existed, or with a department since archived or renamed,
// stays editable without a new choice.
function departmentProblem(value, keep, names) {
  if (value !== undefined && value !== null && typeof value !== 'string') return ['not_text'];
  const text = typeof value === 'string' ? value.trim() : '';
  if (names.includes(text) || (typeof keep === 'string' && text === keep)) return [null, text];
  return [text ? 'invalid_department' : 'required'];
}

// Returns the stored form (every field present, trimmed, '' when empty), or
// throws 400 PROFILE_INVALID with details.fields = [{ field, problem }].
// job.department must be one of activeDepartments (names; the seed list when
// omitted); keepDepartment (an update) also allows exactly the employee's
// stored department.
export function validateProfile(
  input,
  { keepDepartment, activeDepartments = seedDepartmentNames } = {},
) {
  const problems = [];
  const profile = {};
  if (!isObject(input)) problems.push({ field: 'profile', problem: 'not_object' });
  else {
    for (const key of Object.keys(input))
      if (!(key in profileSchema) && !serverFields.has(key))
        problems.push({ field: key, problem: 'unknown' });
    for (const [group, fields] of Object.entries(profileSchema)) {
      const given = input[group] ?? {};
      profile[group] = {};
      if (!isObject(given)) {
        problems.push({ field: group, problem: 'not_object' });
        continue;
      }
      for (const key of Object.keys(given))
        if (!(key in fields)) problems.push({ field: `${group}.${key}`, problem: 'unknown' });
      for (const [name, rule] of Object.entries(fields)) {
        const [problem, value] =
          group === 'job' && name === 'department'
            ? departmentProblem(given[name], keepDepartment, activeDepartments)
            : fieldProblem(given[name], rule);
        if (problem) problems.push({ field: `${group}.${name}`, problem });
        else profile[group][name] = value;
      }
    }
  }
  if (problems.length) {
    const listed = problems
      .slice(0, 5)
      .map(({ field, problem }) => `${field} ${problemText[problem]}`)
      .join('; ');
    throw new AccountError(
      400,
      'PROFILE_INVALID',
      `Check the profile: ${listed}${problems.length > 5 ? '; and more' : ''}.`,
      { fields: problems },
    );
  }
  return profile;
}

// A stored document as the API returns it: every schema field, then the
// server-set updatedAt (ISO 8601) and updatedBy (the HR account ID).
export function presentProfile(data) {
  const profile = {};
  for (const [group, fields] of Object.entries(profileSchema)) {
    profile[group] = {};
    for (const name of Object.keys(fields)) {
      const value = data?.[group]?.[name];
      profile[group][name] = typeof value === 'string' ? value : '';
    }
  }
  profile.updatedAt = typeof data?.updatedAt === 'string' ? data.updatedAt : null;
  profile.updatedBy = typeof data?.updatedBy === 'string' ? data.updatedBy : null;
  return profile;
}

// The part of a profile shown in HR's employee list.
export const profileSummary = (profile) =>
  profile && {
    fullName: profile.job.fullName,
    preferredName: profile.job.preferredName,
    jobTitle: profile.job.jobTitle,
    department: profile.job.department,
    startDate: profile.job.startDate,
  };

export const profileStorageErrors = {
  timeout: () =>
    new AccountError(
      504,
      'PROFILE_STORAGE_TIMEOUT',
      'Employee profiles took too long to respond. Please try again.',
    ),
  unavailable: () =>
    new AccountError(
      503,
      'PROFILE_STORAGE_UNAVAILABLE',
      'Employee profiles are temporarily unavailable. Please try again shortly.',
    ),
};
// Chat-store and other Firestore failures (ChatError STORAGE_*) on account
// routes answer like the profile failures there; anything else (CHAT_BUSY,
// a rule error) passes through.
export const asProfileStorageError = (error) =>
  error?.code === 'STORAGE_TIMEOUT'
    ? profileStorageErrors.timeout()
    : typeof error?.code === 'string' && error.code.startsWith('STORAGE_')
      ? profileStorageErrors.unavailable()
      : error;
const profileStorageError = (error) =>
  error?.code === 'STORAGE_TIMEOUT'
    ? profileStorageErrors.timeout()
    : profileStorageErrors.unavailable();

export function createProfileStore({
  // A Firestore instance, or an async function returning one.
  firestore,
  timeoutMs,
  log,
}) {
  let client = null;
  const database = async () =>
    (client ??= await (typeof firestore === 'function' ? firestore() : firestore));
  const call = createStorageCall({ timeoutMs, log });
  const guarded = async (operation, fn) => {
    try {
      return await call(operation, fn);
    } catch (error) {
      throw profileStorageError(error);
    }
  };
  const ref = (db, accountId) => db.collection(profileCollection).doc(accountId);

  return {
    read: (accountId) =>
      guarded('read employee profile', async () => {
        const snapshot = await ref(await database(), accountId).get();
        return snapshot.exists ? presentProfile(snapshot.data()) : null;
      }),
    // Map of accountId -> profile for the IDs that have one.
    readMany: async (accountIds) => {
      const found = new Map();
      for (let i = 0; i < accountIds.length; i += 100) {
        const ids = accountIds.slice(i, i + 100);
        const snapshots = await guarded('read employee profiles', async () => {
          const db = await database();
          return db.getAll(...ids.map((id) => ref(db, id)));
        });
        for (const snapshot of snapshots)
          if (snapshot.exists) found.set(snapshot.id, presentProfile(snapshot.data()));
      }
      return found;
    },
    write: (accountId, profile, updatedBy, at, companyId = DEFAULT_COMPANY_ID) =>
      guarded('save employee profile', async () => {
        const stored = { ...profile, updatedAt: at.toISOString(), updatedBy, companyId };
        await ref(await database(), accountId).set(stored);
        return presentProfile(stored);
      }),
    // Department -> number of profiles, for HR's department list. The profile
    // collection is small, so this reads each profile's job group.
    countByDepartment: (companyId = null) =>
      guarded('count employee departments', async () => {
        const db = await database();
        let query = db.collection(profileCollection);
        if (companyId) query = query.where('companyId', '==', companyId);
        const snapshot = await query.select('job').get();
        const counts = new Map();
        for (const doc of snapshot.docs) {
          const name = doc.data()?.job?.department;
          if (typeof name === 'string') counts.set(name, (counts.get(name) || 0) + 1);
        }
        return counts;
      }),
    // Sets job.department to `to` on every profile whose value is exactly
    // `from`, in batches. Resolves to { updated, undo }: the count, and a
    // function putting `from` back on those profiles (best effort, for when a
    // later step fails). If a batch fails, the batches before it are put back
    // here and the error is thrown, so the rename is all or (as far as
    // Firestore allows) nothing; repeating it is safe.
    renameDepartment: (from, to, companyId = null) =>
      guarded('rename profile department', async () => {
        const db = await database();
        let query = db.collection(profileCollection);
        if (companyId) query = query.where('companyId', '==', companyId);
        const snapshot = await query.select('job').get();
        const matching = snapshot.docs
          .map((doc) => ({ ref: doc.ref, job: doc.data()?.job }))
          .filter(({ job }) => job?.department === from);
        const changeAll = async (list, department) => {
          for (let i = 0; i < list.length; i += 400) {
            const batch = db.batch();
            for (const { ref, job } of list.slice(i, i + 400))
              batch.update(ref, { job: { ...job, department } });
            await batch.commit();
          }
        };
        const done = [];
        try {
          for (let i = 0; i < matching.length; i += 400) {
            const slice = matching.slice(i, i + 400);
            await changeAll(slice, to);
            done.push(...slice);
          }
        } catch (error) {
          await changeAll(done, from).catch(() => {});
          throw error;
        }
        return {
          updated: matching.length,
          undo: () => guarded('undo profile department rename', () => changeAll(done, from)),
        };
      }),
    remove: (accountId) =>
      guarded('delete employee profile', async () => {
        await ref(await database(), accountId).delete();
      }),
    // Deletes the profile, every import draft that mentions the account (a
    // full scan of the small employeeImports collection; nothing when it does
    // not exist) and the onboarding journey data (issues #47-#51): progress,
    // first-day details, support requests and proposed checklist changes
    // (agentActions). Anonymous knowledgeGaps stay.
    // The profile goes last, so an interrupted run is found again. Safe to repeat.
    removeAccountData: (accountId) =>
      guarded('delete employee data', async () => {
        const db = await database();
        const owned = (name) =>
          db.collection(name).where('accountId', '==', accountId).select().get();
        const [drafts, requests, actions] = await Promise.all([
          db
            .collection(importCollection)
            .select('targetEmployee', 'createdBy', 'possibleDuplicates')
            .get(),
          owned(journeyCollections.supportRequests),
          owned(journeyCollections.agentActions),
        ]);
        await commitInBatches(db, [
          ...drafts.docs
            .filter((doc) => importMentions(doc.data(), accountId))
            .map((doc) => deleteOperation(doc.ref)),
          ...requests.docs.map((doc) => deleteOperation(doc.ref)),
          ...actions.docs.map((doc) => deleteOperation(doc.ref)),
          deleteOperation(db.collection(journeyCollections.progress).doc(accountId)),
          deleteOperation(db.collection(journeyCollections.taskVerifications).doc(accountId)),
          deleteOperation(db.collection(journeyCollections.firstDay).doc(accountId)),
          deleteOperation(ref(db, accountId)),
        ]);
      }),
    close: async () => {
      const open = client;
      client = null;
      await open?.terminate?.();
    },
  };
}
