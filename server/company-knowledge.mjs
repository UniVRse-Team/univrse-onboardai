import { AccountError } from './account-errors.mjs';
import { ALLOWLIST_PAGE_SIZE } from './active-company-documents.mjs';
import { companyDocumentErrors } from './company-documents.mjs';
import { companyDocumentIdPattern } from './discovery-engine-documents.mjs';
import { documentCategories, onboardingDocumentTopics } from './onboarding-document-topics.mjs';
import { workspaceLimits } from './workspace-limits.mjs';

// Company knowledge for signed-in accounts (issues #32 and #35):
//
// - The HR library at /api/hr/company-knowledge (account-routes.mjs): files
//   that HR uploads, tracked as metadata only in Firestore companyDocuments
//   (company-documents.mjs) for the HR dashboard (`list`, `add`, `replace`,
//   `move`, `remove`, `describe`). The store syncs each upload, replace and
//   delete to the GCS documents bucket and the Vertex AI Search data store.
// - Runtime retrieval for chats and document search (`retrieve`, `quote`):
//   queries Vertex AI Search (`companyRetrieve`) exclusively and never searches
//   or falls back to in-memory Firestore `companyDocuments`. With the
//   retrieval allowlist (`active`, active-company-documents.mjs, issue #79)
//   it asks for 10 results, reads the library's active entries alongside the
//   search, and keeps the first 5 passages of active documents, each with its
//   upload date.
export const isAccountOwner = (owner) => typeof owner === 'string' && owner.startsWith('account:');

// Up to `limit` passages, alternating between two ranked lists (first list first),
// so each source keeps its own rank order and neither crowds out the other.
export function interleavePassages(first, second, limit) {
  const merged = [];
  for (let i = 0; merged.length < limit && (i < first.length || i < second.length); i++) {
    if (i < first.length) merged.push(first[i]);
    if (merged.length < limit && i < second.length) merged.push(second[i]);
  }
  return merged;
}

const requestErrors = {
  fileRequired: () =>
    new AccountError(
      415,
      'FILE_UPLOAD_REQUIRED',
      'Upload a PDF, Word (.docx), text or Markdown file. Google Docs links are no longer accepted.',
    ),
  topicRequired: () =>
    new AccountError(
      400,
      'DOCUMENT_TOPIC_REQUIRED',
      'Choose one of the five onboarding areas or Other useful guidance.',
    ),
  nameInvalid: () =>
    new AccountError(
      400,
      'DOCUMENT_NAME_INVALID',
      'Give the document a short name of one line and up to 80 characters, or leave the name out to use the file name.',
    ),
};
export { requestErrors as companyKnowledgeRequestErrors };

const validTitle = (title) =>
  Boolean(title) && title.length <= 80 && !/[\u0000-\u001f\u007f]/.test(title);

// A document's title from its file name: no extension, no control characters,
// at most 80 characters.
export function titleFromFileName(fileName) {
  const base = String(fileName ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return base || 'Company document';
}

// What the HR page sees of a stored document: never the text. version: 1 for
// a first upload, + 1 per replacement; connectedAt: ISO 8601, the upload of
// this version (created is the same instant in ms since epoch).
const documentView = ({
  id,
  title,
  fileName,
  category,
  characters,
  bytes,
  created,
  version,
  connectedAt,
}) => ({
  id,
  title,
  fileName,
  category,
  characters,
  bytes,
  created,
  version: Number.isInteger(version) && version >= 1 ? version : 1,
  connectedAt: connectedAt ?? null,
});

export function createCompanyKnowledge({
  // createCompanyDocumentStore(...)
  documents,
  // The company retriever (Vertex AI Search): retrieve(query, { signal,
  // pageSize }) -> passages.
  companyRetrieve,
  // The retrieval allowlist (createActiveDocuments), or null: every passage
  // companyRetrieve returns is then used as it is (the sample guide).
  active = null,
  // onChange(): called after every add, replace, move and remove call,
  // whether it changed anything, succeeded or failed, so a cache of the
  // library (the retrieval allowlist) can drop its snapshot. It must be
  // synchronous and cheap; what it throws is ignored.
  onChange = null,
}) {
  const changed = () => {
    try {
      onChange?.();
    } catch {
      // A cache that cannot be dropped must not fail the HR request.
    }
  };
  const afterChange = async (work) => {
    try {
      return await work();
    } finally {
      changed();
    }
  };
  // The company passages for a query: with the allowlist, the search and the
  // library snapshot run in parallel, then only passages of active documents
  // are kept (a library failure rejects with the 503 or 504).
  async function search(query, options) {
    const opts = typeof options === 'object' && options !== null ? options : {};
    const hasOptions = Boolean(opts.signal || opts.companyId);
    if (!active) return companyRetrieve(query, hasOptions ? opts : undefined);
    const [found, current] = await Promise.all([
      companyRetrieve(query, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        pageSize: ALLOWLIST_PAGE_SIZE,
        ...(opts.companyId ? { companyId: opts.companyId } : {}),
      }),
      active.snapshot(),
    ]);
    return active.admit(found, current, { companyId: opts.companyId });
  }

  // Lists stored documents for the HR dashboard without exposing their text.
  async function list(companyId = null) {
    return (await documents.list(companyId)).map(documentView);
  }

  // GET /api/hr/company-knowledge: never the text.
  async function snapshot(companyId = null) {
    return {
      topics: onboardingDocumentTopics,
      documents: await list(companyId),
      limits: workspaceLimits,
    };
  }

  // Validates an upload's query before the file is read: the category (an
  // area id or 'additional'), the optional document name and the optional
  // `replaces` document ID. Returns { category, name, replaces } where name is
  // HR's trimmed name or null (the file name is then the title, or on a
  // replace the replaced document's title) and replaces is null without it.
  // A `replaces` that is not one document ID is the 404.
  function describe({ category, name, replaces }) {
    if (typeof category !== 'string' || !documentCategories.includes(category))
      throw requestErrors.topicRequired();
    let title = null;
    if (name !== undefined) {
      title = typeof name === 'string' ? name.trim() : '';
      if (!validTitle(title)) throw requestErrors.nameInvalid();
    }
    if (replaces === undefined) return { category, name: title, replaces: null };
    if (typeof replaces !== 'string' || !companyDocumentIdPattern.test(replaces))
      throw companyDocumentErrors.notFound();
    return { category, name: title, replaces };
  }

  // Stores a file read by readUploadedDocument ({ name, text, bytes, content? })
  // in the described area. Resolves to { id, duplicate: false, replaced: null }
  // or { id, duplicate: true, replaced: null }.
  const add = (actorId, { category, name }, file, at, companyId = 'univrse') =>
    afterChange(async () => {
      const added = await documents.add(
        {
          category,
          title: name ?? titleFromFileName(file.name),
          fileName: file.name,
          text: file.text,
          bytes: file.bytes,
          content: file.content,
        },
        actorId,
        at,
        companyId,
      );
      return { id: added.id, duplicate: added.duplicate, replaced: null };
    });

  // Replaces document `replaces` with a file (POST .../documents?replaces=).
  // `audit(detail, during)` runs the change inside the company_document_replaced
  // audit row. Resolves to { id: newId, duplicate: false, replaced: { id,
  // cleanup } } or { id: replaces, duplicate: true, replaced: null }.
  const replace = (actorId, { category, name, replaces }, file, at, audit, companyId = 'univrse') =>
    afterChange(() =>
      documents.replace(
        replaces,
        {
          category,
          title: name,
          fallbackTitle: titleFromFileName(file.name),
          fileName: file.name,
          text: file.text,
          bytes: file.bytes,
          content: file.content,
        },
        actorId,
        at,
        { audit },
        companyId,
      ),
    );

  // PATCH /api/hr/company-knowledge/documents/:id { category }. `audit` runs
  // the move inside the company_document_moved audit row. Resolves to
  // { document } (no audit row when the document is already there).
  async function move(id, body, audit, companyId = null) {
    const category = body && typeof body === 'object' ? body.category : undefined;
    if (typeof category !== 'string' || !documentCategories.includes(category))
      throw requestErrors.topicRequired();
    const before = await documents.get(id, companyId);
    if (before.category === category) return { document: documentView(before) };
    const moved = await audit({ documentId: before.id, from: before.category, to: category }, () =>
      documents.move(id, category, companyId),
    );
    return { document: documentView(moved) };
  }

  return {
    snapshot,
    list,
    describe,
    add,
    replace,
    move: (id, body, audit, companyId = null) =>
      afterChange(() => move(id, body, audit, companyId)),
    remove: (id, companyId = null) => afterChange(() => documents.remove(id, companyId)),
    // Gemini chat: always and only queries companyRetrieve (Vertex AI Search),
    // through the allowlist when there is one.
    retrieve: (query, options = {}) => search(query, options),
    // Document search: the same search and allowlist.
    quote: (question, options = {}) => search(question, options),
  };
}
