import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_COMPANY_ID } from './companies.mjs';

// Shared names and URLs for the company documents in the documents bucket and
// the Vertex AI Search (Discovery Engine) data store. Pure functions only (the
// one list helper takes the caller's request function), so the api
// (company-documents.mjs), the scripts (docs:import, docs:reconcile) and the
// retrieval allowlist agree on every name. The server never imports scripts/.
//
//   object name   <Firestore id>/<file name>   (unsupported types get .txt, see gcsObjectName)
//   URI           gs://<DOCS_BUCKET>/<object name>
//   Vertex doc ID the first 32 hex characters of SHA-256 of that exact URI string
//                 (the rule documents:import applies with dataSchema 'content')

export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'html', 'htm', 'txt'];
export const extensionOf = (name) => path.extname(name).slice(1).toLowerCase();

// A Firestore companyDocuments ID (crypto.randomUUID): the HR namespace folder.
export const companyDocumentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The Firestore ID an object name belongs to, when it lies in the HR
// namespace (<uuid>/...), else null.
export function namespaceIdOf(objectName) {
  let name = String(objectName ?? '');
  if (name.startsWith('companies/')) {
    const parts = name.split('/');
    if (parts.length >= 3) {
      name = parts.slice(2).join('/');
    }
  }
  const slash = name.indexOf('/');
  if (slash < 0) return null;
  const folder = name.slice(0, slash);
  return companyDocumentIdPattern.test(folder) ? folder : null;
}

// The object name an uploaded file is stored under. Control characters and
// slashes become "-"; a type Vertex AI Search does not parse (.md, ...) is
// stored as UTF-8 .txt.
export function gcsObjectName(id, fileName, companyId = null) {
  const cleaned = String(fileName || '')
    .replace(/[\u0000-\u001f\u007f/\\]+/g, '-')
    .trim();
  const base = cleaned || 'document.txt';
  const ext = extensionOf(base);
  const indexedName = SUPPORTED_EXTENSIONS.includes(ext)
    ? base
    : base.replace(/\.[A-Za-z0-9]{1,8}$/, '') + '.txt';
  return companyId && companyId !== DEFAULT_COMPANY_ID && companyId !== 'univrse'
    ? `companies/${companyId}/${id}/${indexedName}`
    : `${id}/${indexedName}`;
}

export const companyDocumentUri = ({ bucket, id, fileName, companyId = null }) =>
  `gs://${bucket}/${gcsObjectName(id, fileName, companyId)}`;

export const vertexDocumentId = (uri) =>
  createHash('sha256').update(String(uri), 'utf8').digest('hex').slice(0, 32);

// --- Discovery Engine ---------------------------------------------------------

const COLLECTION = 'default_collection';
const BRANCH = 'default_branch';
export const DOCUMENTS_PAGE_SIZE = 1000;

export const discoveryEngineHost = (location = 'global') =>
  !location || location === 'global'
    ? 'discoveryengine.googleapis.com'
    : `${location}-discoveryengine.googleapis.com`;

// { project, location = 'global', dataStore }
export const dataStoreDocumentsUrl = ({ project, location = 'global', dataStore }) =>
  `https://${discoveryEngineHost(location)}/v1/projects/${encodeURIComponent(project)}` +
  `/locations/${encodeURIComponent(location || 'global')}/collections/${COLLECTION}` +
  `/dataStores/${encodeURIComponent(dataStore)}/branches/${BRANCH}/documents`;

export const importUrl = (config) => `${dataStoreDocumentsUrl(config)}:import`;

export const dataStoreDocumentUrl = (config, vertexId) =>
  `${dataStoreDocumentsUrl(config)}/${encodeURIComponent(vertexId)}`;

export function documentsListUrl(config, { pageSize = DOCUMENTS_PAGE_SIZE, pageToken = '' } = {}) {
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) query.set('pageToken', pageToken);
  return `${dataStoreDocumentsUrl(config)}?${query}`;
}

// A long-running operation name (projects/.../operations/...) as a GET URL.
export const discoveryEngineOperationUrl = (location, name) =>
  `https://${discoveryEngineHost(location)}/v1/${String(name).replace(/^\/+/, '')}`;

// The documents:import body for explicit URIs only: never a wildcard or a
// prefix, never FULL.
export function explicitImportBody(uris) {
  const list = [...uris];
  if (!list.length || list.length > 100) throw new Error('An import takes 1 to 100 URIs.');
  for (const uri of list)
    if (!/^gs:\/\/[^/]+\/.+/.test(uri) || uri.includes('*') || uri.endsWith('/'))
      throw new Error('An import takes explicit gs:// object URIs only.');
  return {
    gcsSource: { inputUris: list, dataSchema: 'content' },
    reconciliationMode: 'INCREMENTAL',
  };
}

// A data store document as the list returns it: { id, uri, indexTime }.
export function documentSummary(document) {
  const id =
    (typeof document?.id === 'string' && document.id) ||
    String(document?.name || '')
      .split('/')
      .pop() ||
    null;
  return {
    id,
    uri: typeof document?.content?.uri === 'string' ? document.content.uri : null,
    indexTime: typeof document?.indexTime === 'string' ? document.indexTime : null,
  };
}

export class DocumentListError extends Error {
  constructor(status) {
    super(`documents.list failed${status ? ` with HTTP ${status}` : ''}`);
    this.name = 'DocumentListError';
    this.status = status ?? null;
  }
}

// Every document in the data store, following nextPageToken. request(url)
// resolves to a fetch Response (the caller adds auth, deadlines and logging)
// and may throw. A non-2xx page or an unreadable body throws DocumentListError
// with the HTTP status; nothing is swallowed.
export async function listDataStoreDocuments({
  request,
  config,
  pageSize = DOCUMENTS_PAGE_SIZE,
  maxPages = 1000,
}) {
  const documents = [];
  const seen = new Set();
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const response = await request(documentsListUrl(config, { pageSize, pageToken }));
    if (!response.ok) throw new DocumentListError(response.status);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new DocumentListError(response.status);
    }
    for (const document of Array.isArray(data?.documents) ? data.documents : [])
      documents.push(documentSummary(document));
    pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!pageToken) return documents;
    if (seen.has(pageToken)) throw new DocumentListError(response.status);
    seen.add(pageToken);
  }
  throw new DocumentListError(null);
}

// --- Cloud Storage JSON API -----------------------------------------------------

const STORAGE = 'https://storage.googleapis.com';

export const gcsUploadUrl = (bucket, objectName) =>
  `${STORAGE}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

export const gcsObjectUrl = (bucket, objectName) =>
  `${STORAGE}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;

// Live objects only (no versions=true): name and creation time.
export function gcsListUrl(bucket, { pageToken = '' } = {}) {
  const query = new URLSearchParams({ fields: 'items(name,timeCreated),nextPageToken' });
  if (pageToken) query.set('pageToken', pageToken);
  return `${STORAGE}/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`;
}
