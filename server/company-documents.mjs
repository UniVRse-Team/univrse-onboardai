import { createHash, randomUUID } from 'node:crypto';
import { AccountError } from './account-errors.mjs';
import { ChatError } from './chat-errors.mjs';
import {
  companyDocumentIdPattern,
  dataStoreDocumentUrl,
  extensionOf,
  gcsObjectName,
  gcsObjectUrl,
  gcsUploadUrl,
  importUrl,
  listDataStoreDocuments,
  vertexDocumentId,
} from './discovery-engine-documents.mjs';
import { createStorageCall } from './firestore-client.mjs';
import { createAccessTokenProvider } from './vertex-ai.mjs';
import { workspaceLimits } from './workspace-limits.mjs';

export { gcsObjectName };

// The company-wide knowledge library metadata that signed-in HR builds by
// uploading files, one Firestore document per file: companyDocuments/{id}
//
//   category      one of the five onboarding area IDs, or 'additional'
//   title         the document's own title: HR's name for it, or the file name
//                 without its extension (never the area's title)
//   fileName      the uploaded file's name (absent on documents connected from
//                 Google Docs before issue #35, which still list)
//   characters, bytes (the file's size), fingerprint (SHA-256 of extracted text)
//   connectedBy   the HR account ID; connectedAt: ISO 8601, the upload of this version
//   status        'active' | 'retired' (missing reads as 'active'). A retired
//                 entry is a replaced version on its way out: it is not part
//                 of the library (list, limits and duplicate checks skip it)
//   version       1 for a first upload, the replaced version's + 1 for a
//                 replacement (missing reads as 1)
//   supersedes    on a replacement: the replaced document's ID (kept for audit;
//                 that entry no longer exists once the replace finishes)
//   retiredAt     ISO 8601, when the entry was retired (null after a rollback)
//
// Firestore holds metadata only, for the HR dashboard list, duplicate detection
// and the library limits: never the extracted text or the file's bytes.
// Documents stored before that change may still carry a `text` field, which is
// no longer read. Runtime retrieval never reads this collection.
//
// When DOCS_BUCKET and VERTEX_SEARCH_DATA_STORE_ID are configured, each upload
// also writes the document to the GCS bucket and triggers a Vertex AI Search
// documents:import job for that one object (INCREMENTAL); a failed sync removes
// the new metadata again. Each delete removes the object from GCS and deletes
// the document from Vertex AI Search first, then the metadata, so a failed
// sync leaves the document listed for HR to retry. Firestore calls are bounded
// by the storage deadline and each sync request by its own; every sync request
// logs one structured line (syncLine) that names the operation, the status and
// the Firestore ID only, never file names, titles, URIs, buckets or text.
export const companyDocumentCollection = 'companyDocuments';
const idPattern = companyDocumentIdPattern;
const fingerprintOf = (text) => createHash('sha256').update(text).digest('hex');

// Each GCS or Discovery Engine request made by the api's sync has this deadline.
export const SYNC_REQUEST_TIMEOUT_MS = 15000;

export function vertexDocumentSyncConfig(env = {}) {
  const project = String(env?.GOOGLE_CLOUD_PROJECT || '').trim();
  const location = String(env?.VERTEX_SEARCH_LOCATION || '').trim() || 'global';
  const bucket = String(env?.DOCS_BUCKET || '').trim();
  const dataStore = String(env?.VERTEX_SEARCH_DATA_STORE_ID || '').trim();
  if (!project || !bucket || !dataStore) return null;
  return { project, location, bucket, dataStore };
}

// ONBOARDAI_ENVIRONMENT, for log labels only: 'staging' | 'production', else 'local'.
export function deploymentEnvironment(env = {}) {
  const value = String(env?.ONBOARDAI_ENVIRONMENT ?? '').trim();
  return value === 'staging' || value === 'production' ? value : 'local';
}

export const syncOperations = Object.freeze([
  'gcs.upload',
  'gcs.delete',
  'discoveryengine.import',
  'discoveryengine.delete',
  'discoveryengine.list',
  'replace.rollback',
  'replace.cleanup',
]);

// One sync log line (contract C-SYNC): JSON on stdout, so Cloud Run reads it as
// jsonPayload with its severity. status: the HTTP status, or null (a timeout,
// a network error, or a replace step). reason: null when ok, else 'http',
// 'timeout' or 'network'.
export function syncLine({
  environment = 'local',
  operation,
  ok,
  status = null,
  reason = null,
  documentId = null,
}) {
  return {
    severity: ok ? 'INFO' : 'WARNING',
    event: 'onboardai_docs_sync',
    environment,
    operation,
    outcome: ok ? 'ok' : 'failed',
    status: Number.isInteger(status) ? status : null,
    reason: ok ? null : reason || 'network',
    documentId: typeof documentId === 'string' && idPattern.test(documentId) ? documentId : null,
  };
}
export const writeSyncLine = (entry) => console.log(JSON.stringify(entry));

// What failed, for the replace.* lines: { status, reason } of a sync request,
// or of a Firestore step (status null; 'timeout' on its deadline, else 'network').
const failureOf = (error) =>
  error?.sync ?? {
    status: null,
    reason: error?.code === 'COMPANY_KNOWLEDGE_TIMEOUT' ? 'timeout' : 'network',
  };

const mimeTypes = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
};

export function createVertexDocumentSync({
  env = {},
  fetchImpl = fetch,
  getAccessToken = createAccessTokenProvider(),
  logEvent = writeSyncLine,
  timeoutMs = SYNC_REQUEST_TIMEOUT_MS,
} = {}) {
  const config = vertexDocumentSyncConfig(env);
  if (!config) return null;
  const environment = deploymentEnvironment(env);
  const { project, bucket } = config;
  const importEndpoint = importUrl(config);
  const discoveryHeaders = (token, extra = {}) => ({
    Authorization: `Bearer ${token}`,
    'x-goog-user-project': project,
    ...extra,
  });

  // One bounded request, logged as one line. accept(response) decides whether
  // its status counts as done (2xx by default). Anything else throws the 503,
  // or the 504 when the request ran out of time; nothing is swallowed.
  async function call(operation, documentId, url, init, accept = (response) => response.ok) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const reason = timedOut ? 'timeout' : 'network';
      logEvent(syncLine({ environment, operation, ok: false, status: null, reason, documentId }));
      throw Object.assign(
        timedOut ? companyDocumentErrors.timeout() : companyDocumentErrors.unavailable(),
        { sync: { status: null, reason } },
      );
    }
    const ok = accept(response);
    logEvent(
      syncLine({
        environment,
        operation,
        ok,
        status: response.status,
        reason: ok ? null : 'http',
        documentId,
      }),
    );
    if (!ok)
      throw Object.assign(companyDocumentErrors.unavailable(), {
        sync: { status: response.status, reason: 'http' },
      });
    return response;
  }
  const doneOrGone = (response) => response.ok || response.status === 404;
  // No credentials: logged as a failed `operation` (status null, 'network').
  const token = async (operation, documentId) => {
    try {
      return await getAccessToken();
    } catch {
      logEvent(syncLine({ environment, operation, ok: false, reason: 'network', documentId }));
      throw Object.assign(companyDocumentErrors.unavailable(), {
        sync: { status: null, reason: 'network' },
      });
    }
  };
  const deleteObject = async (id, objectName, bearer) =>
    call(
      'gcs.delete',
      id,
      gcsObjectUrl(bucket, objectName),
      { method: 'DELETE', headers: { Authorization: `Bearer ${bearer}` } },
      doneOrGone,
    );

  return {
    async uploadDocument({ id, fileName, text, content, companyId = 'univrse' }) {
      const bearer = await token('gcs.upload', id);
      const objectName = gcsObjectName(id, fileName, companyId);
      const ext = extensionOf(objectName);
      const useBinary =
        (ext === 'pdf' || ext === 'docx') && Buffer.isBuffer(content) && content.length > 0;
      const body = useBinary ? content : Buffer.from(String(text || ''), 'utf8');
      const contentType = mimeTypes[ext] || mimeTypes.txt;
      const gsUri = `gs://${bucket}/${objectName}`;

      await call('gcs.upload', id, gcsUploadUrl(bucket, objectName), {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': contentType },
        body,
      });
      await call('discoveryengine.import', id, importEndpoint, {
        method: 'POST',
        headers: discoveryHeaders(bearer, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          inlineSource: {
            documents: [
              {
                id,
                structData: { companyId: companyId || 'univrse' },
                content: { mimeType: contentType, uri: gsUri },
              },
            ],
          },
          reconciliationMode: 'INCREMENTAL',
        }),
      });
    },

    // GCS object (404 = gone), then the Vertex AI Search document by its ID,
    // sha256(uri)[:32] (404 = gone). Only on that 404 does it list the data
    // store (every page) and delete any document with the same URI. A failed
    // or non-2xx request throws, so the caller keeps the Firestore entry.
    async deleteDocument({ id, fileName, objectName = null, companyId = null }) {
      const bearer = await token('gcs.delete', id);
      const targetObject = objectName || gcsObjectName(id, fileName, companyId);
      const gsUri = `gs://${bucket}/${targetObject}`;
      await deleteObject(id, targetObject, bearer);

      const deleteVertex = (vertexId) =>
        call(
          'discoveryengine.delete',
          id,
          dataStoreDocumentUrl(config, vertexId),
          { method: 'DELETE', headers: discoveryHeaders(bearer) },
          doneOrGone,
        );
      const hashId = vertexDocumentId(gsUri);
      const direct = await deleteVertex(hashId);
      if (direct.status !== 404) return;

      let listed;
      try {
        listed = await listDataStoreDocuments({
          config,
          request: (url) =>
            call('discoveryengine.list', id, url, {
              method: 'GET',
              headers: discoveryHeaders(bearer),
            }),
        });
      } catch (error) {
        if (error instanceof ChatError) throw error;
        // The page answered 2xx but its body was unreadable.
        throw companyDocumentErrors.unavailable();
      }
      for (const document of listed)
        if (document.uri === gsUri && document.id && document.id !== hashId)
          await deleteVertex(document.id);
    },

    // Only the GCS object (404 = gone): a replacement's leftover after a
    // failed import.
    async removeObject({ id, fileName, companyId = null }) {
      await deleteObject(id, gcsObjectName(id, fileName, companyId), await token('gcs.delete', id));
    },
  };
}

export const companyDocumentErrors = {
  notFound: () =>
    new AccountError(
      404,
      'WORKSPACE_DOCUMENT_NOT_FOUND',
      'That document is not in the company library.',
    ),
  textTaken: () =>
    new AccountError(
      409,
      'COMPANY_DOCUMENT_DUPLICATE',
      'This guidance is already in the company library in another area. Upload a different file.',
    ),
  textTakenByOther: () =>
    new AccountError(
      409,
      'COMPANY_DOCUMENT_DUPLICATE',
      'This guidance is already in the company library as another document. Upload a different file.',
    ),
  alreadyReplaced: () =>
    new AccountError(
      409,
      'COMPANY_DOCUMENT_ALREADY_REPLACED',
      'This document was just replaced. Refresh the library and try again.',
    ),
  full: () =>
    new AccountError(
      409,
      'WORKSPACE_DOCUMENT_LIMIT',
      `The company library supports ${workspaceLimits.files} documents. Remove one before adding another.`,
    ),
  tooMuchText: () =>
    new AccountError(
      413,
      'WORKSPACE_TEXT_LIMIT',
      'These guides exceed the company library’s readable text limit. Use a shorter guide.',
    ),
  unavailable: () =>
    new AccountError(
      503,
      'COMPANY_KNOWLEDGE_UNAVAILABLE',
      'The company document library is temporarily unavailable. Please try again shortly.',
    ),
  timeout: () =>
    new AccountError(
      504,
      'COMPANY_KNOWLEDGE_TIMEOUT',
      'The company document library took too long to respond. Please try again.',
    ),
};

export const statusOf = (data) => (data?.status === 'retired' ? 'retired' : 'active');
export const versionOf = (data) =>
  Number.isInteger(data?.version) && data.version >= 1 ? data.version : 1;
const isRetired = (doc) => statusOf(doc) === 'retired';
const library = (stored) => stored.filter((doc) => !isRetired(doc));
const totalCharacters = (docs) => docs.reduce((total, doc) => total + (doc.characters || 0), 0);

// Where an upload goes, given the stored documents ({ id, category,
// fingerprint, characters, status? }): { id, duplicate: true } when identical
// text is already stored in this area, else { id, duplicate: false } for a new
// document. An upload only ever adds. Retired entries are not counted. Throws
// the 409/413 errors.
export function planUpload(stored, { text, category }) {
  const current = library(stored);
  const fingerprint = fingerprintOf(text);
  const same = current.find((doc) => doc.fingerprint === fingerprint);
  if (same && same.category === category) return { id: same.id, duplicate: true };
  if (same) throw companyDocumentErrors.textTaken();
  if (current.length >= workspaceLimits.files) throw companyDocumentErrors.full();
  if (
    text.length > workspaceLimits.characters ||
    totalCharacters(current) + text.length > workspaceLimits.totalCharacters
  )
    throw companyDocumentErrors.tooMuchText();
  return { id: randomUUID(), duplicate: false };
}

// Replacing document `replaces` with a file's `text`, given the stored
// documents ({ id, category, fingerprint, characters, status?, version?,
// supersedes? }):
//   { id: replaces, duplicate: true }   the text is the replaced document's own
//   { id: newId, duplicate: false, replaced: <the stored entry>, version }
// 404 when `replaces` is not a current document; 409 ALREADY_REPLACED when it
// is retired or another entry already supersedes it; 409 DUPLICATE when
// another document holds the text; 413 with the replaced document's
// characters left out. The file-count limit never applies.
export function planReplace(stored, { replaces, text, newId = randomUUID() }) {
  if (typeof replaces !== 'string' || !idPattern.test(replaces))
    throw companyDocumentErrors.notFound();
  const old = stored.find((doc) => doc.id === replaces);
  if (!old) {
    if (stored.some((doc) => doc.supersedes === replaces))
      throw companyDocumentErrors.alreadyReplaced();
    throw companyDocumentErrors.notFound();
  }
  if (isRetired(old)) throw companyDocumentErrors.alreadyReplaced();
  const fingerprint = fingerprintOf(text);
  if (old.fingerprint === fingerprint) return { id: old.id, duplicate: true };
  const others = library(stored).filter((doc) => doc.id !== old.id);
  if (others.some((doc) => doc.fingerprint === fingerprint))
    throw companyDocumentErrors.textTakenByOther();
  if (
    text.length > workspaceLimits.characters ||
    totalCharacters(others) + text.length > workspaceLimits.totalCharacters
  )
    throw companyDocumentErrors.tooMuchText();
  return { id: newId, duplicate: false, replaced: old, version: versionOf(old) + 1 };
}

// Moving document `id` to `category`: { unchanged } is true when it is
// already there. 404 for an unknown or retired id, 409 when another document
// in the library already holds the same text.
export function planMove(stored, id, category) {
  const current = library(stored);
  const document = current.find((doc) => doc.id === id);
  if (!document) throw companyDocumentErrors.notFound();
  if (document.category === category) return { unchanged: true };
  if (current.some((doc) => doc.id !== id && doc.fingerprint === document.fingerprint))
    throw companyDocumentErrors.textTaken();
  return { unchanged: false };
}

const created = (data) => {
  const at = Date.parse(data.connectedAt);
  return Number.isFinite(at) ? at : 0;
};
const stored = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    title: String(data.title || ''),
    category: String(data.category || ''),
    fileName: String(data.fileName || ''),
    characters: Number(data.characters) || 0,
    bytes: Number(data.bytes) || 0,
    fingerprint: String(data.fingerprint || ''),
    connectedBy: data.connectedBy || null,
    connectedAt: data.connectedAt || null,
    companyId: data.companyId || 'univrse',
    objectName: data.objectName || null,
    created: created(data),
    status: statusOf(data),
    version: versionOf(data),
  };
};
const byConnection = (a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The fields of a summary (listSummaries, and the reconciler's runQuery): a
// select-only read that never touches the legacy `text` field.
export const companyDocumentSummaryFields = Object.freeze([
  'fileName',
  'title',
  'category',
  'status',
  'version',
  'connectedAt',
  'retiredAt',
  'companyId',
]);
// A summary from an entry's ID and (selected) data.
export function companyDocumentSummary(id, data = {}) {
  return {
    id,
    fileName: String(data.fileName || ''),
    title: String(data.title || ''),
    category: String(data.category || ''),
    status: statusOf(data),
    version: versionOf(data),
    connectedAt: typeof data.connectedAt === 'string' ? data.connectedAt : null,
    retiredAt: typeof data.retiredAt === 'string' ? data.retiredAt : null,
    companyId: data.companyId || 'univrse',
  };
}

// The fields the upload, move and replace plans read in their transactions.
const planFields = [
  'category',
  'fingerprint',
  'characters',
  'status',
  'version',
  'title',
  'fileName',
  'supersedes',
  'companyId',
  'objectName',
];
const planEntry = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    category: String(data.category || ''),
    fingerprint: String(data.fingerprint || ''),
    characters: Number(data.characters) || 0,
    status: statusOf(data),
    version: versionOf(data),
    title: String(data.title || ''),
    fileName: String(data.fileName || ''),
    supersedes: typeof data.supersedes === 'string' ? data.supersedes : null,
    companyId: data.companyId || 'univrse',
    objectName: data.objectName || null,
  };
};

export function createCompanyDocumentStore({
  // A Firestore instance, or an async function returning one.
  firestore,
  documentSync,
  env,
  fetchImpl,
  getAccessToken,
  timeoutMs,
  log,
  // Receives each C-SYNC line object (syncLine); stdout JSON by default.
  logEvent = writeSyncLine,
  syncTimeoutMs,
}) {
  let client = null;
  const database = async () =>
    (client ??= await (typeof firestore === 'function' ? firestore() : firestore));
  const sync =
    documentSync !== undefined
      ? documentSync
      : createVertexDocumentSync({
          env,
          fetchImpl,
          getAccessToken,
          logEvent,
          ...(syncTimeoutMs ? { timeoutMs: syncTimeoutMs } : {}),
        });
  const environment = deploymentEnvironment(env);
  const call = createStorageCall({ timeoutMs, log });
  const guarded = async (operation, fn) => {
    try {
      return await call(operation, fn);
    } catch (error) {
      if (error instanceof AccountError) throw error;
      if (error instanceof ChatError && !String(error.code).startsWith('STORAGE_')) throw error;
      if (error?.code === 'STORAGE_TIMEOUT') throw companyDocumentErrors.timeout();
      throw companyDocumentErrors.unavailable();
    }
  };
  const collection = (db) => db.collection(companyDocumentCollection);
  const validId = (id) => typeof id === 'string' && idPattern.test(id);
  const readPlanEntries = async (source) => (await source).docs.map(planEntry);

  // Step 2 of a replace failed: the new entry goes, the replaced one is
  // active again, then the new version's GCS object is deleted (best effort).
  async function rollBackReplace(db, newId, oldId, fileName, companyId = null) {
    let failure = null;
    try {
      await guarded('roll back company document replace', () =>
        db.runTransaction(async (tx) => {
          const newRef = collection(db).doc(newId);
          const oldRef = collection(db).doc(oldId);
          const [added, previous] = await tx.getAll(newRef, oldRef);
          if (added.exists) tx.delete(newRef);
          if (previous.exists && statusOf(previous.data()) === 'retired')
            tx.update(oldRef, { status: 'active', retiredAt: null });
        }),
      );
    } catch (error) {
      failure = error;
    }
    if (sync?.removeObject)
      try {
        await sync.removeObject({ id: newId, fileName, companyId });
      } catch (error) {
        failure ??= error;
      }
    logEvent(
      syncLine({
        environment,
        operation: 'replace.rollback',
        ok: !failure,
        ...(failure ? failureOf(failure) : {}),
        documentId: newId,
      }),
    );
  }

  // Step 3 of a replace: the replaced version's GCS object and Vertex AI
  // Search document, then its Firestore entry, which goes even when the sync
  // failed (chat no longer admits a retired entry; the reconciler finishes
  // the rest). 'done' | 'pending'.
  async function cleanUpReplaced(db, old) {
    let failure = null;
    if (sync)
      try {
        await sync.deleteDocument({
          id: old.id,
          fileName: old.fileName,
          objectName: old.objectName,
          companyId: old.companyId,
        });
      } catch (error) {
        failure = error;
      }
    try {
      await guarded('remove replaced company document', async () =>
        collection(db).doc(old.id).delete(),
      );
    } catch (error) {
      failure ??= error;
    }
    logEvent(
      syncLine({
        environment,
        operation: 'replace.cleanup',
        ok: !failure,
        ...(failure ? failureOf(failure) : {}),
        documentId: old.id,
      }),
    );
    return failure ? 'pending' : 'done';
  }

  return {
    // Every document in the library (retired entries left out), oldest first.
    list: (companyId = null) =>
      guarded('list company documents', async () => {
        const found = await collection(await database()).get();
        return found.docs
          .map(stored)
          .filter((doc) => doc.status !== 'retired')
          .filter((doc) => !companyId || doc.companyId === companyId)
          .sort(byConnection);
      }),
    // Every entry, retired ones included, as companyDocumentSummary objects
    // ({ id, fileName, title, category, status, version, connectedAt,
    // retiredAt }), oldest first. One select-only query: the legacy `text`
    // field is never read.
    listSummaries: (companyId = null) =>
      guarded('list company document summaries', async () => {
        const found = await collection(await database())
          .select(...companyDocumentSummaryFields)
          .get();
        return found.docs
          .map((doc) => ({
            ...companyDocumentSummary(doc.id, doc.data()),
            created: created(doc.data()),
          }))
          .filter((doc) => !companyId || doc.companyId === companyId)
          .sort(byConnection)
          .map(({ created: _created, ...summary }) => summary);
      }),
    // upload: { category, title, fileName, text, bytes, content? }. Checks and
    // writes metadata only (never the text) in one transaction, so two HR
    // browsers cannot both take the last place, then syncs new documents to
    // GCS + Vertex AI Search. Resolves to { id, duplicate }.
    add: async (upload, connectedBy, at, companyId = 'univrse') => {
      const db = await guarded('add company document', database);
      const plan = await guarded('add company document', () =>
        db.runTransaction(async (tx) => {
          const current = (
            await readPlanEntries(tx.get(collection(db).select(...planFields)))
          ).filter((doc) => !companyId || doc.companyId === companyId);
          const planned = planUpload(current, upload);
          if (planned.duplicate) return planned;
          const { category, title, fileName, text, bytes } = upload;
          const objectName = gcsObjectName(planned.id, fileName, companyId);
          tx.set(collection(db).doc(planned.id), {
            category,
            title,
            fileName,
            characters: text.length,
            bytes,
            fingerprint: fingerprintOf(text),
            connectedBy,
            connectedAt: at.toISOString(),
            status: 'active',
            version: 1,
            companyId,
            objectName,
          });
          return { ...planned, objectName };
        }),
      );
      if (!plan.duplicate && sync) {
        try {
          await sync.uploadDocument({
            id: plan.id,
            fileName: upload.fileName,
            title: upload.title,
            text: upload.text,
            content: upload.content,
            companyId,
          });
        } catch (error) {
          await guarded('add company document', () => collection(db).doc(plan.id).delete()).catch(
            () => {},
          );
          throw error;
        }
      }
      return { id: plan.id, duplicate: plan.duplicate };
    },
    // Replaces current document `replaces` with an upload ({ category, title:
    // HR's name or null to keep the replaced title, fallbackTitle, fileName,
    // text, bytes, content? }). audit(detail, during), when given, wraps the
    // change in its audit row ({ documentId: newId, replacedId, category });
    // a duplicate or a refused replace writes no row. Resolves to
    //   { id: newId, duplicate: false, replaced: { id, cleanup: 'done' | 'pending' } }
    //   { id: replaces, duplicate: true, replaced: null }
    // Sequence (the Firestore flip is the switch chat sees):
    //   1. one transaction: plan, create the new entry (version + 1,
    //      supersedes, active) and retire the old one;
    //   2. sync the new version; on failure roll step 1 back, delete the new
    //      GCS object and throw the 503/504 (the old version is active again);
    //   3. clean up the old version (cleanUpReplaced).
    replace: async (
      replaces,
      upload,
      connectedBy,
      at,
      { audit = null } = {},
      companyId = 'univrse',
    ) => {
      if (!validId(replaces)) throw companyDocumentErrors.notFound();
      const db = await guarded('replace company document', database);
      const readAll = () =>
        readPlanEntries(
          collection(db)
            .select(...planFields)
            .get(),
        );
      const allEntries = await guarded('replace company document', readAll);
      const companyEntries = allEntries.filter((doc) => !companyId || doc.companyId === companyId);
      // Checked before the audit row: a duplicate or refused replace leaves none.
      const checked = planReplace(companyEntries, {
        replaces,
        text: upload.text,
      });
      if (checked.duplicate) return { id: checked.id, duplicate: true, replaced: null };
      const newId = randomUUID();

      const run = async () => {
        const plan = await guarded('replace company document', () =>
          db.runTransaction(async (tx) => {
            const current = (
              await readPlanEntries(tx.get(collection(db).select(...planFields)))
            ).filter((doc) => !companyId || doc.companyId === companyId);
            const planned = planReplace(current, { replaces, text: upload.text, newId });
            if (planned.duplicate) return planned;
            const old = planned.replaced;
            const objectName = gcsObjectName(newId, upload.fileName, companyId);
            tx.set(collection(db).doc(newId), {
              category: upload.category,
              title: upload.title ?? (old.title || upload.fallbackTitle),
              fileName: upload.fileName,
              characters: upload.text.length,
              bytes: upload.bytes,
              fingerprint: fingerprintOf(upload.text),
              connectedBy,
              connectedAt: at.toISOString(),
              status: 'active',
              version: planned.version,
              supersedes: old.id,
              companyId,
              objectName,
            });
            tx.update(collection(db).doc(old.id), {
              status: 'retired',
              retiredAt: at.toISOString(),
            });
            return planned;
          }),
        );
        if (plan.duplicate) return { id: plan.id, duplicate: true, replaced: null };
        if (sync) {
          try {
            await sync.uploadDocument({
              id: newId,
              fileName: upload.fileName,
              title: upload.title,
              text: upload.text,
              content: upload.content,
              companyId,
            });
          } catch (error) {
            await rollBackReplace(db, newId, replaces, upload.fileName, companyId);
            throw error;
          }
        }
        const cleanup = await cleanUpReplaced(db, plan.replaced);
        return { id: newId, duplicate: false, replaced: { id: replaces, cleanup } };
      };
      return audit
        ? audit({ documentId: newId, replacedId: replaces, category: upload.category }, run)
        : run();
    },
    // One current document metadata entry, or the 404 (unknown or retired).
    get: (id, companyId = null) =>
      guarded('read company document', async () => {
        if (!validId(id)) throw companyDocumentErrors.notFound();
        const found = await collection(await database())
          .doc(id)
          .get();
        if (!found.exists || statusOf(found.data()) === 'retired')
          throw companyDocumentErrors.notFound();
        const item = stored(found);
        if (companyId && item.companyId !== companyId) throw companyDocumentErrors.notFound();
        return item;
      }),
    // Moves one document to another category (checked and written in one
    // transaction): 404 for an unknown or retired id, 409 when another
    // document already holds the same text. Resolves to the stored metadata.
    move: (id, category, companyId = null) =>
      guarded('move company document', async () => {
        if (!validId(id)) throw companyDocumentErrors.notFound();
        const db = await database();
        await db.runTransaction(async (tx) => {
          const docRef = collection(db).doc(id);
          const docSnap = await tx.get(docRef);
          if (!docSnap.exists || statusOf(docSnap.data()) === 'retired')
            throw companyDocumentErrors.notFound();
          const docCompanyId = docSnap.data().companyId || 'univrse';
          if (companyId && docCompanyId !== companyId) {
            throw companyDocumentErrors.notFound();
          }
          const current = (
            await readPlanEntries(tx.get(collection(db).select(...planFields)))
          ).filter((doc) => !companyId || doc.companyId === companyId);
          const plan = planMove(current, id, category);
          if (!plan.unchanged) tx.update(docRef, { category });
        });
        return stored(await collection(db).doc(id).get());
      }),
    // GCS and Vertex AI Search first: if either fails (a non-2xx answer, a
    // failed list, a timeout), the error is thrown and the metadata stays so
    // HR can retry (a retry tolerates the 404s of what is already gone).
    remove: (id, companyId = null) =>
      guarded('remove company document', async () => {
        if (!validId(id)) throw companyDocumentErrors.notFound();
        const db = await guarded('remove company document', database);
        const ref = collection(db).doc(id);
        const existing = await guarded('remove company document', async () => {
          const found = await ref.get();
          if (!found.exists || statusOf(found.data()) === 'retired')
            throw companyDocumentErrors.notFound();
          const item = stored(found);
          if (companyId && item.companyId !== companyId) throw companyDocumentErrors.notFound();
          return item;
        });
        if (sync) {
          await sync.deleteDocument({
            id: existing.id,
            fileName: existing.fileName,
            objectName: existing.objectName,
            companyId: existing.companyId,
          });
        }
        await guarded('remove company document', () =>
          db.runTransaction(async (tx) => {
            const found = await tx.get(ref);
            if (!found.exists || statusOf(found.data()) === 'retired')
              throw companyDocumentErrors.notFound();
            tx.delete(ref);
          }),
        );
      }),
    close: async () => {
      const open = client;
      client = null;
      await open?.terminate?.();
    },
  };
}
