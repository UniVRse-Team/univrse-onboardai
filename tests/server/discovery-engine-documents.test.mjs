// The shared names and URLs of company documents in the bucket and the Vertex
// AI Search data store (server/discovery-engine-documents.mjs), and the rule
// that server code never imports scripts/. Synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DocumentListError,
  SUPPORTED_EXTENSIONS,
  companyDocumentUri,
  dataStoreDocumentUrl,
  dataStoreDocumentsUrl,
  discoveryEngineOperationUrl,
  documentsListUrl,
  documentSummary,
  taggedImportBody,
  extensionOf,
  gcsListUrl,
  gcsObjectName,
  gcsObjectUrl,
  gcsUploadUrl,
  importUrl,
  listDataStoreDocuments,
  namespaceIdOf,
  vertexDocumentId,
} from '../../server/discovery-engine-documents.mjs';
import * as importScript from '../../scripts/import-company-documents.mjs';
import * as companyDocuments from '../../server/company-documents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const id = '11111111-2222-4333-8444-555555555555';
const config = { project: 'demo-project', location: 'global', dataStore: 'demo-docs' };

test('no server module imports from scripts/ (the runtime image may not carry it)', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  walk(path.join(root, 'server'));
  assert.ok(files.length > 50);
  const offenders = files.filter((file) =>
    /(from\s+|import\s*\(\s*)['"](\.\.\/)+scripts\//.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(
    offenders.map((file) => path.relative(root, file)),
    [],
  );
});

test('the server module is the one source of the names the scripts and the api use', () => {
  assert.equal(importScript.SUPPORTED_EXTENSIONS, SUPPORTED_EXTENSIONS);
  assert.equal(importScript.extensionOf, extensionOf);
  assert.equal(importScript.importUrl, importUrl);
  assert.equal(companyDocuments.gcsObjectName, gcsObjectName);
  assert.deepEqual(SUPPORTED_EXTENSIONS, ['pdf', 'docx', 'pptx', 'xlsx', 'html', 'htm', 'txt']);
  assert.equal(extensionOf('a/Guide.PDF'), 'pdf');
});

test('object names, gs:// URIs and Vertex document IDs follow the content-import rule', () => {
  assert.equal(gcsObjectName(id, 'Synthetic Leave Policy.pdf'), `${id}/Synthetic Leave Policy.pdf`);
  assert.equal(gcsObjectName(id, 'Notes.md'), `${id}/Notes.txt`);
  assert.equal(gcsObjectName(id, 'a/b\\c\u0001.docx'), `${id}/a-b-c-.docx`);
  assert.equal(gcsObjectName(id, ''), `${id}/document.txt`);
  const uri = companyDocumentUri({
    bucket: 'demo-onboardai-docs',
    id,
    fileName: 'Synthetic Leave Policy.pdf',
  });
  assert.equal(uri, `gs://demo-onboardai-docs/${id}/Synthetic Leave Policy.pdf`);
  // Vectors from `printf '%s' <uri> | shasum -a 256 | cut -c1-32`.
  assert.equal(vertexDocumentId(uri), 'dc7faf9941cd016ed00756636a5fc170');
  assert.equal(
    vertexDocumentId('gs://demo-onboardai-docs/Synthetic Root Guide.pdf'),
    'a48df4f8483e5c99e904aa97d71c6825',
  );
  // The exact string: an encoded form is another document.
  assert.notEqual(vertexDocumentId(uri.replaceAll(' ', '%20')), vertexDocumentId(uri));
  assert.match(vertexDocumentId('x'), /^[0-9a-f]{32}$/);
});

test('the HR namespace is a lower-case document ID as the first folder', () => {
  assert.equal(namespaceIdOf(`${id}/Guide.pdf`), id);
  assert.equal(namespaceIdOf(`${id}/sub/Guide.pdf`), id);
  assert.equal(namespaceIdOf(`${id}`), null);
  assert.equal(namespaceIdOf('Synthetic Root Guide.pdf'), null);
  assert.equal(namespaceIdOf('onboarding/Guide.pdf'), null);
  assert.equal(namespaceIdOf(`onboarding/${id}/Guide.pdf`), null);
  const lettered = 'abcdef12-2222-4333-8444-555555555555';
  assert.equal(namespaceIdOf(`${lettered}/Guide.pdf`), lettered);
  assert.equal(namespaceIdOf(`${lettered.toUpperCase()}/Guide.pdf`), null);
});

test('Discovery Engine and Cloud Storage URLs honour the location and encode names', () => {
  const documents =
    'https://discoveryengine.googleapis.com/v1/projects/demo-project/locations/global/collections/default_collection/dataStores/demo-docs/branches/default_branch/documents';
  assert.equal(dataStoreDocumentsUrl(config), documents);
  assert.equal(importUrl(config), `${documents}:import`);
  assert.equal(
    importUrl({ project: 'demo-project', dataStore: 'demo-docs' }),
    `${documents}:import`,
  );
  assert.equal(dataStoreDocumentUrl(config, 'abc'), `${documents}/abc`);
  assert.equal(documentsListUrl(config), `${documents}?pageSize=1000`);
  assert.equal(
    documentsListUrl(config, { pageSize: 2, pageToken: 'next/+=' }),
    `${documents}?pageSize=2&pageToken=next%2F%2B%3D`,
  );
  assert.equal(
    importUrl({ ...config, location: 'eu' }),
    'https://eu-discoveryengine.googleapis.com/v1/projects/demo-project/locations/eu/collections/default_collection/dataStores/demo-docs/branches/default_branch/documents:import',
  );
  assert.equal(
    discoveryEngineOperationUrl('global', '/projects/p/operations/o-1'),
    'https://discoveryengine.googleapis.com/v1/projects/p/operations/o-1',
  );
  assert.equal(
    gcsUploadUrl('demo-bucket', `${id}/A B.pdf`),
    `https://storage.googleapis.com/upload/storage/v1/b/demo-bucket/o?uploadType=media&name=${id}%2FA%20B.pdf`,
  );
  assert.equal(
    gcsObjectUrl('demo-bucket', `${id}/A B.pdf`),
    `https://storage.googleapis.com/storage/v1/b/demo-bucket/o/${id}%2FA%20B.pdf`,
  );
  assert.equal(
    gcsListUrl('demo-bucket', { pageToken: 't1' }),
    'https://storage.googleapis.com/storage/v1/b/demo-bucket/o?fields=items%28name%2CtimeCreated%29%2CnextPageToken&pageToken=t1',
  );
});

test('a tagged import is inline, INCREMENTAL, 1 to 100 explicit gs:// documents with a valid companyId', () => {
  const uri = `gs://demo-bucket/${id}/Guide.pdf`;
  assert.deepEqual(taggedImportBody([{ id, uri, companyId: 'seri-bayu-digital' }]), {
    inlineSource: {
      documents: [
        {
          id,
          structData: { companyId: 'seri-bayu-digital' },
          content: { mimeType: 'application/pdf', uri },
        },
      ],
    },
    reconciliationMode: 'INCREMENTAL',
  });
  assert.equal(
    taggedImportBody([{ id, uri: 'gs://b/x/y.docx', companyId: 'luna-digital' }]).inlineSource
      .documents[0].content.mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(
    taggedImportBody([{ id, uri: 'gs://b/x/y.txt', companyId: 'luna-digital' }]).inlineSource
      .documents[0].content.mimeType,
    'text/plain; charset=utf-8',
  );
  const one = { id, uri, companyId: 'luna-digital' };
  for (const bad of [
    [],
    [{ ...one, uri: 'gs://demo-bucket/**' }],
    [{ ...one, uri: 'gs://demo-bucket/folder/' }],
    [{ ...one, uri: 'gs://demo-bucket' }],
    [{ ...one, companyId: undefined }],
    [{ ...one, companyId: 'Bad Company' }],
    [{ ...one, id: '' }],
    [{ ...one, id: 'a/b' }],
  ])
    assert.throws(() => taggedImportBody(bad));
  assert.throws(() => taggedImportBody(Array.from({ length: 101 }, () => one)));
  assert.equal(
    taggedImportBody(Array.from({ length: 100 }, () => one)).inlineSource.documents.length,
    100,
  );
});

test('documentSummary carries structData.companyId, or null when untagged', () => {
  const base = { name: 'projects/p/documents/d1', content: { uri: 'gs://b/x' }, indexTime: 't' };
  assert.deepEqual(documentSummary({ ...base, structData: { companyId: 'luna-digital' } }), {
    id: 'd1',
    uri: 'gs://b/x',
    indexTime: 't',
    companyId: 'luna-digital',
  });
  assert.equal(documentSummary(base).companyId, null);
  assert.equal(documentSummary({ ...base, structData: { companyId: 7 } }).companyId, null);
  assert.equal(documentSummary({ ...base, structData: {} }).companyId, null);
});

test('the documents list follows nextPageToken and throws on a failed or looping page', async () => {
  const pages = {
    '': {
      documents: [{ id: 'd1', content: { uri: 'gs://b/1' }, indexTime: 't' }],
      nextPageToken: 'p2',
    },
    p2: {
      documents: [{ name: 'projects/p/.../documents/d2', content: { uri: 'gs://b/2' } }],
      nextPageToken: 'p3',
    },
    p3: {},
  };
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    return Response.json(pages[new URL(url).searchParams.get('pageToken') ?? '']);
  };
  assert.deepEqual(await listDataStoreDocuments({ request, config }), [
    { id: 'd1', uri: 'gs://b/1', indexTime: 't', companyId: null },
    { id: 'd2', uri: 'gs://b/2', indexTime: null, companyId: null },
  ]);
  assert.deepEqual(
    urls.map((url) => new URL(url).search),
    ['?pageSize=1000', '?pageSize=1000&pageToken=p2', '?pageSize=1000&pageToken=p3'],
  );
  await assert.rejects(
    listDataStoreDocuments({ config, request: async () => new Response('{}', { status: 403 }) }),
    (error) => error instanceof DocumentListError && error.status === 403,
  );
  await assert.rejects(
    listDataStoreDocuments({ config, request: async () => new Response('not json') }),
    DocumentListError,
  );
  await assert.rejects(
    listDataStoreDocuments({
      config,
      request: async () => Response.json({ nextPageToken: 'same' }),
    }),
    DocumentListError,
  );
});
