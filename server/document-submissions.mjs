import { randomUUID } from 'node:crypto';
import { DEFAULT_COMPANY_ID } from './companies.mjs';
import { ChatError } from './chat-errors.mjs';
import {
  documentTypes,
  reviewStatuses,
  fileTypes,
  fileExtension,
  fileProblem,
} from '../shared/document-submissions.mjs';
import { readUploadedDocument } from './read-uploaded-document.mjs';

export const submissionCollection = 'employeeDocumentSubmissions';
const fail = (status, message) => new ChatError(status, 'DOCUMENT_SUBMISSION_ERROR', message);
const validId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const notFound = () => fail(404, 'Submission not found.');
export async function validateSubmissionFile(name, bytes) {
  if (typeof name !== 'string' || name.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(name))
    throw fail(400, 'Use a file name without a folder path, up to 180 characters.');
  const problem = fileProblem({ name, size: Buffer.isBuffer(bytes) ? bytes.length : 0 });
  if (problem) throw fail(400, problem);
  const ext = fileExtension(name);
  if (ext === 'pdf' || ext === 'docx')
    await readUploadedDocument(name, bytes, { validateOnly: true });
  else if (
    ext === 'png'
      ? !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.length < 33
      : !bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
        !bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'))
  )
    throw fail(422, 'The file contents do not match the selected format. Export a fresh copy.');
  return fileTypes[ext];
}

// The newest submission of each documentation step: that one decides the step.
export function latestByStep(submissions) {
  const latest = {};
  for (const item of submissions)
    if (item.stepId && (!latest[item.stepId] || item.submittedAt > latest[item.stepId].submittedAt))
      latest[item.stepId] = item;
  return latest;
}
// A submission is reviewed once: Pending Review -> Under Review -> a decision.
// Approved and Rejected are final; a rejected document is replaced by a resubmission.
const decided = ['Approved', 'Rejected'];

export function createDocumentSubmissions({
  firestore,
  files,
  accounts,
  onboarding,
  now = () => new Date(),
}) {
  const db = async () => (typeof firestore === 'function' ? firestore() : firestore);
  const collection = async () => (await db()).collection(submissionCollection);
  const ready = () => {
    if (!files)
      throw fail(503, 'Private document storage has not been configured. No file was uploaded.');
  };
  async function get(account, id) {
    if (!validId(id)) throw notFound();
    const snapshot = await (await collection()).doc(id).get();
    const data = snapshot.exists ? snapshot.data() : null;
    if (!data) throw notFound();
    if (account.role !== 'hr' && data.employeeAccountId !== account.id) throw notFound();
    if (account.companyId && data.companyId && data.companyId !== account.companyId)
      throw notFound();
    return data;
  }
  // companyId: the employee's company, so the step list is that company's (#126).
  const sync = async (accountId, companyId) => {
    // Step progress follows the reviews. A failed sync is healed by the next read.
    try {
      await onboarding?.syncDocuments?.(accountId, companyId);
    } catch {
      // The submission and review are saved; progress catches up on the next read.
    }
  };
  async function ownSubmissions(accountId) {
    const snapshot = await (await collection()).where('employeeAccountId', '==', accountId).get();
    return snapshot.docs.map((doc) => doc.data());
  }
  return {
    // { [stepId]: status of the step's latest submission }, for step progress.
    async statusesFor(accountId) {
      return Object.fromEntries(
        Object.entries(latestByStep(await ownSubmissions(accountId))).map(([id, item]) => [
          id,
          item.status,
        ]),
      );
    },
    async list(account) {
      let query = await collection();
      if (account.role !== 'hr') {
        query = query.where('employeeAccountId', '==', account.id);
      } else if (account.companyId) {
        query = query.where('companyId', '==', account.companyId);
      }
      const snapshot = await query.get();
      return {
        submissions: snapshot.docs
          .map((doc) => doc.data())
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
        available: !!files,
        temporary: !!files?.temporary,
      };
    },
    get,
    async create(account, { type, title, fileName, resubmissionOf, stepId }, bytes) {
      ready();
      if (account.role !== 'employee') throw fail(403, 'Only employees can submit documents.');
      if (!documentTypes.includes(type)) throw fail(400, 'Choose a document type.');
      if (typeof title !== 'string' || !title.trim() || title.length > 300)
        throw fail(400, 'Enter a document title or description of up to 300 characters.');
      let step = null;
      if (stepId) {
        const plan = await onboarding?.myOnboarding(account);
        step = plan?.areas
          .find((area) => area.id === 'documentation')
          ?.steps.find((item) => item.id === stepId);
        if (!step) throw fail(400, 'Choose a documentation step from your onboarding plan.');
      }
      let previous = null;
      if (resubmissionOf) {
        previous = await get(account, resubmissionOf);
        if (previous.status !== 'Rejected')
          throw fail(409, 'Only rejected documents can be resubmitted.');
        if ((previous.stepId || null) !== (stepId || null))
          throw fail(400, 'Resubmit in the original documentation step.');
      }
      if (step) {
        // One document is in play per step: a new one is accepted only when there
        // is none yet, or the latest was rejected (and then it replaces that one).
        const latest = latestByStep(await ownSubmissions(account.id))[step.id];
        if (latest && latest.status !== 'Rejected')
          throw fail(409, 'This task is already completed.');
        if (latest && previous?.id !== latest.id) resubmissionOf = latest.id;
      }
      const mime = await validateSubmissionFile(fileName, bytes);
      const profile = await accounts.myProfile(account);
      const record = {
        id: randomUUID(),
        employeeAccountId: account.id,
        employeeId: account.username,
        employeeName: profile?.job?.fullName || account.username,
        department: profile?.job?.department || 'Not assigned',
        companyId: account.companyId || DEFAULT_COMPANY_ID,
        type,
        title: step?.title || title.trim(),
        stepId: step?.id || null,
        stepTitle: step?.title || null,
        fileName,
        mime,
        bytes: bytes.length,
        submittedAt: now().toISOString(),
        status: 'Pending Review',
        remarks: '',
        reviewedAt: null,
        reviewedBy: null,
        revision: 1,
        resubmissionOf: resubmissionOf || null,
        reviewerId: null,
      };
      await files.put(record.id, bytes, mime);
      try {
        await (await collection()).doc(record.id).set(record);
      } catch (error) {
        await files.remove(record.id).catch(() => {});
        throw error;
      }
      await sync(account.id, record.companyId);
      return record;
    },
    async download(account, id) {
      const record = await get(account, id);
      ready();
      return { record, bytes: await files.get(id) };
    },
    async review(account, id, { status, remarks = '', revision } = {}) {
      if (account.role !== 'hr') throw fail(403, 'Only HR can review submissions.');
      if (!reviewStatuses.includes(status) || status === 'Pending Review')
        throw fail(400, 'Choose Under Review, Approved or Rejected.');
      if (
        typeof remarks !== 'string' ||
        remarks.length > 2000 ||
        (status === 'Rejected' && !remarks.trim())
      )
        throw fail(400, 'A rejection reason is required (up to 2,000 characters).');
      if (!validId(id)) throw notFound();
      const ref = (await collection()).doc(id);
      const reviewed = await (
        await db()
      ).runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw notFound();
        const record = snap.data();
        if (account.companyId && record.companyId && record.companyId !== account.companyId)
          throw notFound();
        if (record.revision !== revision)
          throw fail(409, 'This submission changed. Refresh and review the latest version.');
        if (decided.includes(record.status))
          throw fail(409, `This submission was already ${record.status.toLowerCase()}.`);
        const updated = {
          ...record,
          status,
          remarks: remarks.trim(),
          reviewedAt: now().toISOString(),
          reviewedBy: account.username,
          reviewerId: account.id,
          revision: record.revision + 1,
        };
        tx.set(ref, updated);
        return updated;
      });
      await sync(reviewed.employeeAccountId, reviewed.companyId || account.companyId);
      return reviewed;
    },
    async eraseEmployee(id) {
      const result = await (await collection()).where('employeeAccountId', '==', id).get();
      if (result.docs.length) ready();
      for (const doc of result.docs) {
        await files.remove(doc.id);
        await doc.ref.delete();
      }
    },
  };
}
