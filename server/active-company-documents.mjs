import { ChatError } from './chat-errors.mjs';
import { companyDocumentErrors } from './company-documents.mjs';
import { profileSourceTitle } from './company-profile.mjs';
import { companyDocumentUri, vertexDocumentId } from './discovery-engine-documents.mjs';

// The retrieval allowlist (issue #79): a Vertex AI Search passage may reach
// Gemini, document search or the browser only when its document is an active
// entry of Firestore companyDocuments. Everything else is dropped before the
// passages are numbered: orphans whose entry was deleted, a replaced (retired)
// version, an unknown <uuid>/ folder, another file under a known ID, and
// documents imported by script (root or prefix objects with no entry). So
// Firestore is the one switch that decides what chat may cite.
//
// Matching is exact. For each active entry with a file name the expected URI
// is gs://<DOCS_BUCKET>/<object name> (companyDocumentUri) and the expected
// data store document ID is the first 32 hex characters of SHA-256 of that
// URI (vertexDocumentId). A passage matches when its document URI equals an
// expected URI (as returned, or with each path segment percent-decoded), or
// when the document ID in its chunk name equals an expected ID. A passage
// with neither is dropped: the allowlist fails closed.
//
// The library is read with listSummaries() (one select-only query, never the
// legacy text field) and cached per instance for ttlMs. A change on this
// instance (upload, replace, move, delete) drops the cache through
// invalidate(); other instances see it within ttlMs.

export const ACTIVE_DOCUMENTS_TTL_MS = 30_000;
// How long the last good snapshot may stand in when Firestore fails.
export const ACTIVE_DOCUMENTS_STALE_MS = 600_000;
// The allowlisted search asks for this many results and keeps ADMITTED_LIMIT
// admitted passages, so orphans do not use up the result budget.
export const ALLOWLIST_PAGE_SIZE = 10;
export const ADMITTED_LIMIT = 5;

// One log line (stdout JSON, read by Cloud Run as jsonPayload). It never holds
// a file name, title, URI, bucket name or text.
//   {"severity":"WARNING","event":"onboardai_active_documents","environment":"…","result":"stale_snapshot|unavailable"}
//   {"severity":"INFO","event":"onboardai_active_documents","environment":"…","result":"dropped","dropped":<int>}
export const activeDocumentsResults = Object.freeze(['stale_snapshot', 'unavailable', 'dropped']);
export function activeDocumentsLine({ environment = 'local', result, dropped = 0 }) {
  if (!activeDocumentsResults.includes(result)) throw new TypeError('Unknown result.');
  return result === 'dropped'
    ? {
        severity: 'INFO',
        event: 'onboardai_active_documents',
        environment,
        result,
        dropped: Number.isInteger(dropped) && dropped > 0 ? dropped : 0,
      }
    : { severity: 'WARNING', event: 'onboardai_active_documents', environment, result };
}
export const writeActiveDocumentsLine = (entry) => console.log(JSON.stringify(entry));

// 'YYYY-MM-DD' (UTC) of an ISO 8601 time, or null.
export function utcDateOf(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null;
}

// Snapshot: { byUri: Map<uri, Entry>, byVertexId: Map<id, Entry> }
// Entry: { id, title, category, version, connectedAt, date }
// Only active entries with a file name are in it (a retired version, or a
// legacy entry with no file name, has no passages chat may use).
export function activeSnapshot(summaries, bucket) {
  const byUri = new Map(),
    byVertexId = new Map();
  const name = String(bucket ?? '').trim();
  if (name)
    for (const summary of Array.isArray(summaries) ? summaries : []) {
      if (summary?.status !== 'active' || !summary.fileName || !summary.id) continue;
      const uri = companyDocumentUri({
        bucket: name,
        id: summary.id,
        fileName: summary.fileName,
        companyId: summary.companyId,
      });
      const entry = Object.freeze({
        id: summary.id,
        title: summary.title,
        category: summary.category,
        version: summary.version,
        connectedAt: summary.connectedAt ?? null,
        date: utcDateOf(summary.connectedAt),
        companyId: summary.companyId || 'univrse',
      });
      byUri.set(uri, entry);
      byVertexId.set(vertexDocumentId(uri), entry);
    }
  return Object.freeze({ byUri, byVertexId });
}
export const emptySnapshot = activeSnapshot([], '');

// The URI with each path segment percent-decoded, or null when a segment does
// not decode or decodes to a "/" (an encoded slash never joins two segments).
function decodedUri(uri) {
  const segments = [];
  for (const segment of uri.split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes('/')) return null;
    segments.push(decoded);
  }
  return segments.join('/');
}

// The active entry a passage belongs to, or null.
export function entryForPassage(passage, snapshot) {
  const uri = typeof passage?.uri === 'string' ? passage.uri : '';
  if (uri) {
    const exact = snapshot.byUri.get(uri);
    if (exact) return exact;
    const decoded = decodedUri(uri);
    if (decoded && snapshot.byUri.has(decoded)) return snapshot.byUri.get(decoded);
  }
  const vertexId = typeof passage?.vertexId === 'string' ? passage.vertexId : '';
  return (vertexId && snapshot.byVertexId.get(vertexId)) || null;
}

// The admitted passages, in rank order and at most `limit`, and how many were
// dropped for not matching an active entry (every unmatched passage counts,
// also those after the limit). Admitted passages lose uri and vertexId and
// gain the entry's documentId and date: { title, heading, text, excerpt,
// documentId, date: 'YYYY-MM-DD' | null, dateKind: 'uploaded' | null }. date
// is the UTC day the entry's version was uploaded (connectedAt). title stays
// the passage's file name.
export function screenPassages(
  passages,
  snapshot,
  { limit = ADMITTED_LIMIT, companyId = null } = {},
) {
  const admitted = [];
  let dropped = 0;
  for (const passage of Array.isArray(passages) ? passages : []) {
    if (passage?.title === profileSourceTitle) {
      if (admitted.length < limit) {
        admitted.push({
          title: passage.title,
          heading: passage.heading || '',
          text: passage.text,
          excerpt:
            typeof passage.excerpt === 'string' ? passage.excerpt : String(passage.text ?? ''),
          documentId: null,
          date: null,
          dateKind: null,
        });
      }
      continue;
    }
    const entry = entryForPassage(passage, snapshot);
    if (!entry) {
      dropped++;
      continue;
    }
    if (companyId && entry.companyId && entry.companyId !== companyId) {
      dropped++;
      continue;
    }
    if (admitted.length >= limit) continue;
    admitted.push({
      title: passage.title,
      heading: passage.heading || '',
      text: passage.text,
      excerpt: typeof passage.excerpt === 'string' ? passage.excerpt : String(passage.text ?? ''),
      documentId: entry.id,
      date: entry.date,
      dateKind: entry.date ? 'uploaded' : null,
    });
  }
  return { admitted, dropped };
}
export const admitPassages = (passages, snapshot, options) =>
  screenPassages(passages, snapshot, options).admitted;

// Firestore failures reach the browser as the library's own fixed errors.
const libraryError = (error) =>
  error instanceof ChatError &&
  ['COMPANY_KNOWLEDGE_UNAVAILABLE', 'COMPANY_KNOWLEDGE_TIMEOUT'].includes(error.code)
    ? error
    : companyDocumentErrors.unavailable();

// { snapshot(), invalidate(), admit(passages, snapshot) }
//   snapshot()  the cached snapshot, or a fresh one once it is ttlMs old.
//               Concurrent calls share one Firestore read. If the read fails,
//               the last good snapshot is used while it is younger than
//               staleMs (one stale_snapshot line); otherwise it rejects with
//               503 COMPANY_KNOWLEDGE_UNAVAILABLE or 504 COMPANY_KNOWLEDGE_TIMEOUT
//               (one unavailable line). Without a bucket nothing can match:
//               the snapshot is empty and Firestore is not read.
//   invalidate() drops the cache (and any read already running), so the next
//               snapshot() reads Firestore. A change can never fall back to
//               the snapshot from before it.
//   admit()     admitPassages, plus one dropped line when any passage was dropped.
export function createActiveDocuments({
  // createCompanyDocumentStore(...): listSummaries() is used.
  documents,
  bucket,
  ttlMs = ACTIVE_DOCUMENTS_TTL_MS,
  staleMs = ACTIVE_DOCUMENTS_STALE_MS,
  // Milliseconds since 1970, or a Date.
  now = Date.now,
  // Receives each activeDocumentsLine object; stdout JSON by default.
  log = writeActiveDocumentsLine,
  // deploymentEnvironment(env): 'staging' | 'production' | 'local'.
  environment = 'local',
  limit = ADMITTED_LIMIT,
}) {
  const docsBucket = String(bucket ?? '').trim();
  const clock = () => Number(now());
  const line = (result, dropped) => {
    try {
      log(activeDocumentsLine({ environment, result, dropped }));
    } catch {
      // A log line must never fail a chat turn.
    }
  };
  let cached = null; // { snapshot, takenAt }
  let loading = null; // { promise, generation }
  let generation = 0;

  async function load(started) {
    try {
      const fresh = activeSnapshot(await documents.listSummaries(), docsBucket);
      if (started === generation) cached = { snapshot: fresh, takenAt: clock() };
      return fresh;
    } catch (error) {
      const last = started === generation ? cached : null;
      if (last && clock() - last.takenAt < staleMs) {
        line('stale_snapshot');
        return last.snapshot;
      }
      line('unavailable');
      throw libraryError(error);
    }
  }

  async function snapshot() {
    if (!docsBucket) return emptySnapshot;
    if (cached && clock() - cached.takenAt < ttlMs) return cached.snapshot;
    if (!loading || loading.generation !== generation) {
      const started = generation;
      const promise = load(started).finally(() => {
        if (loading?.promise === promise) loading = null;
      });
      loading = { promise, generation: started };
    }
    return loading.promise;
  }

  return {
    snapshot,
    invalidate() {
      generation++;
      cached = null;
      loading = null;
    },
    admit(passages, current, options) {
      const { admitted, dropped } = screenPassages(passages, current, {
        limit,
        ...(options && typeof options === 'object' ? options : {}),
      });
      if (dropped) line('dropped', dropped);
      return admitted;
    },
  };
}
