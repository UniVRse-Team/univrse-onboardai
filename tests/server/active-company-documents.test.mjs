// The retrieval allowlist (issue #79, server/active-company-documents.mjs):
// only passages of active companyDocuments entries are admitted, matched by
// exact URI or data store document ID; the library snapshot is cached,
// invalidated and, on a Firestore failure, reused or failed closed. Synthetic
// entries, URIs and passages only; no Google request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_DOCUMENTS_STALE_MS,
  ACTIVE_DOCUMENTS_TTL_MS,
  ADMITTED_LIMIT,
  ALLOWLIST_PAGE_SIZE,
  activeDocumentsLine,
  activeSnapshot,
  admitPassages,
  createActiveDocuments,
  screenPassages,
  utcDateOf,
} from '../../server/active-company-documents.mjs';
import {
  companyDocumentErrors,
  createCompanyDocumentStore,
} from '../../server/company-documents.mjs';
import { passagesFromSearch, searchRequestBody } from '../../server/vertex-ai-search.mjs';
import { createCompanyRetriever } from '../../server/company-document-retriever.mjs';
import { createCompanyKnowledge } from '../../server/company-knowledge.mjs';
import { profileSourceTitle } from '../../server/company-profile.mjs';
import { FakeFirestore } from './fake-firestore.mjs';
import {
  chunkResult,
  summary,
  syntheticLibrary,
  uriOf,
  vertexIdOf,
} from './active-documents-fixtures.mjs';

const bucket = 'demo-allowlist-docs';
const leave = summary({
  id: '11111111-1111-4111-8111-111111111111',
  fileName: 'Synthetic Leave Policy.pdf',
  connectedAt: '2026-01-12T08:00:00.000Z',
});
const badge = summary({
  id: '22222222-2222-4222-8222-222222222222',
  fileName: 'Synthetic Badge Guide.docx',
  // 00:30 in UTC+8 is the previous UTC day.
  connectedAt: '2026-03-02T00:30:00.000+08:00',
});
const retired = summary({
  id: '33333333-3333-4333-8333-333333333333',
  fileName: 'Synthetic Old Badge Guide.docx',
  status: 'retired',
  retiredAt: '2026-03-01T00:00:00.000Z',
});
const legacy = summary({ id: '44444444-4444-4444-8444-444444444444', fileName: '' });
const undated = summary({
  id: '55555555-5555-4555-8555-555555555555',
  fileName: 'Synthetic Parking Notes.txt',
  connectedAt: null,
});
const entries = [leave, badge, retired, legacy, undated];
const snapshot = activeSnapshot(entries, bucket);
const passage = (fields) => ({
  title: 'Synthetic.pdf',
  heading: '',
  text: 'Synthetic text.',
  excerpt: 'Synthetic text.',
  uri: null,
  vertexId: null,
  ...fields,
});
const lines = () => {
  const logged = [];
  return { logged, log: (entry) => logged.push(entry) };
};

test('the snapshot holds active entries with a file name only, by URI and data store ID', () => {
  assert.deepEqual(
    [...snapshot.byUri.keys()],
    [
      `gs://${bucket}/${leave.id}/Synthetic Leave Policy.pdf`,
      `gs://${bucket}/${badge.id}/Synthetic Badge Guide.docx`,
      `gs://${bucket}/${undated.id}/Synthetic Parking Notes.txt`,
    ],
  );
  assert.deepEqual(
    [...snapshot.byVertexId.keys()],
    [leave, badge, undated].map((entry) => vertexIdOf(bucket, entry)),
  );
  for (const id of snapshot.byVertexId.keys()) assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(snapshot.byUri.get(uriOf(bucket, badge)), {
    id: badge.id,
    title: badge.title,
    category: 'policies',
    version: 1,
    connectedAt: badge.connectedAt,
    date: '2026-03-01',
    companyId: 'luna-digital',
  });
  // A .md upload is stored (and indexed) as .txt.
  const md = summary({ id: leave.id, fileName: 'Notes.md' });
  assert.ok(activeSnapshot([md], bucket).byUri.has(`gs://${bucket}/${leave.id}/Notes.txt`));
  // No bucket, no matches.
  assert.equal(activeSnapshot(entries, '').byUri.size, 0);
  assert.equal(activeSnapshot(entries, '  ').byVertexId.size, 0);
  assert.equal(activeSnapshot(null, bucket).byUri.size, 0);
});

test('utcDateOf gives the UTC day of an ISO time, else null', () => {
  assert.equal(utcDateOf('2026-01-12T08:00:00.000Z'), '2026-01-12');
  assert.equal(utcDateOf('2026-03-02T00:30:00.000+08:00'), '2026-03-01');
  for (const value of [null, undefined, '', 'not a date', 1767225600000])
    assert.equal(utcDateOf(value), null);
});

test('a passage of an active entry matches by its exact, encoded or raw URI, or its document ID', () => {
  const exact = passage({ uri: uriOf(bucket, leave) });
  const encoded = passage({ uri: uriOf(bucket, leave).replace(/ /g, '%20') });
  const idOnly = passage({ vertexId: vertexIdOf(bucket, badge) });
  const both = passage({ uri: uriOf(bucket, badge), vertexId: vertexIdOf(bucket, badge) });
  const admitted = admitPassages([exact, encoded, idOnly, both], snapshot);
  assert.deepEqual(
    admitted.map((p) => p.documentId),
    [leave.id, leave.id, badge.id, badge.id],
  );
  // A file name with a literal "%" is matched as stored.
  const percent = summary({ id: leave.id, fileName: 'Synthetic 50%25 Plan.pdf' });
  const own = activeSnapshot([percent], bucket);
  assert.equal(admitPassages([passage({ uri: uriOf(bucket, percent) })], own).length, 1);
});

test('orphans, unknown IDs, other files under a known ID, retired and legacy entries are dropped', () => {
  const dropped = [
    // The staging drift shapes: a script import at the bucket root, and an
    // HR-namespace object whose entry is gone.
    passage({ uri: `gs://${bucket}/UniVRse - Employee Handbook.pdf` }),
    passage({
      uri: `gs://${bucket}/056e3b6c-0000-4000-8000-000000000000/03 Business Conduct Policy.docx`,
    }),
    // A known ID with another file name, and another bucket.
    passage({ uri: `gs://${bucket}/${leave.id}/Other File.pdf` }),
    passage({ uri: `gs://other-bucket/${leave.id}/Synthetic Leave Policy.pdf` }),
    // An encoded slash never joins two path segments.
    passage({ uri: `gs://${bucket}/${leave.id}%2FSynthetic%20Leave%20Policy.pdf` }),
    // A replaced (retired) version, by URI or by ID.
    passage({ uri: uriOf(bucket, retired) }),
    passage({ vertexId: vertexIdOf(bucket, retired) }),
    // A legacy entry has no file name, so no URI of its own.
    passage({ uri: `gs://${bucket}/${legacy.id}/` }),
    // An unknown data store ID, a bad encoding, and no URI or ID at all.
    passage({ vertexId: 'f'.repeat(32) }),
    passage({ uri: `gs://${bucket}/${leave.id}/bad%E0%A4%A.pdf` }),
    passage({}),
    passage({ uri: '', vertexId: '' }),
  ];
  const { admitted, dropped: count } = screenPassages(dropped, snapshot);
  assert.deepEqual(admitted, []);
  assert.equal(count, dropped.length);
  // Passages from the real search mapping carry the same fields.
  const fromSearch = passagesFromSearch({
    results: [
      chunkResult({ uri: `gs://${bucket}/UniVRse - Code of Conduct.pdf`, content: 'Root.' }),
      chunkResult({ uri: uriOf(bucket, leave), content: 'Active.', chunkId: 'c2' }),
    ],
  });
  assert.deepEqual(
    admitPassages(fromSearch, snapshot).map((p) => p.text),
    ['Active.'],
  );
});

test('rank order is kept, the top 5 of 10 are admitted, and only display fields and dates remain', () => {
  const ranked = [];
  for (let i = 0; i < 10; i++)
    ranked.push(
      i % 3 === 1
        ? passage({ uri: `gs://${bucket}/orphan-${i}.pdf`, text: `orphan ${i}` })
        : passage({
            uri: uriOf(bucket, [leave, badge, undated][i % 3]),
            text: `active ${i}`,
            heading: `Section ${i}`,
          }),
    );
  const { admitted, dropped } = screenPassages(ranked, snapshot);
  assert.equal(ADMITTED_LIMIT, 5);
  assert.equal(ALLOWLIST_PAGE_SIZE, 10);
  assert.deepEqual(
    admitted.map((p) => p.text),
    ['active 0', 'active 2', 'active 3', 'active 5', 'active 6'],
  );
  // Every unmatched passage counts, also those after the limit.
  assert.equal(dropped, 3);
  for (const item of admitted)
    assert.deepEqual(Object.keys(item), [
      'title',
      'heading',
      'text',
      'excerpt',
      'documentId',
      'date',
      'dateKind',
    ]);
  assert.deepEqual(
    admitted.map((p) => [p.date, p.dateKind]),
    [
      ['2026-01-12', 'uploaded'],
      [null, null],
      ['2026-01-12', 'uploaded'],
      [null, null],
      ['2026-01-12', 'uploaded'],
    ],
  );
  assert.ok(!JSON.stringify(admitted).includes('gs://'));
  assert.ok(!JSON.stringify(admitted).includes(bucket));
  assert.equal(admitPassages(ranked, snapshot, { limit: 2 }).length, 2);
  assert.deepEqual(admitPassages(null, snapshot), []);
});

test('the log lines have fixed keys and never a name, title, URI or text', () => {
  assert.deepEqual(activeDocumentsLine({ environment: 'staging', result: 'stale_snapshot' }), {
    severity: 'WARNING',
    event: 'onboardai_active_documents',
    environment: 'staging',
    result: 'stale_snapshot',
  });
  assert.deepEqual(activeDocumentsLine({ environment: 'production', result: 'unavailable' }), {
    severity: 'WARNING',
    event: 'onboardai_active_documents',
    environment: 'production',
    result: 'unavailable',
  });
  assert.deepEqual(activeDocumentsLine({ result: 'dropped', dropped: 4 }), {
    severity: 'INFO',
    event: 'onboardai_active_documents',
    environment: 'local',
    result: 'dropped',
    dropped: 4,
  });
  assert.throws(() => activeDocumentsLine({ result: 'other' }), TypeError);
});

test('the snapshot is cached for 30 seconds, shared by concurrent calls and dropped by invalidate()', async () => {
  let at = 0;
  const library = syntheticLibrary([leave]);
  const { logged, log } = lines();
  const active = createActiveDocuments({ documents: library, bucket, now: () => at, log });
  assert.equal(ACTIVE_DOCUMENTS_TTL_MS, 30_000);
  const [first, second] = await Promise.all([active.snapshot(), active.snapshot()]);
  assert.equal(first, second);
  assert.equal(library.reads, 1);
  library.entries = [leave, badge];
  at = 29_999;
  assert.equal(await active.snapshot(), first);
  assert.equal(library.reads, 1);
  at = 30_000;
  const refreshed = await active.snapshot();
  assert.equal(library.reads, 2);
  assert.ok(refreshed.byUri.has(uriOf(bucket, badge)));
  // A change on this instance is visible at once.
  library.entries = [badge];
  active.invalidate();
  const changed = await active.snapshot();
  assert.equal(library.reads, 3);
  assert.ok(!changed.byUri.has(uriOf(bucket, leave)));
  assert.deepEqual(logged, []);
  // A Date clock works as well.
  const dated = createActiveDocuments({ documents: library, bucket, now: () => new Date(5), log });
  await dated.snapshot();
  await dated.snapshot();
  assert.equal(library.reads, 4);
});

test('a read that started before invalidate() is not cached afterwards', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let reads = 0;
  const library = {
    async listSummaries() {
      const read = ++reads;
      if (read === 1) await gate;
      return read === 1 ? [leave] : [badge];
    },
  };
  const active = createActiveDocuments({ documents: library, bucket, now: () => 0, log: () => {} });
  const early = active.snapshot();
  active.invalidate();
  const late = await active.snapshot();
  release();
  assert.ok((await early).byUri.has(uriOf(bucket, leave)));
  assert.ok(late.byUri.has(uriOf(bucket, badge)));
  // The early read did not replace the later snapshot in the cache.
  assert.equal(await active.snapshot(), late);
  assert.equal(reads, 2);
});

test('a Firestore failure reuses the last snapshot for 10 minutes, then fails closed with 503', async () => {
  let at = 0;
  const library = syntheticLibrary([leave]);
  const { logged, log } = lines();
  const active = createActiveDocuments({
    documents: library,
    bucket,
    now: () => at,
    log,
    environment: 'staging',
  });
  assert.equal(ACTIVE_DOCUMENTS_STALE_MS, 600_000);
  const good = await active.snapshot();
  library.failure = companyDocumentErrors.unavailable();
  at = 60_000;
  const [a, b] = await Promise.all([active.snapshot(), active.snapshot()]);
  assert.equal(a, good);
  assert.equal(b, good);
  // One read and one line for the two concurrent calls.
  assert.equal(library.reads, 2);
  assert.deepEqual(logged, [
    {
      severity: 'WARNING',
      event: 'onboardai_active_documents',
      environment: 'staging',
      result: 'stale_snapshot',
    },
  ]);
  at = 599_999;
  assert.equal(await active.snapshot(), good);
  at = 600_000;
  await assert.rejects(active.snapshot(), { status: 503, code: 'COMPANY_KNOWLEDGE_UNAVAILABLE' });
  assert.equal(logged.at(-1).result, 'unavailable');
  assert.equal(logged.length, 3);
  // Recovery: the next read succeeds and is cached again.
  library.failure = null;
  const recovered = await active.snapshot();
  assert.ok(recovered.byUri.has(uriOf(bucket, leave)));
  assert.equal(await active.snapshot(), recovered);
});

test('with no usable snapshot a failure is the 503 or 504; after invalidate() the old one is never reused', async () => {
  const { logged, log } = lines();
  const library = syntheticLibrary([leave]);
  const active = createActiveDocuments({ documents: library, bucket, now: () => 0, log });
  library.failure = companyDocumentErrors.timeout();
  await assert.rejects(active.snapshot(), { status: 504, code: 'COMPANY_KNOWLEDGE_TIMEOUT' });
  library.failure = new Error('private Firestore detail');
  await assert.rejects(active.snapshot(), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'COMPANY_KNOWLEDGE_UNAVAILABLE');
    assert.ok(!error.message.includes('private'));
    return true;
  });
  library.failure = null;
  await active.snapshot();
  // A deleted document must not come back from the snapshot taken before it.
  library.failure = companyDocumentErrors.unavailable();
  active.invalidate();
  await assert.rejects(active.snapshot(), { code: 'COMPANY_KNOWLEDGE_UNAVAILABLE' });
  assert.deepEqual(
    logged.map((line) => line.result),
    ['unavailable', 'unavailable', 'unavailable'],
  );
  for (const line of logged) assert.ok(!JSON.stringify(line).includes('private'));
});

test('the real store: one select-only read, Firestore errors and deadlines fail closed', async () => {
  const firestore = new FakeFirestore();
  firestore.write(`companyDocuments/${leave.id}`, {
    ...leave,
    // A legacy entry's text is never part of a summary.
    text: 'Synthetic legacy text that is never read.',
    characters: 41,
  });
  const store = createCompanyDocumentStore({
    firestore,
    documentSync: null,
    log: () => {},
    timeoutMs: 50,
  });
  const { logged, log } = lines();
  let at = 0;
  const active = createActiveDocuments({ documents: store, bucket, now: () => at, log });
  const found = await active.snapshot();
  assert.ok(found.byUri.has(uriOf(bucket, leave)));
  assert.ok(!JSON.stringify([...found.byUri.values()]).includes('legacy text'));
  at = ACTIVE_DOCUMENTS_STALE_MS;
  firestore.fail(14);
  await assert.rejects(active.snapshot(), { status: 503, code: 'COMPANY_KNOWLEDGE_UNAVAILABLE' });
  firestore.fail(14, { hang: true });
  await assert.rejects(active.snapshot(), { status: 504, code: 'COMPANY_KNOWLEDGE_TIMEOUT' });
  assert.deepEqual(
    logged.map((line) => line.result),
    ['unavailable', 'unavailable'],
  );
});

test('without a bucket nothing is read and every passage is dropped', async () => {
  const library = syntheticLibrary([leave]);
  const { logged, log } = lines();
  const active = createActiveDocuments({ documents: library, bucket: '', log });
  const empty = await active.snapshot();
  assert.equal(library.reads, 0);
  assert.deepEqual(active.admit([passage({ uri: uriOf(bucket, leave) })], empty), []);
  assert.deepEqual(logged, [
    {
      severity: 'INFO',
      event: 'onboardai_active_documents',
      environment: 'local',
      result: 'dropped',
      dropped: 1,
    },
  ]);
});

test('admit() logs one dropped line per call with drops, none without', async () => {
  const { logged, log } = lines();
  const active = createActiveDocuments({
    documents: syntheticLibrary(entries),
    bucket,
    log,
    environment: 'production',
  });
  const current = await active.snapshot();
  assert.equal(active.admit([passage({ uri: uriOf(bucket, leave) })], current).length, 1);
  assert.deepEqual(logged, []);
  active.admit(
    [passage({ uri: `gs://${bucket}/root.pdf` }), passage({ vertexId: 'a'.repeat(32) })],
    current,
  );
  assert.deepEqual(logged, [
    {
      severity: 'INFO',
      event: 'onboardai_active_documents',
      environment: 'production',
      result: 'dropped',
      dropped: 2,
    },
  ]);
  // A log function that throws never fails the turn.
  const noisy = createActiveDocuments({
    documents: syntheticLibrary(entries),
    bucket,
    log: () => {
      throw new Error('log down');
    },
  });
  assert.deepEqual(noisy.admit([passage({})], await noisy.snapshot()), []);
});

test('knowledge.retrieve and quote search 10 results alongside the snapshot, then admit', async () => {
  const library = syntheticLibrary(entries);
  const searches = [];
  let snapshots = 0;
  const active = createActiveDocuments({ documents: library, bucket, log: () => {} });
  const counted = {
    ...active,
    snapshot: () => {
      snapshots++;
      // The search has already been asked: both run in parallel.
      assert.equal(searches.length, snapshots);
      return active.snapshot();
    },
  };
  const knowledge = createCompanyKnowledge({
    documents: library,
    active: counted,
    companyRetrieve: async (query, options) => {
      searches.push({ query, options });
      return [
        passage({ uri: `gs://${bucket}/UniVRse - Employee Handbook.pdf`, text: 'orphan' }),
        passage({ uri: uriOf(bucket, leave), text: 'active' }),
      ];
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    (await knowledge.retrieve('leave', { signal })).map((p) => [p.text, p.date]),
    [['active', '2026-01-12']],
  );
  assert.deepEqual(
    (await knowledge.quote('leave')).map((p) => p.documentId),
    [leave.id],
  );
  assert.deepEqual(searches, [
    { query: 'leave', options: { signal, pageSize: 10 } },
    { query: 'leave', options: { pageSize: 10 } },
  ]);
  assert.equal(snapshots, 2);
  // A library failure fails the retrieval closed; nothing is returned.
  library.failure = companyDocumentErrors.unavailable();
  const failing = createCompanyKnowledge({
    documents: library,
    active: createActiveDocuments({ documents: library, bucket, log: () => {} }),
    companyRetrieve: async () => [passage({ uri: uriOf(bucket, leave) })],
  });
  await assert.rejects(failing.retrieve('leave'), { code: 'COMPANY_KNOWLEDGE_UNAVAILABLE' });
  // Without the allowlist (the sample guide) passages pass unchanged, with the
  // default page size.
  const plain = [{ title: 'Sample', heading: '', text: 'x' }];
  const sample = createCompanyKnowledge({
    documents: library,
    companyRetrieve: async (query, options) => {
      assert.equal(options, undefined);
      return plain;
    },
  });
  assert.equal(await sample.retrieve('leave'), plain);
});

test('the search asks for 5 results unless the allowlisted path asks for 10', async () => {
  assert.equal(searchRequestBody('q').pageSize, 5);
  assert.equal(searchRequestBody('q', { pageSize: ALLOWLIST_PAGE_SIZE }).pageSize, 10);
  for (const pageSize of [0, -1, 2.5, '10', 51, null]) {
    assert.equal(searchRequestBody('q', { pageSize }).pageSize, 5, String(pageSize));
  }
  const bodies = [];
  const retrieve = createCompanyRetriever({
    env: { GOOGLE_CLOUD_PROJECT: 'demo-p', VERTEX_SEARCH_ENGINE_ID: 'demo-e' },
    getAccessToken: async () => 'synthetic-token',
    log: () => {},
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ results: [] });
    },
  });
  await retrieve('leave');
  await retrieve('leave', { pageSize: ALLOWLIST_PAGE_SIZE });
  assert.deepEqual(
    bodies.map((body) => body.pageSize),
    [5, 10],
  );
});

test('multi-tenant: activeSnapshot correctly resolves URIs and vertex IDs for non-default companies', () => {
  const acmeDoc = summary({
    id: '99999999-9999-4999-8999-999999999999',
    fileName: 'Acme Handbook.pdf',
    connectedAt: '2026-10-15T00:00:00.000Z',
    companyId: 'acme',
  });
  const acmeSnapshot = activeSnapshot([acmeDoc], bucket);
  const expectedUri = `gs://${bucket}/companies/acme/${acmeDoc.id}/Acme Handbook.pdf`;
  assert.ok(acmeSnapshot.byUri.has(expectedUri));
  const entry = acmeSnapshot.byUri.get(expectedUri);
  assert.equal(entry.id, acmeDoc.id);
  assert.equal(entry.companyId, 'acme');

  // Admitting passage for acme
  const acmePassage = passage({
    uri: expectedUri,
    title: 'Acme Handbook.pdf',
    text: 'Acme rules.',
  });
  const admitted = admitPassages([acmePassage], acmeSnapshot, { companyId: 'acme' });
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].documentId, acmeDoc.id);

  // Cross-tenant passage with mismatched companyId is dropped
  const crossAdmitted = admitPassages([acmePassage], acmeSnapshot, { companyId: 'other-corp' });
  assert.equal(crossAdmitted.length, 0);
});

test('screenPassages: company profile passages are admitted without needing a companyDocuments entry', () => {
  const profilePassage = {
    title: profileSourceTitle,
    heading: 'Overview',
    text: 'Alya overview for Acme Corporation.',
  };
  const empty = activeSnapshot([], bucket);
  const admitted = admitPassages([profilePassage], empty);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].title, profileSourceTitle);
  assert.equal(admitted[0].heading, 'Overview');
  assert.equal(admitted[0].documentId, null);
  assert.equal(admitted[0].date, null);
});
