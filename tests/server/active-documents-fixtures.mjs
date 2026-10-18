// Synthetic company library entries and Vertex AI Search chunk results for the
// retrieval allowlist tests (issue #79). No real bucket, data store or text.
import { companyDocumentUri, vertexDocumentId } from '../../server/discovery-engine-documents.mjs';

// A companyDocuments summary as listSummaries() returns it.
export const summary = ({
  id,
  fileName,
  title = fileName.replace(/\.[a-z]+$/i, ''),
  category = 'policies',
  status = 'active',
  version = 1,
  connectedAt = '2026-10-01T09:30:00.000Z',
  retiredAt = null,
  companyId = 'univrse',
}) => ({ id, fileName, title, category, status, version, connectedAt, retiredAt, companyId });

// A store stand-in with listSummaries() only; `entries` may change between
// reads, and `reads` counts them.
export function syntheticLibrary(entries = []) {
  const library = {
    entries,
    reads: 0,
    failure: null,
    async listSummaries() {
      library.reads++;
      if (library.failure) throw library.failure;
      return library.entries.map((entry) => ({ ...entry }));
    },
  };
  return library;
}

// The gs:// URI and data store document ID of an entry in `bucket`.
export const uriOf = (bucket, entry) =>
  companyDocumentUri({ bucket, id: entry.id, fileName: entry.fileName });
export const vertexIdOf = (bucket, entry) => vertexDocumentId(uriOf(bucket, entry));

// One chunk-mode search result for a document URI (percent-encoded like the
// fixtures of tests/document-search.test.mjs unless encode is false) and, when
// given, a data store document ID in the chunk name.
export function chunkResult({
  uri = null,
  vertexId = null,
  content,
  chunkId = 'c1',
  encode = true,
}) {
  const shown = uri && encode ? uri.replace(/ /g, '%20') : uri;
  return {
    id: vertexId || shown || `result-${chunkId}`,
    chunk: {
      ...(vertexId
        ? {
            name: `projects/1/locations/global/collections/default_collection/dataStores/s/branches/0/documents/${vertexId}/chunks/${chunkId}`,
          }
        : { id: chunkId }),
      content,
      ...(shown ? { documentMetadata: { uri: shown } } : { documentMetadata: {} }),
    },
  };
}
