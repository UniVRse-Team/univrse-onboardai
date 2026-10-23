import { createAccessTokenProvider } from './vertex-ai.mjs';
import { DEFAULT_COMPANY_ID } from './companies.mjs';

// Company passages come from Vertex AI Search (Discovery Engine) chunk search over
// the documents imported into the data store. REST only; no extra client library.
export const SEARCH_TIMEOUT_MS = 15000;
export const SEARCH_PAGE_SIZE = 5;
// The most results one search may ask for (the allowlisted path asks for 10).
const MAX_PAGE_SIZE = 50;
// One chunk either side keeps conditions and exceptions that straddle a chunk boundary.
const NEIGHBOUR_CHUNKS = 1;
// Layout chunks are about 500 tokens; this only bounds unexpected oversized chunks.
const MAX_CHUNK_CHARACTERS = 6000;

export function vertexSearchConfig(env) {
  const engine = (env.VERTEX_SEARCH_ENGINE_ID || '').trim();
  if (!engine) return null;
  return {
    project: (env.GOOGLE_CLOUD_PROJECT || '').trim(),
    location: (env.VERTEX_SEARCH_LOCATION || '').trim() || 'global',
    engine,
  };
}

// What is missing from a configured engine, or '' when the search can run.
export function searchConfigProblem(config) {
  if (!config?.project) return 'GOOGLE_CLOUD_PROJECT is not set';
  if (!/^[a-z0-9-]+$/.test(config.location || '')) return 'VERTEX_SEARCH_LOCATION is invalid';
  return '';
}

export function servingConfigName({ project, location, engine }) {
  return (
    `projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}` +
    `/collections/default_collection/engines/${encodeURIComponent(engine)}/servingConfigs/default_search`
  );
}

export function vertexSearchUrl(config) {
  const host =
    config.location === 'global'
      ? 'discoveryengine.googleapis.com'
      : `${config.location}-discoveryengine.googleapis.com`;
  return `https://${host}/v1/${servingConfigName(config)}:search`;
}

// pageSize: SEARCH_PAGE_SIZE unless the caller asks for another whole number
// of results (the retrieval allowlist asks for 10, see
// active-company-documents.mjs). options can also specify companyId and
// relevanceThreshold ('LOWEST' only; omitted otherwise).
export function searchRequestBody(query, options = {}) {
  const opts = typeof options === 'string' ? { companyId: options } : options || {};
  const { pageSize, companyId = null, relevanceThreshold = null } = opts;
  return {
    query,
    pageSize:
      Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE_SIZE
        ? pageSize
        : SEARCH_PAGE_SIZE,
    contentSearchSpec: {
      searchResultMode: 'CHUNKS',
      chunkSpec: { numPreviousChunks: NEIGHBOUR_CHUNKS, numNextChunks: NEIGHBOUR_CHUNKS },
    },
    ...(companyId ? { filter: `companyId: ANY("${companyId}")` } : {}),
    // Only 'LOWEST' is supported: the zero-result retry (see createVertexSearch).
    ...(relevanceThreshold === 'LOWEST' ? { relevanceThreshold: 'LOWEST' } : {}),
  };
}

const failures = {
  SEARCH_NOT_CONFIGURED: [
    503,
    'Company document search is not fully configured. The administrator should set GOOGLE_CLOUD_PROJECT, VERTEX_SEARCH_LOCATION and VERTEX_SEARCH_ENGINE_ID.',
  ],
  SEARCH_AUTH_REQUIRED: [
    503,
    'Company document search could not sign in to Google Cloud. The administrator should check the API service credentials.',
  ],
  SEARCH_ACCESS_DENIED: [
    503,
    'Company document search access was denied. The administrator should check that the API service account has the Discovery Engine Viewer role.',
  ],
  SEARCH_NOT_FOUND: [
    503,
    'The company document search engine was not found. The administrator should check VERTEX_SEARCH_ENGINE_ID and VERTEX_SEARCH_LOCATION.',
  ],
  SEARCH_REQUEST_REJECTED: [
    503,
    'Company document search rejected the request. The administrator should check the search engine and data store settings.',
  ],
  SEARCH_RATE_LIMIT: [
    429,
    'Company document search is temporarily at its quota limit. Please wait a moment and try again.',
  ],
  SEARCH_TIMEOUT: [504, 'Company document search took too long to respond. Please try again.'],
  SEARCH_UNAVAILABLE: [
    503,
    'Company documents could not be searched right now. Please try again shortly.',
  ],
};

export class CompanySearchError extends Error {
  constructor(code, { upstreamStatus = null, reason = null, upstreamMessage = null } = {}) {
    super((failures[code] || failures.SEARCH_UNAVAILABLE)[1]);
    this.name = 'CompanySearchError';
    this.code = failures[code] ? code : 'SEARCH_UNAVAILABLE';
    this.status = failures[this.code][0];
    // Diagnostics for operators (check script, server log). Never sent to the browser.
    this.upstreamStatus = upstreamStatus;
    this.reason = reason;
    this.upstreamMessage = upstreamMessage;
  }
}

// Only these fixed messages reach the browser; Google error bodies, tokens and
// queries are never forwarded.
export function searchFailure(error) {
  const code = error instanceof CompanySearchError ? error.code : 'SEARCH_UNAVAILABLE';
  const [status, message] = failures[code];
  return { status, code, error: message };
}

function codeForStatus(status) {
  if (status === 401) return 'SEARCH_AUTH_REQUIRED';
  if (status === 403) return 'SEARCH_ACCESS_DENIED';
  if (status === 404) return 'SEARCH_NOT_FOUND';
  if (status === 429) return 'SEARCH_RATE_LIMIT';
  if (status === 400 || status === 412) return 'SEARCH_REQUEST_REJECTED';
  return 'SEARCH_UNAVAILABLE';
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function lastPathSegment(value) {
  const path = text(value)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .split(/[?#]/)[0];
  const segment = path.split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// The file name shown to employees: the last part of the document URI (for
// example gs://bucket/handbooks/Employee%20Handbook.pdf -> Employee Handbook.pdf),
// else the title. Bucket names and gs:// URIs are never shown.
export function fileNameOf(metadata = {}) {
  const fromTitle = /^[a-z][a-z0-9+.-]*:\/\//i.test(text(metadata.title))
    ? lastPathSegment(metadata.title)
    : text(metadata.title);
  for (const candidate of [lastPathSegment(metadata.uri), fromTitle]) {
    const name = candidate.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (name && !name.includes('://')) return name.slice(0, 200);
  }
  return 'Company document';
}

// With ancestor headings enabled, a chunk can open with Markdown-style heading
// lines. The last leading heading is the nearest section; if there is none,
// only the page is shown.
function leadingHeading(content) {
  let heading = '';
  for (const line of content.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(value);
    if (!match) break;
    heading = match[1];
  }
  return heading.slice(0, 120);
}

function pageLabel(span) {
  const start = Number(span?.pageStart),
    end = Number(span?.pageEnd);
  if (!Number.isInteger(start) || start < 1) return '';
  return Number.isInteger(end) && end > start ? `pages ${start}–${end}` : `page ${start}`;
}

export function sectionOf(chunk) {
  const label = [leadingHeading(text(chunk?.content)), pageLabel(chunk?.pageSpan)]
    .filter(Boolean)
    .join(' · ');
  return label ? label[0].toUpperCase() + label.slice(1) : '';
}

const contentOf = (chunk) => text(chunk?.content).slice(0, MAX_CHUNK_CHARACTERS);
// The data store document ID in a chunk name (.../documents/{id}/chunks/{chunk}).
const vertexIdOf = (chunk) => /\/documents\/([^/]+)\/chunks\//.exec(text(chunk?.name))?.[1] || null;

// Converts a chunk-mode search response into passages in rank order. Each passage
// is the matching chunk with its neighbours; a chunk already included in a
// higher-ranked passage is not repeated. The same response always yields the
// same passages in the same order, so the workflow's numeric IDs are stable.
//
// Each passage also carries two internal fields for the retrieval allowlist
// (active-company-documents.mjs): `uri`, the document's gs:// URI as the
// search returned it (or null), and `vertexId`, the data store document ID
// from the chunk name (or null). They never leave the server: the workflow and
// document search copy only the fields they show.
export function passagesFromSearch(data, companyId = null, log = null) {
  const seen = new Set(),
    passages = [];
  let dropped = 0;
  for (const result of Array.isArray(data?.results) ? data.results : []) {
    const chunk = result?.chunk;
    const main = contentOf(chunk);
    if (!main) continue;

    if (companyId) {
      const structCompany = chunk?.documentMetadata?.structData?.companyId;
      if (structCompany && structCompany !== companyId) {
        dropped++;
        continue;
      }
      const uri = String(chunk?.documentMetadata?.uri || '');
      const match = uri.match(/\/companies\/([^/]+)\//);
      if (match && match[1] !== companyId) {
        dropped++;
        continue;
      }
      if (companyId !== DEFAULT_COMPANY_ID) {
        if (!uri.includes(`/companies/${companyId}/`)) {
          dropped++;
          continue;
        }
      }
    }

    const document =
      text(result.id) ||
      text(chunk.documentMetadata?.uri) ||
      text(chunk.name).split('/chunks/')[0] ||
      fileNameOf(chunk.documentMetadata);
    // Chunk.name ends in /chunks/{chunk_id}; neighbours may carry either field.
    const keyOf = (item) =>
      `${document}#${text(item?.id) || text(item?.name).split('/chunks/')[1] || 'text:' + contentOf(item)}`;
    const mainKey = keyOf(chunk);
    if (seen.has(mainKey)) continue;
    seen.add(mainKey);
    const parts = [];
    const add = (neighbours) => {
      for (const item of Array.isArray(neighbours) ? neighbours : []) {
        const content = contentOf(item),
          key = keyOf(item);
        if (!content || seen.has(key)) continue;
        seen.add(key);
        parts.push(content);
      }
    };
    add(chunk.chunkMetadata?.previousChunks);
    parts.push(main);
    add(chunk.chunkMetadata?.nextChunks);
    passages.push({
      title: fileNameOf(chunk.documentMetadata),
      heading: sectionOf(chunk),
      text: parts.join('\n\n'),
      excerpt: main,
      uri: text(chunk.documentMetadata?.uri) || null,
      vertexId: vertexIdOf(chunk),
    });
  }
  if (dropped > 0 && log) {
    log(`Dropped ${dropped} foreign search result(s).`);
  }
  return passages;
}

function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}

async function googleReason(response) {
  try {
    const body = await response.json();
    return {
      reason: typeof body?.error?.status === 'string' ? body.error.status : null,
      message: typeof body?.error?.message === 'string' ? body.error.message.slice(0, 500) : null,
    };
  } catch {
    return { reason: null, message: null };
  }
}

// Returns search(query, { signal, pageSize, companyId }) -> passages. One bounded request per call; the only
// retry is one LOWEST-threshold request after a response with zero results.
export function createVertexSearch({
  config,
  fetchImpl = fetch,
  getAccessToken = createAccessTokenProvider(),
  timeoutMs = SEARCH_TIMEOUT_MS,
  log = (message) => console.warn(message),
}) {
  return async function search(query, options = {}) {
    const {
      signal,
      pageSize,
      companyId = null,
    } = typeof options === 'object' && options !== null
      ? options
      : { signal: undefined, pageSize: undefined, companyId: null };
    // A ref'd timer, not AbortSignal.timeout(): that timer is unref'd, so a pending
    // search would not keep the process alive and could be dropped mid-flight.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      return await run(query, signal, deadline.signal, { pageSize, companyId });
    } finally {
      clearTimeout(timer);
    }
  };

  async function run(query, signal, timeout, { pageSize, companyId } = {}) {
    if (!config?.engine || searchConfigProblem(config))
      throw new CompanySearchError('SEARCH_NOT_CONFIGURED');
    const question = text(query);
    if (!question) return [];
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const fail = (code, details = {}) => {
      log(
        'Vertex AI Search request failed: ' +
          JSON.stringify({
            code,
            status: details.upstreamStatus ?? null,
            reason: details.reason ?? null,
          }),
      );
      return new CompanySearchError(code, details);
    };
    // A cancelled chat stays a cancellation; only our own deadline is a timeout.
    const stopped = () => {
      if (signal?.aborted) return signal.reason;
      if (timeout.aborted) return fail('SEARCH_TIMEOUT');
      return null;
    };
    let token;
    try {
      token = await untilAborted(getAccessToken(), bounded);
    } catch {
      throw stopped() ?? fail('SEARCH_AUTH_REQUIRED');
    }
    const post = async (relevanceThreshold) => {
      try {
        const response = await fetchImpl(vertexSearchUrl(config), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(
            searchRequestBody(question, { pageSize, companyId, relevanceThreshold }),
          ),
          signal: bounded,
        });
        if (!response.ok) {
          const { reason, message } = await googleReason(response);
          throw fail(codeForStatus(response.status), {
            upstreamStatus: response.status,
            reason,
            upstreamMessage: message,
          });
        }
        return await response.json();
      } catch (error) {
        if (error instanceof CompanySearchError) throw error;
        throw stopped() ?? fail('SEARCH_UNAVAILABLE');
      }
    };
    let data = await post();
    // Vertex's default relevance cut-off can drop every chunk of a company's
    // documents for a query that has no company name in it. When nothing came
    // back, ask once more with the lowest cut-off: same query, page size and
    // company filter, so isolation is unchanged. Not retried when anything came back.
    if (!(Array.isArray(data?.results) && data.results.length > 0)) data = await post('LOWEST');
    return passagesFromSearch(data, companyId, log);
  }
}
