// Replacing an HR company document (POST .../documents?replaces=<id>, contract
// C-REPLACE), retired entries, the snapshot's version, the store's
// listSummaries() and the knowledge onChange hook. Fake Firestore and fake
// fetch only; synthetic documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { startAccountsApp } from './account-harness.mjs';
import { FakeFirestore } from './fake-firestore.mjs';
import { createApiProxy } from '../../server/api-proxy.mjs';
import {
  companyDocumentSummaryFields,
  createCompanyDocumentStore,
  planMove,
  planReplace,
  planUpload,
} from '../../server/company-documents.mjs';
import { createCompanyKnowledge } from '../../server/company-knowledge.mjs';
import { workspaceLimits } from '../../server/workspace-limits.mjs';

const path = '/api/hr/company-knowledge/documents';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const v1 = 'Synthetic badges are collected on level 9 from the front desk.';
const v2 = 'Synthetic badges are collected on level 4 from the security office.';
const other = 'Synthetic parking is in the blue garage on level three.';
const bucket = 'demo-replace-docs';
const syncEnv = {
  GOOGLE_CLOUD_PROJECT: 'demo-replace',
  DOCS_BUCKET: bucket,
  VERTEX_SEARCH_DATA_STORE_ID: 'demo-replace-store',
};
const documents =
  'https://discoveryengine.googleapis.com/v1/projects/demo-replace/locations/global/collections/default_collection/dataStores/demo-replace-store/branches/default_branch/documents';
const gcsUpload = (objectName) =>
  `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
const gcsObject = (objectName) =>
  `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`;

async function withApp(options, check) {
  const app = await startAccountsApp(options);
  try {
    await check(app);
  } finally {
    await app.close();
  }
}
const replacedEvents = (app) =>
  app.rows(
    "SELECT actor_id, target_id, action, detail FROM account_events WHERE action = 'company_document_replaced' ORDER BY id",
  );
const seed = (app, id, data) =>
  app.firestore
    .connect()
    .collection('companyDocuments')
    .doc(id)
    .set({
      category: 'policies',
      title: 'Seeded',
      fileName: 'seeded.txt',
      characters: 10,
      bytes: 10,
      fingerprint: sha(id),
      connectedBy: 'x',
      connectedAt: '2026-10-01T00:00:00.000Z',
      ...data,
    });

test('planReplace: 404, ALREADY_REPLACED, duplicates, the size limit without the replaced document, no file limit', () => {
  const doc = (id, text, extra = {}) => ({
    id,
    category: 'policies',
    fingerprint: sha(text),
    characters: text.length,
    ...extra,
  });
  const a = randomUUID();
  const b = randomUUID();
  const stored = [doc(a, v1, { title: 'Badges', version: 2 }), doc(b, other)];
  const plan = (replaces, text, list = stored) =>
    planReplace(list, { replaces, text, newId: 'new' });

  for (const bad of ['', 'nope', undefined, ['x'], randomUUID()])
    assert.throws(() => plan(bad, v2), { status: 404, code: 'WORKSPACE_DOCUMENT_NOT_FOUND' });
  // The replaced document's own text: nothing changes, whatever the category.
  assert.deepEqual(plan(a, v1), { id: a, duplicate: true });
  // Another document's text is a 409 (even in the same area).
  assert.throws(() => plan(a, other), { status: 409, code: 'COMPANY_DOCUMENT_DUPLICATE' });
  const replaced = plan(a, v2);
  assert.deepEqual(
    { ...replaced, replaced: replaced.replaced.id },
    { id: 'new', duplicate: false, replaced: a, version: 3 },
  );
  // Missing version reads as 1.
  assert.equal(plan(b, v2).version, 2);
  // Retired, or already superseded by another entry: 409 ALREADY_REPLACED.
  assert.throws(() => plan(a, v2, [doc(a, v1, { status: 'retired' })]), {
    status: 409,
    code: 'COMPANY_DOCUMENT_ALREADY_REPLACED',
  });
  assert.throws(() => plan(a, v2, [doc(b, other, { supersedes: a })]), {
    code: 'COMPANY_DOCUMENT_ALREADY_REPLACED',
  });
  // The text limit leaves the replaced document out; retired entries do not count.
  const big = (id, extra) => ({
    ...doc(id, id),
    characters: workspaceLimits.characters,
    ...extra,
  });
  const full = Array.from({ length: 6 }, () => big(randomUUID()));
  assert.equal(
    planReplace(full, { replaces: full[0].id, text: 'x'.repeat(1000) }).duplicate,
    false,
  );
  assert.throws(() => planUpload(full, { category: 'policies', text: 'x'.repeat(1000) }), {
    code: 'WORKSPACE_TEXT_LIMIT',
  });
  assert.throws(
    () =>
      planReplace(full, { replaces: full[0].id, text: 'x'.repeat(workspaceLimits.characters + 1) }),
    { status: 413, code: 'WORKSPACE_TEXT_LIMIT' },
  );
  // The file-count limit never applies to a replace.
  const forty = Array.from({ length: workspaceLimits.files }, (_, i) => doc(randomUUID(), `G${i}`));
  assert.throws(() => planUpload(forty, { category: 'policies', text: v2 }), {
    code: 'WORKSPACE_DOCUMENT_LIMIT',
  });
  assert.equal(planReplace(forty, { replaces: forty[0].id, text: v2 }).duplicate, false);
});

test('retired entries are not part of the library: limits, duplicates and moves skip them', () => {
  const retired = {
    id: 'r',
    category: 'policies',
    fingerprint: sha(v1),
    characters: 5,
    status: 'retired',
  };
  const live = { id: 'l', category: 'policies', fingerprint: sha(other), characters: 5 };
  // Its text is not a duplicate any more, and it takes no place.
  assert.equal(planUpload([retired], { category: 'alignment', text: v1 }).duplicate, false);
  const full = [
    ...Array.from({ length: workspaceLimits.files - 1 }, (_, i) => ({
      id: `d${i}`,
      category: 'policies',
      fingerprint: sha(`G${i}`),
      characters: 1,
    })),
    retired,
  ];
  assert.equal(planUpload(full, { category: 'policies', text: v2 }).duplicate, false);
  assert.throws(() => planMove([retired, live], 'r', 'alignment'), { status: 404 });
  assert.deepEqual(planMove([retired, { ...live, fingerprint: sha(v1) }], 'l', 'alignment'), {
    unchanged: false,
  });
});

test('replace: 201 with the old entry gone, version 2, the old title kept and one audit row', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const hrId = (await hr.get('/api/auth/session')).body.account.id;
    const first = await hr.upload(
      `${path}?category=policies&name=${encodeURIComponent('Badge Policy')}`,
      Buffer.from(v1),
      'badges-2025.txt',
    );
    assert.equal(first.status, 201, first.text);
    const oldId = first.body.id;
    app.clock.advance(60_000);

    const replaced = await hr.upload(
      `${path}?category=policies&replaces=${oldId}`,
      Buffer.from(v2),
      'badges-2026.md',
    );
    assert.equal(replaced.status, 201, replaced.text);
    assert.deepEqual(Object.keys(replaced.body), ['id', 'duplicate', 'replaced']);
    const newId = replaced.body.id;
    assert.notEqual(newId, oldId);
    assert.deepEqual(replaced.body, {
      id: newId,
      duplicate: false,
      replaced: { id: oldId, cleanup: 'done' },
    });

    assert.deepEqual(app.firestore.paths('companyDocuments/'), [`companyDocuments/${newId}`]);
    const stored = app.firestore.read(`companyDocuments/${newId}`);
    assert.deepEqual(
      { ...stored, connectedAt: 'iso', bytes: 0 },
      {
        category: 'policies',
        // No name on the replace: the replaced document's title, not the file name.
        title: 'Badge Policy',
        fileName: 'badges-2026.md',
        characters: v2.length,
        bytes: 0,
        fingerprint: sha(v2),
        connectedBy: hrId,
        connectedAt: 'iso',
        status: 'active',
        version: 2,
        supersedes: oldId,
        companyId: 'univrse',
        objectName: `${newId}/badges-2026.txt`,
      },
    );

    const snapshot = (await hr.get('/api/hr/company-knowledge')).body.documents;
    assert.equal(snapshot.length, 1);
    assert.deepEqual(
      [snapshot[0].id, snapshot[0].title, snapshot[0].version],
      [newId, 'Badge Policy', 2],
    );
    assert.match(snapshot[0].connectedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Date.parse(snapshot[0].connectedAt), snapshot[0].created);

    assert.deepEqual(await replacedEvents(app), [
      {
        actor_id: hrId,
        target_id: null,
        action: 'company_document_replaced',
        detail: { documentId: newId, replacedId: oldId, category: 'policies' },
      },
    ]);

    // A second replace of the old ID: another browser already replaced it.
    const again = await hr.upload(
      `${path}?category=policies&replaces=${oldId}`,
      Buffer.from(other),
      'late.txt',
    );
    assert.deepEqual(again.body, {
      code: 'COMPANY_DOCUMENT_ALREADY_REPLACED',
      error: 'This document was just replaced. Refresh the library and try again.',
    });
    assert.equal(again.status, 409);

    // A name on the replace and another area: the new version takes them, version 3.
    const third = await hr.upload(
      `${path}?category=alignment&name=Badges%202027&replaces=${newId}`,
      Buffer.from(other),
      'badges-2027.txt',
    );
    assert.equal(third.status, 201, third.text);
    const latest = app.firestore.read(`companyDocuments/${third.body.id}`);
    assert.deepEqual(
      [latest.title, latest.category, latest.version, latest.supersedes],
      ['Badges 2027', 'alignment', 3, newId],
    );
    assert.equal((await replacedEvents(app)).length, 2);
  });
});

test('replace: identical text is 200 duplicate with nothing changed; errors leave no audit row', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const a = (await hr.upload(`${path}?category=policies`, Buffer.from(v1), 'a.txt')).body.id;
    const b = (await hr.upload(`${path}?category=policies`, Buffer.from(other), 'b.txt')).body.id;
    const before = app.firestore.read(`companyDocuments/${a}`);

    const same = await hr.upload(
      `${path}?category=alignment&replaces=${a}`,
      Buffer.from(v1),
      'c.txt',
    );
    assert.deepEqual([same.status, same.body], [200, { id: a, duplicate: true, replaced: null }]);
    assert.deepEqual(app.firestore.read(`companyDocuments/${a}`), before);

    const taken = await hr.upload(
      `${path}?category=policies&replaces=${a}`,
      Buffer.from(other),
      'd.txt',
    );
    assert.deepEqual([taken.status, taken.body.code], [409, 'COMPANY_DOCUMENT_DUPLICATE']);

    for (const replaces of [randomUUID(), 'not-an-id', '', `${a}&replaces=${b}`]) {
      const missing = await hr.upload(
        `${path}?category=policies&replaces=${replaces}`,
        Buffer.from(v2),
        'e.txt',
      );
      assert.deepEqual(
        [missing.status, missing.body.code],
        [404, 'WORKSPACE_DOCUMENT_NOT_FOUND'],
        replaces,
      );
    }
    // The usual 400s come first; a JSON body is still the 415.
    const noArea = await hr.upload(`${path}?replaces=${a}`, Buffer.from(v2), 'f.txt');
    assert.deepEqual([noArea.status, noArea.body.code], [400, 'DOCUMENT_TOPIC_REQUIRED']);
    const json = await hr.post(`${path}?category=policies&replaces=${a}`, { text: v2 });
    assert.deepEqual([json.status, json.body.code], [415, 'FILE_UPLOAD_REQUIRED']);

    assert.deepEqual(await replacedEvents(app), []);
    assert.deepEqual(app.firestore.paths('companyDocuments/').length, 2);
    assert.equal(app.firestore.read(`companyDocuments/${a}`).status, 'active');
  });
});

test('replace: the file-count limit never applies and the text limit leaves the replaced document out', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const ids = Array.from({ length: workspaceLimits.files }, () => randomUUID());
    for (const id of ids) await seed(app, id, { fingerprint: sha(id) });
    const full = await hr.upload(`${path}?category=policies`, Buffer.from(v2), 'x.txt');
    assert.deepEqual([full.status, full.body.code], [409, 'WORKSPACE_DOCUMENT_LIMIT']);
    const replaced = await hr.upload(
      `${path}?category=policies&replaces=${ids[0]}`,
      Buffer.from(v2),
      'x.txt',
    );
    assert.equal(replaced.status, 201, replaced.text);
    assert.equal(app.firestore.paths('companyDocuments/').length, workspaceLimits.files);
  });
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const ids = Array.from({ length: 6 }, () => randomUUID());
    for (const id of ids) await seed(app, id, { characters: workspaceLimits.characters });
    const add = await hr.upload(`${path}?category=policies`, Buffer.from(v2), 'x.txt');
    assert.deepEqual([add.status, add.body.code], [413, 'WORKSPACE_TEXT_LIMIT']);
    const replaced = await hr.upload(
      `${path}?category=policies&replaces=${ids[2]}`,
      Buffer.from(v2),
      'x.txt',
    );
    assert.equal(replaced.status, 201, replaced.text);
  });
});

test('a retired entry is hidden from the snapshot and cannot be moved, deleted or replaced', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const retired = randomUUID();
    await seed(app, retired, { status: 'retired', retiredAt: '2026-10-15T00:59:00.000Z' });
    const live = randomUUID();
    await seed(app, live, { version: 4 });
    const listed = (await hr.get('/api/hr/company-knowledge')).body.documents;
    assert.deepEqual(
      listed.map((d) => [d.id, d.version]),
      [[live, 4]],
    );
    assert.equal((await hr.patch(`${path}/${retired}`, { category: 'alignment' })).status, 404);
    assert.equal((await hr.delete(`${path}/${retired}`)).status, 404);
    const replace = await hr.upload(
      `${path}?category=policies&replaces=${retired}`,
      Buffer.from(v2),
      'x.txt',
    );
    assert.deepEqual(
      [replace.status, replace.body.code],
      [409, 'COMPANY_DOCUMENT_ALREADY_REPLACED'],
    );
    assert.equal(app.firestore.read(`companyDocuments/${retired}`).status, 'retired');
  });
});

test('two HR browsers replacing the same document at once: one 201, one 409 ALREADY_REPLACED', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    await app.createHr('HR-0002', 'synthetic-hr-pass-2');
    const colleague = app.browser();
    await colleague.signIn('HR-0002', 'synthetic-hr-pass-2');
    const id = (await hr.upload(`${path}?category=policies`, Buffer.from(v1), 'a.txt')).body.id;
    const [one, two] = await Promise.all([
      hr.upload(`${path}?category=policies&replaces=${id}`, Buffer.from(v2), 'b.txt'),
      colleague.upload(`${path}?category=policies&replaces=${id}`, Buffer.from(other), 'c.txt'),
    ]);
    assert.deepEqual([one.status, two.status].sort(), [201, 409], `${one.text} ${two.text}`);
    const refused = one.status === 409 ? one : two;
    assert.equal(refused.body.code, 'COMPANY_DOCUMENT_ALREADY_REPLACED');
    assert.equal(app.firestore.paths('companyDocuments/').length, 1);
    assert.equal((await replacedEvents(app)).length, 1);
  });
});

// The sync fake: route(method, url) may return a Response or throw. It is
// armed once the first version is uploaded.
function fakeGoogle(route = () => undefined) {
  const calls = [];
  const fake = {
    calls,
    armed: false,
    fetchImpl: async (url, init = {}) => {
      const method = init.method || 'GET';
      calls.push([method, String(url)]);
      return (
        (fake.armed ? await route(method, String(url)) : undefined) ??
        Response.json({ name: 'operations/import-1' })
      );
    },
  };
  return fake;
}
async function withSync(route, check) {
  const google = fakeGoogle(route);
  await withApp({ env: syncEnv, fetchImpl: google.fetchImpl }, async (app) => {
    const hr = await app.hrBrowser();
    const first = await hr.upload(
      `${path}?category=policies&name=Badges`,
      Buffer.from(v1),
      'Badges v1.txt',
    );
    assert.equal(first.status, 201, first.text);
    google.calls.length = 0;
    app.syncEvents.length = 0;
    google.armed = true;
    await check({ app, hr, oldId: first.body.id, google });
  });
}

test('replace with the sync: the new version is uploaded and imported, then the old one is deleted', async () => {
  await withSync(undefined, async ({ app, hr, oldId, google }) => {
    const res = await hr.upload(
      `${path}?category=policies&replaces=${oldId}`,
      Buffer.from(v2),
      'Badges v2.pdf.txt',
    );
    assert.equal(res.status, 201, res.text);
    const newId = res.body.id;
    const oldUri = `gs://${bucket}/${oldId}/Badges v1.txt`;
    assert.deepEqual(google.calls, [
      ['POST', gcsUpload(`${newId}/Badges v2.pdf.txt`)],
      ['POST', `${documents}:import`],
      ['DELETE', gcsObject(`${oldId}/Badges v1.txt`)],
      ['DELETE', `${documents}/${sha(oldUri).slice(0, 32)}`],
    ]);
    assert.deepEqual(res.body.replaced, { id: oldId, cleanup: 'done' });
    assert.deepEqual(
      app.syncEvents.map((e) => [e.operation, e.outcome, e.documentId]),
      [
        ['gcs.upload', 'ok', newId],
        ['discoveryengine.import', 'ok', newId],
        ['gcs.delete', 'ok', oldId],
        ['discoveryengine.delete', 'ok', oldId],
        ['replace.cleanup', 'ok', oldId],
      ],
    );
    assert.deepEqual(app.firestore.paths('companyDocuments/'), [`companyDocuments/${newId}`]);
    assert.ok(app.logs.every((line) => !line.includes('Badges') && !line.includes(bucket)));
  });
});

for (const [name, failing, expected] of [
  [
    'the GCS upload fails',
    (method, url) => method === 'POST' && url.includes('/upload/'),
    [503, 'COMPANY_KNOWLEDGE_UNAVAILABLE'],
  ],
  [
    'the import fails',
    (method, url) => url.endsWith(':import'),
    [503, 'COMPANY_KNOWLEDGE_UNAVAILABLE'],
  ],
  [
    'the import times out',
    (method, url) => url.endsWith(':import') && 'timeout',
    [504, 'COMPANY_KNOWLEDGE_TIMEOUT'],
  ],
])
  test(`replace rolls back when ${name}: the old version is active again and the new object is deleted`, async () => {
    await withSync(
      (method, url) => {
        const fails = failing(method, url);
        if (fails === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
        if (fails) return new Response('{}', { status: 500 });
      },
      async ({ app, hr, oldId, google }) => {
        const res = await hr.upload(
          `${path}?category=policies&replaces=${oldId}`,
          Buffer.from(v2),
          'Badges v2.txt',
        );
        assert.deepEqual([res.status, res.body.code], expected);
        assert.deepEqual(app.firestore.paths('companyDocuments/'), [`companyDocuments/${oldId}`]);
        const old = app.firestore.read(`companyDocuments/${oldId}`);
        assert.deepEqual([old.status, old.retiredAt, old.version], ['active', null, 1]);
        const listed = (await hr.get('/api/hr/company-knowledge')).body.documents;
        assert.deepEqual(
          listed.map((d) => d.id),
          [oldId],
        );
        // The new version's object goes (best effort); the old one is never touched.
        const deletes = google.calls.filter(([method]) => method === 'DELETE');
        assert.equal(deletes.length, 1);
        assert.match(deletes[0][1], /\/o\/[0-9a-f-]{36}%2FBadges%20v2\.txt$/);
        assert.ok(!deletes[0][1].includes(oldId));
        const rollback = app.syncEvents.filter((e) => e.operation === 'replace.rollback');
        assert.equal(rollback.length, 1);
        assert.equal(rollback[0].outcome, 'ok');
        assert.notEqual(rollback[0].documentId, oldId);
        assert.deepEqual(await replacedEvents(app), []);
      },
    );
  });

test('replace: when the old version cannot be cleaned up the answer is 201 with cleanup "pending"', async () => {
  await withSync(
    (method, url) => {
      if (method === 'DELETE' && url.startsWith(documents))
        return new Response('{}', { status: 500 });
    },
    async ({ app, hr, oldId }) => {
      const res = await hr.upload(
        `${path}?category=policies&replaces=${oldId}`,
        Buffer.from(v2),
        'Badges v2.txt',
      );
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(res.body.replaced, { id: oldId, cleanup: 'pending' });
      // The old entry still goes: chat no longer admits it, the reconciler finishes it.
      assert.deepEqual(app.firestore.paths('companyDocuments/'), [
        `companyDocuments/${res.body.id}`,
      ]);
      const cleanup = app.syncEvents.find((e) => e.operation === 'replace.cleanup');
      assert.deepEqual(
        [cleanup.outcome, cleanup.severity, cleanup.status, cleanup.reason, cleanup.documentId],
        ['failed', 'WARNING', 500, 'http', oldId],
      );
      assert.equal((await replacedEvents(app)).length, 1);
    },
  );
});

test('the web proxy forwards a replace upload as a 5 MiB raw upload with its query', async () => {
  const seen = [];
  const proxy = createApiProxy({
    apiUrl: 'https://api.example',
    fetchImpl: async (url, init) => {
      seen.push([url, init.body?.length]);
      return Response.json({}, { status: 201 });
    },
  });
  const web = express().use('/api', proxy);
  const server = await new Promise((resolve) => {
    const listening = web.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const id = randomUUID();
  const query = `?category=policies&name=Badges&replaces=${id}`;
  const post = (size) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(size, 'x'),
    });
  try {
    assert.equal((await post(workspaceLimits.bytes)).status, 201);
    assert.deepEqual(seen, [[`https://api.example${path}${query}`, workspaceLimits.bytes]]);
    const big = await post(workspaceLimits.bytes + 1);
    assert.deepEqual([big.status, (await big.json()).code], [413, 'FILE_TOO_LARGE']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('listSummaries: one select-only query of the summary fields, retired entries included', async () => {
  const firestore = new FakeFirestore();
  const selects = [];
  const spy = {
    collection: (name) => {
      const real = firestore.collection(name);
      return {
        select: (...fields) => {
          selects.push(fields);
          return real.select(...fields);
        },
        get: () => assert.fail('listSummaries never reads whole documents'),
      };
    },
  };
  const store = createCompanyDocumentStore({ firestore: spy, documentSync: null, env: {} });
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  firestore.write(`companyDocuments/${a}`, {
    category: 'handbook',
    title: 'Legacy',
    text: 'Secret legacy synthetic text',
    connectedAt: '2026-09-01T00:00:00.000Z',
  });
  firestore.write(`companyDocuments/${b}`, {
    category: 'policies',
    title: 'Badges',
    fileName: 'Badges.pdf',
    status: 'retired',
    retiredAt: '2026-10-02T00:00:00.000Z',
    version: 2,
    connectedAt: '2026-10-01T00:00:00.000Z',
  });
  firestore.write(`companyDocuments/${c}`, {
    category: 'alignment',
    title: 'Purpose',
    fileName: 'Purpose.docx',
    status: 'something-else',
    version: 0,
    connectedAt: '2026-09-15T00:00:00.000Z',
  });
  const summaries = await store.listSummaries();
  assert.deepEqual(selects, [[...companyDocumentSummaryFields]]);
  assert.ok(!companyDocumentSummaryFields.includes('text'));
  assert.deepEqual(summaries, [
    {
      id: a,
      fileName: '',
      title: 'Legacy',
      category: 'handbook',
      status: 'active',
      version: 1,
      connectedAt: '2026-09-01T00:00:00.000Z',
      retiredAt: null,
      companyId: 'univrse',
    },
    {
      id: c,
      fileName: 'Purpose.docx',
      title: 'Purpose',
      category: 'alignment',
      status: 'active',
      version: 1,
      connectedAt: '2026-09-15T00:00:00.000Z',
      retiredAt: null,
      companyId: 'univrse',
    },
    {
      id: b,
      fileName: 'Badges.pdf',
      title: 'Badges',
      category: 'policies',
      status: 'retired',
      version: 2,
      connectedAt: '2026-10-01T00:00:00.000Z',
      retiredAt: '2026-10-02T00:00:00.000Z',
      companyId: 'univrse',
    },
  ]);
  assert.ok(!JSON.stringify(summaries).includes('Secret'));
});

test('onChange runs after every add, replace, move and remove call, also on failure, and cannot fail one', async () => {
  const calls = [];
  let fail = false;
  const store = {
    list: async () => [],
    get: async (id) => ({ id, category: 'policies' }),
    add: async () => {
      calls.push('store.add');
      if (fail) throw new Error('down');
      return { id: 'n', duplicate: false };
    },
    replace: async (replaces, upload, actor, at, { audit }) => {
      calls.push(`store.replace:${replaces}:${upload.title}:${upload.fallbackTitle}`);
      return audit(
        { documentId: 'n2', replacedId: replaces, category: upload.category },
        async () => ({
          id: 'n2',
          duplicate: false,
          replaced: { id: replaces, cleanup: 'done' },
        }),
      );
    },
    move: async (id) => {
      calls.push('store.move');
      return { id, category: 'alignment' };
    },
    remove: async () => calls.push('store.remove'),
  };
  const knowledge = createCompanyKnowledge({
    documents: store,
    companyRetrieve: async () => [],
    onChange: () => {
      calls.push('onChange');
      throw new Error('a cache bug must not fail the request');
    },
  });
  const file = { name: 'Badges v2.txt', text: v2, bytes: 5, content: Buffer.from(v2) };
  assert.deepEqual(
    await knowledge.add('hr', { category: 'policies', name: null }, file, new Date()),
    {
      id: 'n',
      duplicate: false,
      replaced: null,
    },
  );
  const audits = [];
  const replaced = await knowledge.replace(
    'hr',
    knowledge.describe({ category: 'policies', replaces: 'aaaaaaaa-2222-4333-8444-555555555555' }),
    file,
    new Date(),
    (detail, during) => {
      audits.push(detail);
      return during();
    },
  );
  assert.deepEqual(replaced.replaced, {
    id: 'aaaaaaaa-2222-4333-8444-555555555555',
    cleanup: 'done',
  });
  assert.deepEqual(audits, [
    { documentId: 'n2', replacedId: 'aaaaaaaa-2222-4333-8444-555555555555', category: 'policies' },
  ]);
  await knowledge.move('id-1', { category: 'alignment' }, (detail, during) => during());
  await knowledge.remove('id-1');
  fail = true;
  await assert.rejects(
    knowledge.add('hr', { category: 'policies', name: null }, file, new Date()),
    /down/,
  );
  assert.deepEqual(calls, [
    'store.add',
    'onChange',
    'store.replace:aaaaaaaa-2222-4333-8444-555555555555:null:Badges v2',
    'onChange',
    'store.move',
    'onChange',
    'store.remove',
    'onChange',
    'store.add',
    'onChange',
  ]);
  // describe: replaces must be one document ID; the name stays optional.
  assert.deepEqual(knowledge.describe({ category: 'policies' }), {
    category: 'policies',
    name: null,
    replaces: null,
  });
  for (const bad of [
    '',
    'x',
    ['aaaaaaaa-2222-4333-8444-555555555555'],
    'AAAAAAAA-2222-4333-8444-555555555555',
  ])
    assert.throws(() => knowledge.describe({ category: 'policies', replaces: bad }), {
      status: 404,
      code: 'WORKSPACE_DOCUMENT_NOT_FOUND',
    });
  assert.throws(() => knowledge.describe({ category: 'nope', replaces: 'x' }), {
    code: 'DOCUMENT_TOPIC_REQUIRED',
  });
});
