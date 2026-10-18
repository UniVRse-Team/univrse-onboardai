// npm run docs:reconcile -- [--apply] [--max-deletes <n>] [--allow-empty-library]
//   [--grace-minutes <n>] [--skip-gcs] [--show-names] [--timeout-minutes <n>] [--help]
//
// Compares the three copies of the company library and reports (default) or
// repairs (--apply) the drift between them:
//   Firestore companyDocuments (what HR published: the truth, never written here)
//   the live objects in DOCS_BUCKET, and the documents in the Vertex AI Search data store.
// Output is JSON lines on stdout: one per item, then exactly one summary line,
// always last. IDs only: no file names, titles, URIs, bucket names or text,
// unless an operator passes --show-names. See docs/document-reconciliation.md.
//
// Report mode is read-only by construction: its HTTP layer (readOnlyFetch)
// lets through GET requests to the three Google APIs and the Firestore
// documents:runQuery POST, and throws for anything else before it is sent.
import { pathToFileURL } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import {
  companyDocumentCollection,
  companyDocumentSummary,
  companyDocumentSummaryFields,
  deploymentEnvironment,
} from '../server/company-documents.mjs';
import {
  companyDocumentUri,
  dataStoreDocumentUrl,
  discoveryEngineOperationUrl,
  explicitImportBody,
  gcsListUrl,
  gcsObjectName,
  gcsObjectUrl,
  importUrl,
  listDataStoreDocuments,
  namespaceIdOf,
  vertexDocumentId,
} from '../server/discovery-engine-documents.mjs';
import { VERTEX_SCOPE } from '../server/vertex-ai.mjs';

export const DEFAULT_OPTIONS = Object.freeze({
  apply: false,
  maxDeletes: 10,
  allowEmptyLibrary: false,
  graceMinutes: 15,
  skipGcs: false,
  showNames: false,
  timeoutMinutes: 10,
  help: false,
});
// One request's own limit, inside the overall --timeout-minutes deadline.
export const REQUEST_TIMEOUT_MS = 60_000;
export const IMPORT_POLL_INTERVAL_MS = 5_000;
export const IMPORT_POLL_LIMIT_MS = 10 * 60_000;
export const IMPORT_BATCH = 100;

export const USAGE = `Usage: npm run docs:reconcile -- [options]

Compares Firestore companyDocuments (the truth), the live objects in DOCS_BUCKET and the
Vertex AI Search data store, and prints one JSON line per drift item and one summary line.
Without --apply nothing is changed (report mode, read only).

Options:
  --apply                Delete Vertex orphans and duplicates and HR-namespace GCS orphans,
                         and re-import missing documents (default: report only)
  --max-deletes <n>      Stop (exit 3, nothing changed) above n planned deletes (default 10)
  --allow-empty-library  Allow deletes when Firestore holds no entry at all (default: exit 3)
  --grace-minutes <n>    Entries, objects and documents younger than this are pending (15)
  --skip-gcs             Report GCS orphans (result "skipped"), never delete them
  --show-names           Operator only: add the object name to item lines
  --timeout-minutes <n>  Overall deadline; unfinished actions count as failed (default 10)
  --help                 Show this text

Environment (required): ONBOARDAI_ENVIRONMENT (staging | production), GOOGLE_CLOUD_PROJECT,
  FIRESTORE_DATABASE_ID, DOCS_BUCKET, VERTEX_SEARCH_DATA_STORE_ID
Environment (optional): FIRESTORE_PROJECT_ID (default GOOGLE_CLOUD_PROJECT),
  VERTEX_SEARCH_LOCATION (default global)
Credentials: Application Default Credentials. .env is not read.

Exit codes: 0 completed, 1 apply: an action failed, 2 usage or configuration error,
3 safety stop (nothing changed), 4 a source could not be read (nothing changed).`;

export class UsageError extends Error {
  constructor(message, reason = 'usage') {
    super(message);
    this.reason = reason;
  }
}

const COUNT = /^\d+$/;
// A value echoed in a usage message: short, with no control characters.
const shown = (value) =>
  String(value)
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 40);
const limits = {
  '--max-deletes': ['maxDeletes', 0, 10000],
  '--grace-minutes': ['graceMinutes', 0, 10080],
  '--timeout-minutes': ['timeoutMinutes', 1, 1440],
};
const switches = {
  '--apply': 'apply',
  '--allow-empty-library': 'allowEmptyLibrary',
  '--skip-gcs': 'skipGcs',
  '--show-names': 'showNames',
  '--help': 'help',
  '-h': 'help',
};

export function parseArgs(argv = []) {
  const options = { ...DEFAULT_OPTIONS };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg];
    if (switches[flag] && inline === undefined) options[switches[flag]] = true;
    else if (limits[flag]) {
      const [key, min, max] = limits[flag];
      const value = inline ?? argv[++i];
      if (value === undefined)
        throw new UsageError(
          `Bad value for ${flag}: it needs a whole number from ${min} to ${max}`,
        );
      if (!COUNT.test(value))
        throw new UsageError(
          `Bad value for ${flag}: "${shown(value)}" is not a whole number from ${min} to ${max}`,
        );
      const number = Number(value);
      if (number < min || number > max)
        throw new UsageError(
          `Bad value for ${flag}: ${shown(value)} is out of range (${min} to ${max})`,
        );
      options[key] = number;
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option ${flag}`);
    else throw new UsageError(`Unexpected argument "${arg}"`);
  }
  return options;
}

const PROJECT = /^([a-z][a-z0-9-]{4,28}[a-z0-9]|\d{6,20})$/;
const DATABASE = /^(\(default\)|[a-z][a-z0-9-]{2,62})$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const DATA_STORE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LOCATION = /^[a-z0-9-]+$/;

// The run's settings from the environment, or a UsageError (reason 'usage',
// or 'env_mismatch' when the names do not belong to ONBOARDAI_ENVIRONMENT).
// Messages name variables, never their values.
export function readConfig(env = {}) {
  const value = (name) => String(env[name] ?? '').trim();
  const environment = value('ONBOARDAI_ENVIRONMENT');
  if (environment !== 'staging' && environment !== 'production')
    throw new UsageError('ONBOARDAI_ENVIRONMENT must be staging or production');
  const config = {
    environment,
    project: value('GOOGLE_CLOUD_PROJECT'),
    firestoreProject: value('FIRESTORE_PROJECT_ID') || value('GOOGLE_CLOUD_PROJECT'),
    database: value('FIRESTORE_DATABASE_ID'),
    bucket: value('DOCS_BUCKET'),
    dataStore: value('VERTEX_SEARCH_DATA_STORE_ID'),
    location: value('VERTEX_SEARCH_LOCATION') || 'global',
  };
  for (const [name, key, pattern] of [
    ['GOOGLE_CLOUD_PROJECT', 'project', PROJECT],
    ['FIRESTORE_PROJECT_ID', 'firestoreProject', PROJECT],
    ['FIRESTORE_DATABASE_ID', 'database', DATABASE],
    ['DOCS_BUCKET', 'bucket', BUCKET],
    ['VERTEX_SEARCH_DATA_STORE_ID', 'dataStore', DATA_STORE],
    ['VERTEX_SEARCH_LOCATION', 'location', LOCATION],
  ]) {
    if (!config[key]) throw new UsageError(`${name} is required`);
    if (!pattern.test(config[key])) throw new UsageError(`${name} is not a valid name`);
  }
  const named = [
    ['FIRESTORE_DATABASE_ID', config.database],
    ['DOCS_BUCKET', config.bucket],
    ['VERTEX_SEARCH_DATA_STORE_ID', config.dataStore],
  ];
  for (const [name, setting] of named) {
    const staging = setting.endsWith('-staging');
    if (environment === 'staging' && !staging)
      throw new UsageError(
        `${name} must end in -staging when ONBOARDAI_ENVIRONMENT=staging`,
        'env_mismatch',
      );
    if (environment === 'production' && staging)
      throw new UsageError(
        `${name} must not end in -staging when ONBOARDAI_ENVIRONMENT=production`,
        'env_mismatch',
      );
  }
  return config;
}

// --- HTTP ----------------------------------------------------------------------

const GOOGLE_HOSTS =
  /^https:\/\/(firestore|storage|([a-z0-9-]+-)?discoveryengine)\.googleapis\.com\//;
export const FIRESTORE_RUN_QUERY =
  /^https:\/\/firestore\.googleapis\.com\/v1\/projects\/[^/?#]+\/databases\/[^/?#]+\/documents:runQuery$/;

export class ReadOnlyViolation extends Error {
  constructor(method) {
    super(`Report mode is read only: a ${method} request was refused before it was sent.`);
    this.name = 'ReadOnlyViolation';
  }
}

// Report mode's transport: GET to the Google APIs this job reads, and the
// Firestore runQuery POST. Anything else throws before fetchImpl is called.
export function readOnlyFetch(fetchImpl) {
  return async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const target = String(url);
    const allowed =
      (method === 'GET' && GOOGLE_HOSTS.test(target)) ||
      (method === 'POST' && FIRESTORE_RUN_QUERY.test(target));
    if (!allowed) throw new ReadOnlyViolation(method);
    return fetchImpl(url, init);
  };
}

const firestoreBase = ({ firestoreProject, database }) =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firestoreProject)}` +
  `/databases/${encodeURIComponent(database)}/documents`;
export const firestoreRunQueryUrl = (config) => `${firestoreBase(config)}:runQuery`;
export const firestoreDocumentUrl = (config, id) =>
  `${firestoreBase(config)}/${companyDocumentCollection}/${encodeURIComponent(id)}` +
  '?mask.fieldPaths=status&mask.fieldPaths=fileName&mask.fieldPaths=companyId';

// The select-only query: the summary fields, never the legacy `text`.
export const summaryQuery = () => ({
  structuredQuery: {
    from: [{ collectionId: companyDocumentCollection }],
    select: { fields: companyDocumentSummaryFields.map((fieldPath) => ({ fieldPath })) },
  },
});

function firestoreValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  return undefined;
}
export function decodeFirestoreDocument(document) {
  const data = {};
  for (const [key, value] of Object.entries(document?.fields ?? {})) {
    const decoded = firestoreValue(value);
    if (decoded !== undefined) data[key] = decoded;
  }
  const id = String(document?.name ?? '')
    .split('/')
    .pop();
  return { id, data };
}

export class SourceError extends Error {
  constructor(source, status = null) {
    super(`Could not read ${source}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
  }
}

// http(method, url, body?) with auth headers, the request limit and the
// overall deadline. Discovery Engine calls carry x-goog-user-project (as the
// api's do); other quota headers come from the credentials themselves.
function createHttp({ fetchImpl, getAuthHeaders, config, deadlineAt, now }) {
  return async (method, url, body) => {
    const headers = new Headers(await getAuthHeaders(url));
    if (/discoveryengine\.googleapis\.com\//.test(url) && !headers.has('x-goog-user-project'))
      headers.set('x-goog-user-project', config.project);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const remaining = Math.max(1, deadlineAt - now());
    return fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    });
  };
}

// --- Reads -----------------------------------------------------------------------

// (1) Vertex documents, (2) live GCS objects, (3) Firestore summaries, in that
// order: an entry is always written before its object and document, so an
// upload in flight is never mistaken for an orphan.
export async function readSources(http, config, counts = {}) {
  const fail = (source) => (error) => {
    if (error instanceof SourceError) throw error;
    throw new SourceError(source, error?.status ?? null);
  };
  const vertex = await listDataStoreDocuments({
    config,
    request: (url) => http('GET', url),
  }).catch(fail('vertex'));
  counts.vertex = vertex.length;

  const gcs = [];
  try {
    let pageToken = '';
    const seen = new Set();
    do {
      const response = await http('GET', gcsListUrl(config.bucket, { pageToken }));
      if (!response.ok) throw new SourceError('gcs', response.status);
      const data = await response.json();
      for (const item of Array.isArray(data?.items) ? data.items : [])
        if (typeof item?.name === 'string')
          gcs.push({ name: item.name, timeCreated: item.timeCreated ?? null });
      pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : '';
      if (seen.has(pageToken)) throw new SourceError('gcs', response.status);
      seen.add(pageToken);
    } while (pageToken);
  } catch (error) {
    fail('gcs')(error);
  }
  counts.gcsLive = gcs.length;

  let firestore;
  try {
    const response = await http('POST', firestoreRunQueryUrl(config), summaryQuery());
    if (!response.ok) throw new SourceError('firestore', response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new SourceError('firestore', response.status);
    firestore = rows
      .filter((row) => row?.document)
      .map((row) => {
        const { id, data } = decodeFirestoreDocument(row.document);
        return companyDocumentSummary(id, data);
      });
  } catch (error) {
    fail('firestore')(error);
  }
  counts.firestore = firestore.length;
  return { vertex, gcs, firestore };
}

// --- Plan ------------------------------------------------------------------------

export const ITEM_KINDS = Object.freeze([
  'vertex_orphan',
  'vertex_duplicate',
  'gcs_orphan',
  'missing_index',
  'missing_object',
  'retired_entry',
  'pending',
  'unmanaged',
]);
const actionOf = {
  vertex_orphan: 'delete_vertex',
  vertex_duplicate: 'delete_vertex',
  gcs_orphan: 'delete_gcs',
  missing_index: 'reimport',
};
const countKey = {
  vertex_orphan: 'vertexOrphans',
  vertex_duplicate: 'vertexDuplicates',
  gcs_orphan: 'gcsOrphans',
  missing_index: 'missingIndex',
  missing_object: 'missingObject',
  retired_entry: 'retiredEntries',
  pending: 'pending',
  unmanaged: 'unmanaged',
};
const notDrift = new Set(['unmanaged', 'pending']);

// The pure plan from the three reads.
//   firestore: [companyDocumentSummary]   gcs: [{ name, timeCreated }]
//   vertex: [{ id, uri, indexTime }]      now: ms since epoch
//   options: { bucket, graceMinutes, maxDeletes, allowEmptyLibrary, skipGcs }
// Returns { items, counts, plannedDeletes, stop: null | 'empty_library' | 'max_deletes' }.
// Each item: { kind, action, firestoreId, vertexId, name, uri }; name and uri
// never reach a log line without --show-names (and uri never does).
export function planReconciliation({ firestore = [], gcs = [], vertex = [], options, now }) {
  const { bucket } = options;
  const graceMs = (options.graceMinutes ?? DEFAULT_OPTIONS.graceMinutes) * 60_000;
  const young = (iso) => {
    const at = Date.parse(iso ?? '');
    return Number.isFinite(at) && now - at < graceMs;
  };
  const byId = new Map(firestore.map((entry) => [entry.id, entry]));
  const entryYoung = (entry) =>
    young(entry.status === 'retired' ? (entry.retiredAt ?? entry.connectedAt) : entry.connectedAt);
  const expected = new Map();
  for (const entry of firestore)
    if (entry.status === 'active' && entry.fileName)
      expected.set(
        companyDocumentUri({
          bucket,
          id: entry.id,
          fileName: entry.fileName,
          companyId: entry.companyId,
        }),
        entry,
      );
  const live = new Map(gcs.map((object) => [object.name, object]));
  const bucketPrefix = `gs://${bucket}/`;
  const objectOf = (uri) =>
    typeof uri === 'string' && uri.startsWith(bucketPrefix) ? uri.slice(bucketPrefix.length) : null;
  const vertexByUri = new Map();
  for (const document of vertex) {
    const key = document.uri ?? `\u0000${document.id}`;
    if (!vertexByUri.has(key)) vertexByUri.set(key, []);
    vertexByUri.get(key).push(document);
  }

  const items = [];
  const add = (kind, { firestoreId = null, vertexId = null, name = null, uri = null } = {}) =>
    items.push({ kind, action: actionOf[kind] ?? 'none', firestoreId, vertexId, name, uri });

  // (1) Vertex documents.
  for (const [key, documents] of vertexByUri) {
    const uri = key.startsWith('\u0000') ? null : key;
    const objectName = objectOf(uri);
    const name = objectName ?? uri;
    const entry = uri ? expected.get(uri) : null;
    if (entry) {
      const canonical = vertexDocumentId(uri);
      const keep =
        documents.find((document) => document.id === canonical) ??
        [...documents].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      for (const document of documents) {
        const ref = { firestoreId: entry.id, vertexId: document.id, name, uri };
        if (document === keep) {
          if (!document.indexTime) add('pending', ref);
        } else if (!document.indexTime || young(document.indexTime)) add('pending', ref);
        else add('vertex_duplicate', ref);
      }
      continue;
    }
    const namespaceId = objectName ? namespaceIdOf(objectName) : null;
    // A live object outside the HR namespace: one unmanaged item, from the GCS pass.
    if (objectName && !namespaceId && live.has(objectName)) continue;
    const owner = namespaceId ? byId.get(namespaceId) : null;
    for (const document of documents) {
      const ref = { firestoreId: namespaceId, vertexId: document.id, name, uri };
      if (!document.indexTime || young(document.indexTime) || (owner && entryYoung(owner)))
        add('pending', ref);
      else add('vertex_orphan', ref);
    }
  }

  // (2) Live GCS objects.
  for (const object of gcs) {
    const uri = `${bucketPrefix}${object.name}`;
    const namespaceId = namespaceIdOf(object.name);
    if (!namespaceId) {
      add('unmanaged', { vertexId: vertexByUri.get(uri)?.[0]?.id ?? null, name: object.name, uri });
      continue;
    }
    const entry = byId.get(namespaceId);
    if (
      entry?.status === 'active' &&
      entry.fileName &&
      gcsObjectName(entry.id, entry.fileName, entry.companyId) === object.name
    )
      continue;
    const ref = { firestoreId: namespaceId, name: object.name, uri };
    if (young(object.timeCreated) || (entry && entryYoung(entry))) add('pending', ref);
    else add('gcs_orphan', ref);
  }

  // (3) Firestore entries. Entries without a file name (Google Docs entries
  // from before #35) have no object: counted, no item.
  for (const entry of firestore) {
    const ref = { firestoreId: entry.id };
    if (entry.status === 'retired') {
      add(entryYoung(entry) ? 'pending' : 'retired_entry', ref);
      continue;
    }
    if (!entry.fileName) continue;
    const objectName = gcsObjectName(entry.id, entry.fileName, entry.companyId);
    const uri = `${bucketPrefix}${objectName}`;
    Object.assign(ref, { name: objectName, uri });
    if (!live.has(objectName)) add(entryYoung(entry) ? 'pending' : 'missing_object', ref);
    else if (!vertexByUri.has(uri)) add(entryYoung(entry) ? 'pending' : 'missing_index', ref);
  }

  const counts = Object.fromEntries(Object.values(countKey).map((key) => [key, 0]));
  for (const item of items) counts[countKey[item.kind]]++;
  const plannedDeletes =
    counts.vertexOrphans + counts.vertexDuplicates + (options.skipGcs ? 0 : counts.gcsOrphans);
  let stop = null;
  if (!firestore.length && plannedDeletes >= 1 && !options.allowEmptyLibrary)
    stop = 'empty_library';
  else if (plannedDeletes > (options.maxDeletes ?? DEFAULT_OPTIONS.maxDeletes))
    stop = 'max_deletes';
  return { items, counts, plannedDeletes, stop };
}

// --- Apply -----------------------------------------------------------------------

function operationOutcome(operation) {
  const failures = Number(operation?.metadata?.failureCount ?? 0) || 0;
  return { done: operation?.done === true, failed: Boolean(operation?.error) || failures > 0 };
}

// Runs the actionable items of a plan (apply mode, no safety stop), in order:
// Vertex deletes, GCS deletes, then re-imports in batches of up to 100 URIs.
// Sets item.result ('done' | 'failed' | 'skipped') and item.status (the HTTP
// status of a failed action). A <uuid>/ orphan is re-checked in Firestore
// first and skipped if that entry now expects it.
export async function executePlan({
  items,
  http,
  config,
  options,
  deadlineAt,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const outOfTime = () => now() >= deadlineAt;
  const failed = (item, status = null) => Object.assign(item, { result: 'failed', status });
  const done = (item) => Object.assign(item, { result: 'done', status: null });
  const gone = (response) => response.ok || response.status === 404;

  // true when the entry still does not expect this object (absent, retired,
  // or expecting another name); false when it does; a number is a failed read.
  async function stillOrphan(item) {
    if (!item.firestoreId) return true;
    const response = await http('GET', firestoreDocumentUrl(config, item.firestoreId));
    if (response.status === 404) return true;
    if (!response.ok) return response.status;
    const { data } = decodeFirestoreDocument(await response.json());
    if (data.status === 'retired' || !data.fileName) return true;
    return gcsObjectName(item.firestoreId, data.fileName, data.companyId) !== item.name;
  }

  async function remove(item, url) {
    if (outOfTime()) return failed(item);
    try {
      if (item.kind !== 'vertex_duplicate') {
        const orphan = await stillOrphan(item);
        if (typeof orphan === 'number') return failed(item, orphan);
        if (!orphan) return Object.assign(item, { result: 'skipped', status: null });
      }
      const response = await http('DELETE', url);
      return gone(response) ? done(item) : failed(item, response.status);
    } catch {
      return failed(item);
    }
  }

  for (const item of items.filter((i) => i.action === 'delete_vertex'))
    await remove(item, dataStoreDocumentUrl(config, item.vertexId));
  for (const item of items.filter((i) => i.action === 'delete_gcs')) {
    if (options.skipGcs) continue;
    await remove(item, gcsObjectUrl(config.bucket, item.name));
  }

  const reimports = items.filter((i) => i.action === 'reimport');
  for (let start = 0; start < reimports.length; start += IMPORT_BATCH) {
    const batch = reimports.slice(start, start + IMPORT_BATCH);
    if (outOfTime()) {
      batch.forEach((item) => failed(item));
      continue;
    }
    try {
      const response = await http(
        'POST',
        importUrl(config),
        explicitImportBody(batch.map((item) => item.uri)),
      );
      if (!response.ok) {
        batch.forEach((item) => failed(item, response.status));
        continue;
      }
      let operation = await response.json();
      const until = Math.min(deadlineAt, now() + IMPORT_POLL_LIMIT_MS);
      for (
        let polls = 0;
        !operationOutcome(operation).done &&
        now() < until &&
        polls < IMPORT_POLL_LIMIT_MS / IMPORT_POLL_INTERVAL_MS;
        polls++
      ) {
        await sleep(IMPORT_POLL_INTERVAL_MS);
        const polled = await http(
          'GET',
          discoveryEngineOperationUrl(config.location, operation.name),
        );
        if (!polled.ok) break;
        operation = await polled.json();
      }
      const outcome = operationOutcome(operation);
      batch.forEach((item) => (outcome.done && !outcome.failed ? done(item) : failed(item)));
    } catch {
      batch.forEach((item) => failed(item));
    }
  }
}

// --- Log lines -----------------------------------------------------------------------

export function itemLine(item, { environment, mode, showNames = false }) {
  const severity =
    item.result === 'failed'
      ? 'ERROR'
      : !notDrift.has(item.kind) && item.result !== 'done'
        ? 'WARNING'
        : 'INFO';
  return {
    severity,
    event: 'onboardai_docs_reconcile_item',
    environment,
    mode,
    kind: item.kind,
    action: item.action,
    result: item.result,
    firestoreId: item.firestoreId ?? null,
    vertexId: item.vertexId ?? null,
    status: Number.isInteger(item.status) ? item.status : null,
    ...(showNames ? { name: item.name ?? null } : {}),
  };
}

export const SUMMARY_COUNTS = Object.freeze([
  'firestore',
  'gcsLive',
  'vertex',
  'unmanaged',
  'vertexOrphans',
  'vertexDuplicates',
  'gcsOrphans',
  'missingIndex',
  'missingObject',
  'retiredEntries',
  'pending',
  'deletedVertex',
  'deletedGcs',
  'reimported',
  'failed',
  'unrepaired',
]);

export function summaryLine({
  environment,
  mode,
  exitCode,
  reason = null,
  counts = {},
  durationMs,
}) {
  const line = {
    severity: 'INFO',
    event: 'onboardai_docs_reconcile',
    environment,
    mode,
    exitCode,
    reason,
  };
  for (const key of SUMMARY_COUNTS) line[key] = Number.isInteger(counts[key]) ? counts[key] : 0;
  line.durationMs = Math.max(0, Math.round(durationMs || 0));
  line.severity = exitCode !== 0 ? 'ERROR' : line.unrepaired > 0 ? 'WARNING' : 'INFO';
  return line;
}

// --- Run ---------------------------------------------------------------------------

export function googleAuthHeaders() {
  const auth = new GoogleAuth({ scopes: [VERTEX_SCOPE] });
  return (url) => auth.getRequestHeaders(url);
}

// The whole job. Returns the exit code; every JSON line goes to write().
export async function run({
  argv = [],
  env = {},
  fetchImpl = fetch,
  getAuthHeaders = null,
  now = Date.now,
  write = (line) => console.log(line),
  writeError = (text) => console.error(text),
  sleep,
} = {}) {
  const started = now();
  const environment = deploymentEnvironment(env);
  let mode = 'report';
  const counts = {};
  const finish = (exitCode, reason = null) => {
    write(
      JSON.stringify(
        summaryLine({ environment, mode, exitCode, reason, counts, durationMs: now() - started }),
      ),
    );
    return exitCode;
  };

  let options, config;
  try {
    options = parseArgs(argv);
    mode = options.apply ? 'apply' : 'report';
    if (options.help) {
      write(USAGE);
      return 0;
    }
    config = readConfig(env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    writeError(`${error.message}\n\n${USAGE}`);
    return finish(2, error.reason);
  }

  const deadlineAt = started + options.timeoutMinutes * 60_000;
  const transport = options.apply ? fetchImpl : readOnlyFetch(fetchImpl);
  const http = createHttp({
    fetchImpl: transport,
    getAuthHeaders: getAuthHeaders ?? googleAuthHeaders(),
    config,
    deadlineAt,
    now,
  });

  let sources;
  try {
    sources = await readSources(http, config, counts);
  } catch (error) {
    writeError(
      error instanceof SourceError
        ? `${error.message}. Nothing was changed.`
        : 'A source could not be read. Nothing was changed.',
    );
    return finish(4, now() >= deadlineAt ? 'timeout' : 'source_unreadable');
  }

  const plan = planReconciliation({ ...sources, options: { ...options, ...config }, now: now() });
  Object.assign(counts, plan.counts);
  for (const item of plan.items) {
    item.status = null;
    if (!item.action || item.action === 'none') item.result = 'reported';
    else if (item.action === 'delete_gcs' && options.skipGcs) item.result = 'skipped';
    else item.result = options.apply ? (plan.stop ? 'skipped' : null) : 'planned';
  }

  let exitCode = 0;
  let reason = null;
  if (plan.stop) {
    exitCode = 3;
    reason = plan.stop;
  } else if (options.apply) {
    try {
      await executePlan({ items: plan.items, http, config, options, deadlineAt, now, sleep });
    } catch {
      // executePlan settles each item itself; anything left is a failure below.
    }
    for (const item of plan.items) if (item.result === null) item.result = 'failed';
    const failedItems = plan.items.filter((item) => item.result === 'failed').length;
    if (failedItems) {
      exitCode = 1;
      reason = now() >= deadlineAt ? 'timeout' : 'actions_failed';
    }
  }

  const result = (kind, value) =>
    plan.items.filter((item) => item.action === kind && item.result === value);
  counts.deletedVertex = result('delete_vertex', 'done').length;
  counts.deletedGcs = result('delete_gcs', 'done').length;
  counts.reimported = result('reimport', 'done').length;
  counts.failed = plan.items.filter((item) => item.result === 'failed').length;
  counts.unrepaired = plan.items.filter(
    (item) => !notDrift.has(item.kind) && item.result !== 'done',
  ).length;
  for (const item of plan.items)
    write(JSON.stringify(itemLine(item, { environment, mode, showNames: options.showNames })));
  return finish(exitCode, reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
}
