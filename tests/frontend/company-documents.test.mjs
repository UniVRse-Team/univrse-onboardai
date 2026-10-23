import test from 'node:test';
import assert from 'node:assert/strict';
import {
  documentsForArea,
  hasWordFile,
  otherDocuments,
  policyButtonTarget,
  uploadedHandbook,
} from '../../src/portal/company-documents-model.mjs';
import { journeyApi } from '../../src/access/journey-api.mjs';

const doc = (id, title, category, fileName = title + '.pdf') => ({
  id,
  title,
  category,
  fileName,
  uploadedAt: '2026-10-23T13:42:10.000Z',
  viewUrl: `/api/me/company-documents/${id}/file`,
});
const payload = {
  documents: [
    doc('a', 'Setup guide', 'documentation'),
    doc('b', '01 Code of Conduct', 'policies'),
    doc('c', '02 Company Handbook', 'policies', '02 Company Handbook.docx'),
    doc('d', 'Values', 'alignment'),
    doc('e', 'Extra', 'additional'),
  ],
};

test('documents are grouped by area, keeping the server order', () => {
  assert.deepEqual(
    documentsForArea(payload.documents, 'policies').map((d) => d.id),
    ['b', 'c'],
  );
  assert.deepEqual(documentsForArea(payload.documents, 'role-tools'), []);
});

test('additional documents are listed separately', () => {
  assert.deepEqual(
    otherDocuments(payload.documents).map((d) => d.id),
    ['e'],
  );
});

test('empty or malformed lists give nothing', () => {
  for (const bad of [undefined, null, [], {}]) {
    assert.deepEqual(documentsForArea(bad, 'policies'), []);
    assert.deepEqual(otherDocuments(bad), []);
    assert.equal(uploadedHandbook(bad), null);
  }
});

test('the handbook is the policies document titled handbook, else any policies document', () => {
  assert.equal(uploadedHandbook(payload.documents).id, 'c');
  assert.equal(uploadedHandbook([doc('b', 'Code of Conduct', 'policies')]).id, 'b');
  assert.equal(uploadedHandbook([doc('h', 'Handbook', 'additional')]), null);
});

test('policy button: uploaded handbook, then built-in link, then nothing', () => {
  const builtIn = { title: 'Handbook', url: 'https://example.com/h' };
  const stepId = 'policies.employee-handbook';
  const uploaded = policyButtonTarget({ stepId, document: builtIn, documents: payload.documents });
  assert.equal(uploaded.kind, 'uploaded');
  assert.equal(uploaded.label, 'View 02 Company Handbook');
  assert.equal(uploaded.url, '/api/me/company-documents/c/file');
  assert.equal(policyButtonTarget({ stepId, document: builtIn, documents: [] }).kind, 'built-in');
  assert.equal(policyButtonTarget({ stepId, document: undefined, documents: [] }), null);
});

test('other policy steps keep their own document link', () => {
  const builtIn = { title: 'Code', url: 'https://example.com/c' };
  assert.equal(
    policyButtonTarget({ stepId: 'policies.code', document: builtIn, documents: payload.documents })
      .kind,
    'built-in',
  );
});

test('word files are detected for the download note', () => {
  assert.equal(hasWordFile(payload.documents), true);
  assert.equal(hasWordFile([doc('p', 'P', 'policies')]), false);
});

test('journeyApi.companyDocuments calls the contract route', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { status: 200, ok: true, json: async () => payload, headers: new Headers() };
  };
  try {
    const result = await journeyApi.companyDocuments();
    assert.equal(result.documents.length, 5);
    assert.ok(calls[0].endsWith('/api/me/company-documents'));
  } finally {
    globalThis.fetch = original;
  }
});
