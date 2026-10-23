import { ChatError } from './chat-errors.mjs';
import { companyOrDefault as companyOf } from './companies.mjs';
import { companyDocumentFileErrors } from './company-document-files.mjs';
import { gcsObjectName, objectContentType } from './company-documents.mjs';
import { titleFromFileName } from './company-knowledge.mjs';
import { areaOrder } from './onboarding-content.mjs';

// An employee's own company documents (issue #126): the active entries of the
// signed-in account's company in the HR library (companyDocuments), and the
// uploaded file of one of them from DOCS_BUCKET. Never another company's
// entries, never a retired one, never the text, object name, bucket or Vertex
// AI Search ids.
//
//   GET /api/me/company-documents            -> 200 { documents: [Document] }
//   GET /api/me/company-documents/:id/file   -> 200 the file's bytes
//
//   Document: { id, title, category, fileName, uploadedAt, viewUrl }
//
// Errors: 404 DOCUMENT_NOT_FOUND (unknown, retired or another company's id, or
// its object is gone), 503 COMPANY_DOCUMENTS_UNAVAILABLE (the library or the
// bucket cannot be read, or is not configured). Role and session errors come
// from the account routes' employee guard.
export const companyDocumentAreaOrder = Object.freeze([...areaOrder, 'additional']);
const areaRank = (category) => {
  const index = companyDocumentAreaOrder.indexOf(category);
  return index < 0 ? companyDocumentAreaOrder.length : index;
};
const byAreaThenTitle = (a, b) =>
  areaRank(a.category) - areaRank(b.category) ||
  a.title.localeCompare(b.title, 'en', { numeric: true, sensitivity: 'base' }) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const companyDocumentViewUrl = (id) =>
  `/api/me/company-documents/${encodeURIComponent(id)}/file`;

// What an employee sees of one library entry.
export const employeeCompanyDocument = (entry) => ({
  id: entry.id,
  title: entry.title || titleFromFileName(entry.fileName),
  category: entry.category,
  fileName: entry.fileName,
  uploadedAt: typeof entry.connectedAt === 'string' ? entry.connectedAt : null,
  viewUrl: companyDocumentViewUrl(entry.id),
});

// RFC 5987 / 6266: the file name as UTF-8, percent-encoded.
const encodedFileName = (name) =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// A stored entry's object: the name it was written under, or the name the
// upload rule gives it (entries from before objectName was stored).
export const companyDocumentObjectName = (entry) =>
  entry.objectName || gcsObjectName(entry.id, entry.fileName, entry.companyId);

// documents: the company-documents.mjs store (list, get). files: the
// company-document-files.mjs reader, or null (no DOCS_BUCKET: 503).
export function createEmployeeCompanyDocuments({ documents, files }) {
  // A library or bucket error keeps its 404 as DOCUMENT_NOT_FOUND; anything
  // else is the 503 (no storage detail reaches the browser).
  const storageCall = async (source, fn) => {
    if (!source) throw companyDocumentFileErrors.unavailable();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ChatError && error.status === 404)
        throw companyDocumentFileErrors.notFound();
      throw companyDocumentFileErrors.unavailable();
    }
  };
  return {
    // The account's company's active documents, by area order then title.
    async list(account) {
      const companyId = companyOf(account.companyId);
      const entries = await storageCall(documents, () => documents.list(companyId));
      return entries
        .filter((entry) => entry.status !== 'retired' && entry.companyId === companyId)
        .map(employeeCompanyDocument)
        .sort(byAreaThenTitle);
    },
    // { document, bytes, contentType, fileName } for one active entry of the
    // account's company; the same 404 for every other id.
    async download(account, id) {
      const companyId = companyOf(account.companyId);
      const entry = await storageCall(documents, () => documents.get(id, companyId));
      if (entry.status === 'retired' || entry.companyId !== companyId)
        throw companyDocumentFileErrors.notFound();
      const objectName = companyDocumentObjectName(entry);
      const bytes = await storageCall(files, () => files.get(objectName));
      return {
        document: employeeCompanyDocument(entry),
        bytes,
        contentType: objectContentType(objectName),
        fileName: entry.fileName || objectName.split('/').pop(),
      };
    },
  };
}

// Added to the /api/me router of account-routes.mjs (its Origin check,
// ACCOUNTS_NOT_CONFIGURED and { code, error } errors). `employeeOnly` is its
// employee guard: HR, admin and signed-out requests get its role and session
// errors. The file is sent inline; a browser opens a PDF or text file and
// downloads a Word file.
export function mountEmployeeCompanyDocumentRoutes({ me, employeeOnly, service }) {
  me.get('/company-documents', employeeOnly, async (req, res) => {
    res.json({ documents: await service.list(req.accountSession.account) });
  });
  me.get('/company-documents/:id/file', employeeOnly, async (req, res) => {
    const file = await service.download(req.accountSession.account, req.params.id);
    res
      .set({
        'Content-Type': file.contentType,
        'Content-Disposition': `inline; filename*=UTF-8''${encodedFileName(file.fileName)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(file.bytes);
  });
}
