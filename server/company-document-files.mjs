import { ChatError } from './chat-errors.mjs';
import { objectBody } from './company-documents.mjs';
import { gcsObjectName, gcsObjectUrl } from './discovery-engine-documents.mjs';

// The bytes of an uploaded company document (issue #126), read from the
// object the HR upload wrote to DOCS_BUCKET (company-documents.mjs
// createVertexDocumentSync): the original file for PDF and Word, the
// extracted UTF-8 text for text and Markdown. Read-only; the api's own
// credentials (roles/storage.objectUser on that bucket). Nothing is logged.
//
//   get(objectName) -> Buffer
//     404 DOCUMENT_NOT_FOUND            the object is gone
//     503 COMPANY_DOCUMENTS_UNAVAILABLE no bucket, no token, a failed or timed-out read
export const companyDocumentFileErrors = {
  notFound: () =>
    new ChatError(404, 'DOCUMENT_NOT_FOUND', 'That document is not in your company library.'),
  unavailable: () =>
    new ChatError(
      503,
      'COMPANY_DOCUMENTS_UNAVAILABLE',
      'Company documents are temporarily unavailable. Please try again shortly.',
    ),
};

export const COMPANY_DOCUMENT_READ_TIMEOUT_MS = 20000;

// null without DOCS_BUCKET (the routes then answer 503).
export function createCompanyDocumentFiles({
  env = {},
  fetchImpl = fetch,
  getAccessToken,
  timeoutMs = COMPANY_DOCUMENT_READ_TIMEOUT_MS,
} = {}) {
  const bucket = String(env?.DOCS_BUCKET || '').trim();
  if (!bucket || typeof getAccessToken !== 'function') return null;
  return {
    async get(objectName) {
      let response;
      try {
        const token = await getAccessToken();
        response = await fetchImpl(`${gcsObjectUrl(bucket, objectName)}?alt=media`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw companyDocumentFileErrors.unavailable();
      }
      if (response.status === 404) throw companyDocumentFileErrors.notFound();
      if (!response.ok) throw companyDocumentFileErrors.unavailable();
      try {
        return Buffer.from(await response.arrayBuffer());
      } catch {
        throw companyDocumentFileErrors.unavailable();
      }
    },
  };
}

// The local preview and the tests: objects kept in memory. `documentSync` is a
// company-documents.mjs sync stand-in (no Vertex AI Search) that stores each
// upload the way the GCS sync does, so an HR upload can be opened again.
export function createMemoryCompanyDocumentFiles() {
  const files = new Map();
  const objectName = gcsObjectName;
  return {
    temporary: true,
    files,
    async get(name) {
      if (!files.has(name)) throw companyDocumentFileErrors.notFound();
      return Buffer.from(files.get(name));
    },
    put(name, bytes) {
      files.set(name, Buffer.from(bytes));
    },
    documentSync: {
      async uploadDocument({ id, fileName, text, content, companyId }) {
        const name = objectName(id, fileName, companyId);
        files.set(name, objectBody(name, { text, content }).body);
      },
      async deleteDocument({ id, fileName, objectName: stored = null, companyId = null }) {
        files.delete(stored || objectName(id, fileName, companyId));
      },
      async removeObject({ id, fileName, companyId = null }) {
        files.delete(objectName(id, fileName, companyId));
      },
    },
  };
}
