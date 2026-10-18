import { createHash } from 'node:crypto';
import { DEFAULT_COMPANY_ID } from './companies.mjs';
import { journeyErrors } from './account-errors.mjs';
import { answerNotFound } from './chat-errors.mjs';
import { createStorageCall } from './firestore-client.mjs';
import { asProfileStorageError } from './employee-profiles.mjs';
import { journeyCollections } from './onboarding-collections.mjs';
import { teamInsights } from './team-insights.mjs';

// Consented support requests (issue #48, D1 Option A). An employee who is
// still unclear after Alya's answer previews exactly what HR will see (the
// question, Alya's answer and its sources, never the rest of the chat),
// optionally adds a note and confirms. Only then is supportRequests/{id}
// written; HR works it through open -> briefing_scheduled -> resolved.
// Creating a request also records the chat's existing human-help observation,
// so the team-level aggregates (GET /api/hr/team-insights) stay meaningful.
export const requestStatuses = Object.freeze(['open', 'briefing_scheduled', 'resolved']);
export const supportLimits = Object.freeze({ note: 500, hrNote: 1000, answer: 4000 });
const requestIdPattern = /^[0-9a-f]{32}$/;
const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const controlExceptNewline = /[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029]/;
const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// One request per employee and answer: the same answer again finds it.
export const supportRequestId = (accountId, conversationId, messageId) =>
  createHash('sha256')
    .update(`${accountId}\n${conversationId}\n${messageId}`)
    .digest('hex')
    .slice(0, 32);

// Free text: trimmed, newlines kept, no other control characters.
function noteProblem(value, max) {
  if (typeof value !== 'string') return 'not_text';
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (controlExceptNewline.test(text)) return 'invalid_characters';
  if ([...text].length > max) return 'too_long';
  return null;
}
const cleanNote = (value) => value.replace(/\r\n?/g, '\n').trim() || null;

// The answer a re-explanation chain started from: an answer saved with
// reexplainOf (the "Need another explanation?" follow-up) points at the answer
// it re-explains; the chain ends at the first answer without one.
function chainStart(conversation, answer) {
  let current = answer;
  const seen = new Set([answer.id]);
  for (;;) {
    const previous = current.reexplainOf ?? current.result?.reexplainOf;
    if (typeof previous !== 'string' || seen.has(previous)) return current;
    const found = conversation.messages.find((m) => m.id === previous && m.role === 'assistant');
    if (!found) return current;
    seen.add(previous);
    current = found;
  }
}

// What the employee confirms and HR sees, from one saved assistant message:
// the employee's original question (for a re-explained answer, the question
// of the answer the chain started from, never the app's re-explain prompt),
// and the answer and sources of the message the employee chose.
export function requestContent(conversation, messageId) {
  if (typeof messageId !== 'string') throw answerNotFound();
  const answer = conversation.messages.find((m) => m.id === messageId && m.role === 'assistant');
  if (!answer) throw answerNotFound();
  const origin = chainStart(conversation, answer);
  const question = conversation.messages.find(
    (m) => m.role === 'user' && m.requestId === origin.requestId,
  );
  const sources = [];
  for (const passage of Array.isArray(answer.result?.passages) ? answer.result.passages : []) {
    if (typeof passage?.title !== 'string' || !passage.title) continue;
    const heading = typeof passage.heading === 'string' ? passage.heading : '';
    if (!sources.some((s) => s.title === passage.title && s.heading === heading))
      sources.push({ title: passage.title, heading });
  }
  return {
    question: typeof question?.text === 'string' ? question.text : '',
    alyaAnswer: String(answer.text || '').slice(0, supportLimits.answer),
    sources,
  };
}

// The employee's view: status and briefing time, never HR's note.
export const myRequestView = (doc) => ({
  id: doc.id,
  messageId: doc.messageId,
  question: doc.question,
  status: doc.status,
  briefingAt: doc.briefingAt ?? null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});
// HR's view: the document without accountId and conversationId, plus the
// employee's ID and display name, and assignedHr.
export function hrRequestView(doc, employee, assignedHr = null) {
  const { accountId, conversationId, ...rest } = doc;
  return {
    ...rest,
    employeeNote: rest.employeeNote ?? null,
    hrNote: rest.hrNote ?? null,
    briefingAt: rest.briefingAt ?? null,
    docNeedsUpdate: Boolean(rest.docNeedsUpdate),
    docToUpdate: rest.docToUpdate ?? null,
    updatedBy: rest.updatedBy ?? null,
    employee,
    assignedHr,
  };
}
const displayName = ({ account, profile }) =>
  profile?.preferredName || profile?.fullName || account.username;

// PATCH body -> the changed fields, or 400 SUPPORT_REQUEST_INVALID.
export function validateRequestPatch(body) {
  if (!isPlainObject(body)) throw journeyErrors.supportRequestInvalid([]);
  const allowed = ['status', 'hrNote', 'briefingAt', 'docNeedsUpdate', 'docToUpdate'];
  const problems = [];
  const changes = {};
  const keys = Object.keys(body);
  if (!keys.length) throw journeyErrors.supportRequestInvalid([]);
  for (const key of keys) {
    const value = body[key];
    if (!allowed.includes(key)) problems.push({ field: key, problem: 'unknown' });
    else if (key === 'status') {
      if (!requestStatuses.includes(value))
        problems.push({ field: key, problem: 'invalid_choice' });
      else changes.status = value;
    } else if (key === 'hrNote') {
      if (value === null) changes.hrNote = null;
      else {
        const problem = noteProblem(value, supportLimits.hrNote);
        if (problem) problems.push({ field: key, problem });
        else changes.hrNote = cleanNote(value);
      }
    } else if (key === 'briefingAt') {
      if (value === null) changes.briefingAt = null;
      else if (
        typeof value !== 'string' ||
        !isoDateTime.test(value) ||
        Number.isNaN(Date.parse(value))
      )
        problems.push({ field: key, problem: 'invalid_date' });
      else changes.briefingAt = new Date(value).toISOString();
    } else if (key === 'docNeedsUpdate') {
      if (typeof value !== 'boolean') problems.push({ field: key, problem: 'not_boolean' });
      else changes.docNeedsUpdate = value;
    } else if (key === 'docToUpdate') {
      if (value === null) changes.docToUpdate = null;
      else if (typeof value !== 'string' || !value.trim())
        problems.push({ field: key, problem: 'not_text' });
      else changes.docToUpdate = value;
    }
  }
  if (problems.length) throw journeyErrors.supportRequestInvalid(problems);
  return changes;
}

// The stored request after a PATCH. briefing_scheduled needs a briefing time
// (given now or already stored); docToUpdate must be one of the request's
// source titles, and is cleared when docNeedsUpdate is false.
export function applyRequestPatch(doc, changes) {
  const next = { ...doc, ...changes };
  if (next.status === 'briefing_scheduled' && !next.briefingAt)
    throw journeyErrors.briefingTimeRequired();
  if (
    changes.docToUpdate != null &&
    !(doc.sources || []).some((source) => source.title === changes.docToUpdate)
  )
    throw journeyErrors.supportRequestInvalid([
      { field: 'docToUpdate', problem: 'invalid_choice' },
    ]);
  if (changes.docToUpdate != null && changes.docNeedsUpdate === undefined)
    next.docNeedsUpdate = true;
  if (!next.docNeedsUpdate) next.docToUpdate = null;
  return next;
}

export function createSupportRequests({
  // A Firestore instance, or an async function returning one.
  firestore,
  accounts,
  // () => the saved-chat store (chat-store.mjs) holding account chats.
  chatMemory,
  now = () => new Date(),
  timeoutMs,
  log = (line) => console.warn(line),
}) {
  let client = null;
  const database = async () =>
    (client ??= await (typeof firestore === 'function' ? firestore() : firestore));
  const call = createStorageCall({ timeoutMs, log });
  const guarded = async (operation, fn) => {
    try {
      return await call(operation, fn);
    } catch (error) {
      throw asProfileStorageError(error);
    }
  };
  const collection = async () => (await database()).collection(journeyCollections.supportRequests);
  const owner = (account) => `account:${account.id}`;
  async function readChat(account, conversationId) {
    try {
      return await chatMemory().read(owner(account), conversationId);
    } catch (error) {
      throw asProfileStorageError(error);
    }
  }

  async function preview(account, body) {
    const { conversationId, messageId } = isPlainObject(body) ? body : {};
    if (typeof conversationId !== 'string') throw answerNotFound();
    return requestContent(await readChat(account, conversationId), messageId);
  }

  // POST /api/me/support-requests -> { created, request }.
  async function create(account, body) {
    if (!isPlainObject(body)) throw journeyErrors.supportRequestInvalid([]);
    const problems = [];
    for (const key of Object.keys(body))
      if (!['conversationId', 'messageId', 'note'].includes(key))
        problems.push({ field: key, problem: 'unknown' });
    for (const key of ['conversationId', 'messageId'])
      if (typeof body[key] !== 'string' || !body[key])
        problems.push({ field: key, problem: 'required' });
    if (body.note !== undefined && body.note !== null) {
      const problem = noteProblem(body.note, supportLimits.note);
      if (problem) problems.push({ field: 'note', problem });
    }
    if (problems.length) throw journeyErrors.supportRequestInvalid(problems);
    const { conversationId, messageId } = body;
    const content = requestContent(await readChat(account, conversationId), messageId);
    const id = supportRequestId(account.id, conversationId, messageId);
    const at = now().toISOString();
    const result = await guarded('save support request', async () => {
      const db = await database();
      const ref = db.collection(journeyCollections.supportRequests).doc(id);
      let assignedHrAccountId = null;
      if (accounts?.getCompany) {
        try {
          const comp = await accounts.getCompany(account.companyId || DEFAULT_COMPANY_ID);
          assignedHrAccountId = comp?.defaultHr?.id ?? null;
        } catch {}
      }
      return db.runTransaction(async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists) return { created: false, doc: existing.data() };
        const doc = {
          id,
          accountId: account.id,
          companyId: account.companyId || DEFAULT_COMPANY_ID,
          assignedHrAccountId,
          conversationId,
          messageId,
          ...content,
          employeeNote: typeof body.note === 'string' ? cleanNote(body.note) : null,
          status: 'open',
          hrNote: null,
          briefingAt: null,
          docNeedsUpdate: false,
          docToUpdate: null,
          createdAt: at,
          updatedAt: at,
          updatedBy: null,
        };
        tx.create(ref, doc);
        return { created: true, doc };
      });
    });
    // The existing "I need a person" observation (idempotent per answer), so
    // team insights count it. The request already exists if this fails.
    try {
      await chatMemory().humanHelp(owner(account), conversationId, messageId);
    } catch {
      log('Support request saved; its help observation could not be recorded.');
    }
    return { created: result.created, request: myRequestView(result.doc) };
  }

  async function mine(account) {
    const found = await guarded('read support requests', async () =>
      (await collection()).where('accountId', '==', account.id).get(),
    );
    return found.docs
      .map((doc) => doc.data())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(myRequestView);
  }

  // GET /api/hr/support-requests: open first, then newest first. Requests of
  // accounts that no longer exist are left out (deletion removes them).
  async function hrList(actorOrCompanyId = null) {
    const actor =
      actorOrCompanyId && typeof actorOrCompanyId === 'object' && actorOrCompanyId.account
        ? actorOrCompanyId
        : null;
    const companyId = actor
      ? actor.account.companyId
      : typeof actorOrCompanyId === 'string'
        ? actorOrCompanyId
        : DEFAULT_COMPANY_ID;

    const [docs, employees, hrAccounts] = await Promise.all([
      guarded('read support requests', async () => {
        const col = await collection();
        return companyId ? col.where('companyId', '==', companyId).get() : col.get();
      }).then((snap) => snap.docs.map((d) => d.data())),
      accounts.listEmployees(actor || companyId),
      accounts.listCompanyHr
        ? accounts
            .listCompanyHr(companyId)
            .then((r) => r.hrAccounts)
            .catch(() => [])
        : Promise.resolve([]),
    ]);
    const hrById = new Map(
      (hrAccounts || []).map((h) => [h.id, { id: h.id, username: h.username }]),
    );
    const byId = new Map(employees.map((item) => [item.account.id, item]));
    const requests = docs
      .filter((doc) => byId.has(doc.accountId))
      .sort(
        (a, b) =>
          Number(b.status === 'open') - Number(a.status === 'open') ||
          (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
      )
      .map((doc) => {
        const item = byId.get(doc.accountId);
        const assignedHr = doc.assignedHrAccountId
          ? (hrById.get(doc.assignedHrAccountId) ?? null)
          : null;
        return hrRequestView(
          doc,
          {
            id: item.account.id,
            username: item.account.username,
            name: displayName(item),
          },
          assignedHr,
        );
      });
    const counts = Object.fromEntries(requestStatuses.map((status) => [status, 0]));
    for (const request of requests) if (request.status in counts) counts[request.status]++;
    return { requests, counts };
  }

  // PATCH /api/hr/support-requests/:id, with a support_request_updated audit row.
  async function hrUpdate(actor, id, body) {
    const changes = validateRequestPatch(body);
    if (typeof id !== 'string' || !requestIdPattern.test(id))
      throw journeyErrors.supportRequestNotFound();
    const before = await guarded('read support request', async () =>
      (await collection()).doc(id).get(),
    );
    if (!before.exists) throw journeyErrors.supportRequestNotFound();
    const beforeData = before.data();
    if (
      beforeData.companyId &&
      actor?.account?.companyId &&
      beforeData.companyId !== actor.account.companyId
    ) {
      throw journeyErrors.supportRequestNotFound();
    }
    const accountId = beforeData.accountId;
    let updated;
    try {
      updated = await accounts.recordEmployeeChange(
        actor,
        accountId,
        'support_request_updated',
        () =>
          guarded('save support request', async () => {
            const db = await database();
            const ref = db.collection(journeyCollections.supportRequests).doc(id);
            return db.runTransaction(async (tx) => {
              const snapshot = await tx.get(ref);
              if (!snapshot.exists) throw journeyErrors.supportRequestNotFound();
              const snapData = snapshot.data();
              if (
                snapData.companyId &&
                actor?.account?.companyId &&
                snapData.companyId !== actor.account.companyId
              ) {
                throw journeyErrors.supportRequestNotFound();
              }
              const next = {
                ...applyRequestPatch(snapData, changes),
                updatedAt: now().toISOString(),
                updatedBy: actor.account.id,
              };
              tx.set(ref, next);
              return next;
            });
          }),
        { supportRequestId: id, status: changes.status ?? beforeData.status },
      );
    } catch (error) {
      if (error?.code === 'EMPLOYEE_NOT_FOUND') throw journeyErrors.supportRequestNotFound();
      throw error;
    }
    const { account, profile } = await accounts.getEmployee(actor, accountId);
    let assignedHr = null;
    if (updated.assignedHrAccountId && accounts.listCompanyHr && actor?.account?.companyId) {
      try {
        const { hrAccounts } = await accounts.listCompanyHr(actor.account.companyId);
        const hr = (hrAccounts || []).find((h) => h.id === updated.assignedHrAccountId);
        if (hr) assignedHr = { id: hr.id, username: hr.username };
      } catch {}
    }
    return hrRequestView(
      updated,
      {
        id: account.id,
        username: account.username,
        name: profile?.job.preferredName || profile?.job.fullName || account.username,
      },
      assignedHr,
    );
  }

  // GET /api/hr/team-insights: every employee's support summary, summed.
  async function insights(actor = null) {
    const employees = await accounts.listEmployees(actor);
    const summaries = [];
    for (let i = 0; i < employees.length; i += 10) {
      const batch = employees.slice(i, i + 10);
      summaries.push(
        ...(await Promise.all(
          batch.map(async ({ account }) => {
            try {
              return await chatMemory().supportSummary(`account:${account.id}`);
            } catch (error) {
              throw asProfileStorageError(error);
            }
          }),
        )),
      );
    }
    const known = new Set(employees.map((item) => item.account.id));
    const companyId = actor?.account?.companyId;
    const open = await guarded('count support requests', async () => {
      const col = await collection();
      const q = companyId ? col.where('companyId', '==', companyId) : col;
      return q.select('accountId', 'status', 'companyId').get();
    });
    return teamInsights(summaries, {
      openSupportRequests: open.docs
        .filter(
          (doc) =>
            doc.data().status === 'open' &&
            (!companyId || (doc.data().companyId || 'univrse') === companyId),
        )
        .filter((doc) => known.has(doc.data().accountId)).length,
    });
  }

  return { preview, create, mine, hrList, hrUpdate, insights };
}
