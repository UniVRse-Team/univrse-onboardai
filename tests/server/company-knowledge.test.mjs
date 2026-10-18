// The HR company knowledge library, /api/hr/company-knowledge: file uploads
// (issue #35). Files and people are synthetic; nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { startAccountsApp } from './account-harness.mjs';
import { docx, pdf } from './document-fixtures.mjs';
import { planUpload } from '../../server/company-documents.mjs';
import { createApiProxy } from '../../server/api-proxy.mjs';
import { onboardingDocumentTopics } from '../../server/onboarding-document-topics.mjs';
import { workspaceLimits } from '../../server/workspace-limits.mjs';
import { interleavePassages, titleFromFileName } from '../../server/company-knowledge.mjs';
import { DEFAULT_COMPANY_ID } from '../../server/companies.mjs';

const path = '/api/hr/company-knowledge/documents';
const handbook = 'Dress Code Staff wear smart casual clothing from Monday to Thursday.';
const handbook2 = 'Dress Code Team shirts are worn every Friday in the synthetic office.';
const safety = 'Fire Safety The synthetic assembly point is the north car park.';

async function withApp(options, check) {
  const app = await startAccountsApp(options);
  try {
    await check(app);
  } finally {
    await app.close();
  }
}
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('library rules: an area holds many documents, uploads only add, no text twice, and the limits', () => {
  const doc = (id, category, text, characters = text.length) => ({
    id,
    category,
    fingerprint: sha(text),
    characters,
  });
  const stored = [doc('a', 'policies', 'Policy text'), doc('b', 'additional', 'Safety')];
  const plan = (category, text) => planUpload(stored, { category, text });
  // A second document in an occupied area is new; nothing is replaced.
  const second = plan('policies', 'Another policy');
  assert.equal(second.duplicate, false);
  assert.notEqual(second.id, 'a');
  assert.ok(!('replaced' in second));
  assert.equal(plan('alignment', 'Purpose text').duplicate, false);
  // The same text in the same area is the existing document.
  assert.deepEqual(plan('policies', 'Policy text'), { id: 'a', duplicate: true });
  assert.deepEqual(plan('additional', 'Safety'), { id: 'b', duplicate: true });
  // The same text in another area is refused.
  assert.throws(() => plan('alignment', 'Safety'), {
    code: 'COMPANY_DOCUMENT_DUPLICATE',
    status: 409,
  });
  // The file limit: no more once full, in any area.
  const full = Array.from({ length: workspaceLimits.files }, (_, i) =>
    doc(`d${i}`, i % 2 ? 'policies' : 'additional', `Guide ${i}`),
  );
  for (const category of ['additional', 'policies'])
    assert.throws(() => planUpload(full, { category, text: 'New' }), {
      code: 'WORKSPACE_DOCUMENT_LIMIT',
      status: 409,
    });
  // The character total.
  const big = [doc('x', 'additional', 'Big', workspaceLimits.totalCharacters - 10)];
  assert.throws(() => planUpload(big, { category: 'documentation', text: 'y'.repeat(11) }), {
    code: 'WORKSPACE_TEXT_LIMIT',
    status: 413,
  });
  assert.equal(
    planUpload(big, { category: 'documentation', text: 'y'.repeat(10) }).duplicate,
    false,
  );
});

test('the limits fit five areas with several documents each plus extra guidance', () => {
  assert.deepEqual(workspaceLimits, {
    files: 40,
    bytes: 5 * 1024 * 1024,
    characters: 250000,
    totalCharacters: 1500000,
  });
  assert.ok(workspaceLimits.files >= 5 * 6 + 5);
});

test('HR uploads PDF, DOCX, text and Markdown files; only text and metadata are stored', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const hrId = (await hr.get('/api/auth/session')).body.account.id;

    const empty = await hr.get('/api/hr/company-knowledge');
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('cache-control'), 'no-store');
    assert.deepEqual(empty.body, {
      topics: onboardingDocumentTopics,
      documents: [],
      limits: workspaceLimits,
    });
    assert.deepEqual(
      empty.body.topics.map((topic) => topic.id),
      ['alignment', 'documentation', 'team-support', 'role-tools', 'policies'],
    );

    const files = [
      ['alignment', 'Company overview.pdf', pdf('Our synthetic company builds onboarding tools.')],
      ['policies', 'handbook.docx', docx(handbook)],
      [
        'role-tools',
        'it guide.txt',
        Buffer.from('Laptops are collected from the synthetic IT desk.'),
      ],
      [
        'documentation',
        'role.md',
        Buffer.from('# Role\nSynthetic engineers pair on every change.'),
      ],
    ];
    const ids = [];
    for (const [category, fileName, buffer] of files) {
      const up = await hr.upload(`${path}?category=${category}`, buffer, fileName);
      assert.equal(up.status, 201, up.text);
      assert.deepEqual(Object.keys(up.body), ['id', 'duplicate', 'replaced']);
      assert.deepEqual({ ...up.body, id: 'x' }, { id: 'x', duplicate: false, replaced: null });
      ids.push(up.body.id);
    }
    const stored = app.firestore.read(`companyDocuments/${ids[1]}`);
    assert.deepEqual(
      { ...stored, connectedAt: 'iso', fingerprint: 'sha' },
      {
        category: 'policies',
        title: 'handbook',
        fileName: 'handbook.docx',
        characters: handbook.length,
        bytes: files[1][2].length,
        fingerprint: 'sha',
        connectedBy: hrId,
        connectedAt: 'iso',
        status: 'active',
        version: 1,
        companyId: DEFAULT_COMPANY_ID,
        objectName: `${ids[1]}/handbook.docx`,
      },
    );
    assert.equal('text' in stored, false);
    assert.equal(stored.fingerprint, sha(handbook));
    assert.match(stored.connectedAt, /^\d{4}-\d{2}-\d{2}T/);
    // Neither the file's bytes nor its extracted text are stored in Firestore.
    assert.ok(!JSON.stringify(stored).includes('PK'));
    assert.ok(!JSON.stringify(stored).includes('smart casual'));

    const listed = (await hr.get('/api/hr/company-knowledge')).body;
    assert.deepEqual(Object.keys(listed), ['topics', 'documents', 'limits']);
    assert.deepEqual(
      listed.documents.map((d) => [d.id, d.fileName, d.category]),
      files.map(([category, fileName], i) => [ids[i], fileName, category]),
    );
    assert.deepEqual(
      listed.documents.map((d) => d.title),
      ['Company overview', 'handbook', 'it guide', 'role'],
    );
    for (const doc of listed.documents) {
      assert.deepEqual(Object.keys(doc), [
        'id',
        'title',
        'fileName',
        'category',
        'characters',
        'bytes',
        'created',
        'version',
        'connectedAt',
      ]);
      assert.equal(typeof doc.created, 'number');
      assert.equal(doc.version, 1);
      assert.equal(Date.parse(doc.connectedAt), doc.created);
      assert.ok(doc.characters > 0 && doc.bytes > 0);
    }
    assert.ok(!JSON.stringify(listed).includes('Laptops'));

    // The guest workspace and its library are gone (issue #55).
    const guest = await app.browser().get('/api/guest-workspace');
    assert.deepEqual([guest.status, guest.body.code], [404, 'NOT_FOUND']);
  });
});

test('uploads add: two documents in one area, duplicates by text, and delete removes one', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const first = await hr.upload(`${path}?category=policies`, Buffer.from(handbook), 'v1.txt');
    assert.equal(first.status, 201);
    const id = first.body.id;

    const same = await hr.upload(`${path}?category=policies`, Buffer.from(handbook), 'copy.txt');
    assert.deepEqual([same.status, same.body], [200, { id, duplicate: true, replaced: null }]);

    const added = await hr.upload(`${path}?category=policies`, Buffer.from(handbook2), 'v2.md');
    assert.equal(added.status, 201);
    assert.deepEqual({ ...added.body, id: 'x' }, { id: 'x', duplicate: false, replaced: null });
    assert.notEqual(added.body.id, id);
    assert.equal(app.firestore.read(`companyDocuments/${id}`).fingerprint, sha(handbook));
    assert.equal(
      app.firestore.read(`companyDocuments/${added.body.id}`).fingerprint,
      sha(handbook2),
    );
    assert.equal(app.firestore.paths('companyDocuments/').length, 2);

    // The same text in another area is a 409.
    const taken = await hr.upload(
      `${path}?category=role-tools`,
      Buffer.from(handbook2),
      'again.txt',
    );
    assert.deepEqual([taken.status, taken.body.code], [409, 'COMPANY_DOCUMENT_DUPLICATE']);

    // Another HR browser sees the same library and can delete one document.
    const colleague = app.browser();
    await app.createHr('HR-0002', 'synthetic-hr-pass-2');
    await colleague.signIn('HR-0002', 'synthetic-hr-pass-2');
    assert.equal((await colleague.delete(`${path}/${id}`)).status, 204);
    const missing = await hr.delete(`${path}/${id}`);
    assert.deepEqual([missing.status, missing.body.code], [404, 'WORKSPACE_DOCUMENT_NOT_FOUND']);
    assert.deepEqual(
      (await hr.get('/api/hr/company-knowledge')).body.documents.map((d) => d.id),
      [added.body.id],
    );
  });
});

test('moving a document: ok, the same area, 404, 400, 409 and the audit row', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const hrId = (await hr.get('/api/auth/session')).body.account.id;
    const upload = async (category, text, name) =>
      (await hr.upload(`${path}?category=${category}`, Buffer.from(text), name)).body.id;
    const a = await upload('policies', handbook, 'a.txt');
    const b = await upload('policies', handbook2, 'b.txt');
    const events = () =>
      app.rows(
        "SELECT actor_id, target_id, action, detail FROM account_events WHERE action = 'company_document_moved' ORDER BY id",
      );

    const moved = await hr.patch(`${path}/${a}`, { category: 'alignment' });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual(Object.keys(moved.body), ['document']);
    assert.deepEqual(
      { ...moved.body.document, created: 0, bytes: 0, characters: 0, connectedAt: 'iso' },
      {
        id: a,
        title: 'a',
        fileName: 'a.txt',
        category: 'alignment',
        characters: 0,
        bytes: 0,
        created: 0,
        version: 1,
        connectedAt: 'iso',
      },
    );
    assert.equal(app.firestore.read(`companyDocuments/${a}`).category, 'alignment');
    assert.equal(app.firestore.read(`companyDocuments/${b}`).category, 'policies');
    // The audit row holds ids and categories only.
    assert.deepEqual(await events(), [
      {
        actor_id: hrId,
        target_id: null,
        action: 'company_document_moved',
        detail: { documentId: a, from: 'policies', to: 'alignment' },
      },
    ]);

    // To "Other useful guidance"; the same area is a no-op without an audit row.
    assert.equal((await hr.patch(`${path}/${a}`, { category: 'additional' })).status, 200);
    assert.equal((await events()).length, 2);
    const same = await hr.patch(`${path}/${a}`, { category: 'additional' });
    assert.deepEqual([same.status, same.body.document.category], [200, 'additional']);
    assert.equal((await events()).length, 2);

    const unknown = await hr.patch(`${path}/${randomUUID()}`, { category: 'policies' });
    assert.deepEqual([unknown.status, unknown.body.code], [404, 'WORKSPACE_DOCUMENT_NOT_FOUND']);
    const notAnId = await hr.patch(`${path}/nope`, { category: 'policies' });
    assert.equal(notAnId.status, 404);
    for (const body of [{}, { category: 'it' }, { category: 'company' }, { category: 5 }]) {
      const bad = await hr.patch(`${path}/${a}`, body);
      assert.deepEqual([bad.status, bad.body.code], [400, 'DOCUMENT_TOPIC_REQUIRED']);
    }

    // A document with the same text elsewhere in the library (legacy data) is a 409.
    const clone = randomUUID();
    await app.firestore
      .connect()
      .collection('companyDocuments')
      .doc(clone)
      .set({
        category: 'documentation',
        title: 'Clone',
        text: handbook2,
        characters: handbook2.length,
        bytes: 1,
        fingerprint: sha(handbook2),
        connectedBy: 'x',
        connectedAt: '2026-10-01T00:00:00.000Z',
      });
    const clash = await hr.patch(`${path}/${b}`, { category: 'team-support' });
    assert.deepEqual([clash.status, clash.body.code], [409, 'COMPANY_DOCUMENT_DUPLICATE']);
    assert.equal(app.firestore.read(`companyDocuments/${b}`).category, 'policies');
    assert.equal((await events()).length, 2);

    // Other sites, employees and signed-out browsers cannot move documents.
    const cross = await hr.patch(
      `${path}/${a}`,
      { category: 'policies' },
      { Origin: 'https://other.example' },
    );
    assert.equal(cross.status, 403);
    const { browser: staff } = await app.readyEmployee(hr);
    const asStaff = await staff.patch(`${path}/${a}`, { category: 'policies' });
    assert.equal(asStaff.body.code, 'HR_ROLE_REQUIRED');
    const anonymous = await app.browser().patch(`${path}/${a}`, { category: 'policies' });
    assert.equal(anonymous.body.code, 'AUTH_REQUIRED');
    assert.equal(app.firestore.read(`companyDocuments/${a}`).category, 'additional');
  });
});

test('a document is titled by its file name or by HR’s name of one line and up to 80 characters', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const upload = (query, text, fileName = 'safety.txt') =>
      hr.upload(`${path}?${query}`, Buffer.from(text), fileName);
    const byFile = await upload('category=policies', safety, 'UniVRse - Employee Handbook.txt');
    assert.equal(byFile.status, 201, byFile.text);
    const named = await upload(
      'category=policies&name=' + encodeURIComponent('  Workplace Safety '),
      'Parking is on level three of the garage.',
    );
    assert.equal(named.status, 201);
    // Identical text is the existing document, whatever the name.
    const duplicate = await upload('category=policies&name=Another', safety);
    assert.deepEqual(
      [duplicate.status, duplicate.body],
      [200, { id: byFile.body.id, duplicate: true, replaced: null }],
    );
    // Other useful guidance needs no name either.
    const visitors = await upload(
      'category=additional',
      'Visitors sign in at the synthetic reception desk and wear a badge.',
      'visitors.md',
    );
    assert.equal(visitors.status, 201);
    const listed = (await hr.get('/api/hr/company-knowledge')).body;
    assert.deepEqual(
      listed.documents.map((d) => [d.title, d.category]),
      [
        ['UniVRse - Employee Handbook', 'policies'],
        ['Workplace Safety', 'policies'],
        ['visitors', 'additional'],
      ],
    );
    // The area's own title is never a document's title.
    const areaTitles = listed.topics.map((topic) => topic.title);
    assert.ok(listed.documents.every((d) => !areaTitles.includes(d.title)));

    // A long file name is cut to 80 characters.
    assert.equal(titleFromFileName(`${'n'.repeat(120)}.txt`), 'n'.repeat(80));
    assert.equal(titleFromFileName('.txt'), 'Company document');

    const other = 'Other synthetic guidance text.';
    for (const [query, status, code] of [
      ['category=policies&name=', 400, 'DOCUMENT_NAME_INVALID'],
      ['category=policies&name=%20%20', 400, 'DOCUMENT_NAME_INVALID'],
      ['category=policies&name=' + 'x'.repeat(81), 400, 'DOCUMENT_NAME_INVALID'],
      ['category=policies&name=Line%0Abreak', 400, 'DOCUMENT_NAME_INVALID'],
      ['category=policies&name=a&name=b', 400, 'DOCUMENT_NAME_INVALID'],
      ['', 400, 'DOCUMENT_TOPIC_REQUIRED'],
      ['category=payroll', 400, 'DOCUMENT_TOPIC_REQUIRED'],
      ['category=it', 400, 'DOCUMENT_TOPIC_REQUIRED'],
      ['category=handbook', 400, 'DOCUMENT_TOPIC_REQUIRED'],
      ['category=role-tools&category=policies', 400, 'DOCUMENT_TOPIC_REQUIRED'],
    ]) {
      const response = await upload(query, other);
      assert.deepEqual([response.status, response.body.code], [status, code], query);
    }
    assert.equal((await upload('category=policies&name=' + 'x'.repeat(80), other)).status, 201);
    assert.equal(app.firestore.paths('companyDocuments/').length, 4);
  });
});

test('file errors reuse the guest reader codes; JSON bodies are refused; nothing is stored', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const post = (name, buffer) => hr.upload(`${path}?category=role-tools`, buffer, name);
    for (const [name, buffer, status, code] of [
      ['guide.html', Buffer.from('<p>x</p>'), 415, 'FILE_TYPE_UNSUPPORTED'],
      ['guide.docx', Buffer.from('x'), 422, 'FILE_INVALID'],
      ['guide.pdf', Buffer.from('plain text'), 422, 'FILE_INVALID'],
      ['guide.txt', Buffer.alloc(0), 400, 'FILE_EMPTY'],
      ['guide.pdf', pdf(''), 422, 'FILE_NO_TEXT'],
      ['guide.txt', Buffer.alloc(workspaceLimits.bytes + 1, 'x'), 413, 'FILE_TOO_LARGE'],
      ['guide.txt', Buffer.from('a'.repeat(250001)), 422, 'FILE_TEXT_TOO_LONG'],
      ['../guide.txt', Buffer.from('Some text.'), 400, 'FILE_NAME_INVALID'],
    ]) {
      const response = await post(name, buffer);
      assert.deepEqual([response.status, response.body?.code], [status, code], `${name} ${code}`);
    }
    const badName = await hr.request(
      'POST',
      `${path}?category=role-tools`,
      undefined,
      {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': '%E0%A4%A',
      },
      Buffer.from('x'),
    );
    assert.deepEqual([badName.status, badName.body.code], [400, 'FILE_NAME_INVALID']);

    // The old Google Docs link body.
    const json = await hr.post(path, {
      category: 'it',
      url: 'https://docs.google.com/document/d/abc12345/edit',
    });
    assert.deepEqual([json.status, json.body.code], [415, 'FILE_UPLOAD_REQUIRED']);
    assert.deepEqual(app.firestore.paths('companyDocuments/'), []);
  });
});

test('the file limit and the shared text limit apply to uploads', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const areas = [
      'alignment',
      'documentation',
      'team-support',
      'role-tools',
      'policies',
      'additional',
    ];
    // Stored directly: the API rate limit allows 60 uploads a minute.
    const seed = async (count, text, characters = text.length) => {
      for (let i = 0; i < count; i++) {
        const body = `${text}${i}`;
        await app.firestore
          .connect()
          .collection('companyDocuments')
          .doc(randomUUID())
          .set({
            category: areas[i % areas.length],
            title: `Guide ${i}`,
            fileName: `g${i}.txt`,
            text: body,
            characters,
            bytes: 1,
            fingerprint: sha(body),
            connectedBy: 'x',
            connectedAt: '2026-10-01T00:00:00.000Z',
          });
      }
    };
    await seed(workspaceLimits.files, 'Synthetic guide number ');
    const over = await hr.upload(
      `${path}?category=policies`,
      Buffer.from('One more synthetic guide for staff.'),
      'more.txt',
    );
    assert.deepEqual([over.status, over.body.code], [409, 'WORKSPACE_DOCUMENT_LIMIT']);
  });
  // The text total: documents holding all 1,500,000 characters leave no room.
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    for (let i = 0; i < workspaceLimits.totalCharacters / workspaceLimits.characters; i++)
      await app.firestore
        .connect()
        .collection('companyDocuments')
        .doc(randomUUID())
        .set({
          category: 'policies',
          title: `Big ${i}`,
          text: `Big ${i}`,
          characters: workspaceLimits.characters,
          bytes: 1,
          fingerprint: sha(`Big ${i}`),
          connectedBy: 'x',
          connectedAt: '2026-10-01T00:00:00.000Z',
        });
    const tooMuch = await hr.upload(
      `${path}?category=documentation`,
      Buffer.from('Another synthetic guide.'),
      'r.txt',
    );
    assert.deepEqual([tooMuch.status, tooMuch.body.code], [413, 'WORKSPACE_TEXT_LIMIT']);
  });
});

test('documents connected from Google Docs before #35 still list and carry no Drive fields', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const id = randomUUID();
    await app.firestore
      .connect()
      .collection('companyDocuments')
      .doc(id)
      .set({
        category: 'handbook',
        title: 'Employee Handbook',
        googleDocId: 'legacy-doc-0001',
        text: handbook,
        characters: handbook.length,
        bytes: Buffer.byteLength(handbook),
        fingerprint: sha(handbook),
        connectedBy: 'someone',
        connectedAt: '2026-10-01T00:00:00.000Z',
      });
    const snapshot = (await hr.get('/api/hr/company-knowledge')).body;
    assert.deepEqual(snapshot.documents, [
      {
        id,
        title: 'Employee Handbook',
        fileName: '',
        category: 'handbook',
        characters: handbook.length,
        bytes: Buffer.byteLength(handbook),
        created: Date.parse('2026-10-01T00:00:00.000Z'),
        // Stored before replace existed: version 1.
        version: 1,
        connectedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    assert.ok(!('companyKnowledge' in snapshot) && !('driveMoves' in snapshot));
    // Uploading to an area adds beside the legacy document.
    const added = await hr.upload(`${path}?category=policies`, Buffer.from(handbook2), 'n.txt');
    assert.equal(added.status, 201);
    assert.notEqual(added.body.id, id);
    assert.equal(app.firestore.paths('companyDocuments/').length, 2);
  });
});

test('the library is HR-only, and a Firestore failure is a fixed 503', async () => {
  await withApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const { browser: staff } = await app.readyEmployee(hr);
    const zero = '00000000-0000-0000-0000-000000000000';
    for (const [method, url] of [
      ['get', '/api/hr/company-knowledge'],
      ['delete', `${path}/${zero}`],
      ['patch', `${path}/${zero}`],
    ]) {
      const asEmployee = await staff[method](url);
      assert.deepEqual([asEmployee.status, asEmployee.body.code], [403, 'HR_ROLE_REQUIRED']);
      const anonymous = await app.browser()[method](url);
      assert.deepEqual([anonymous.status, anonymous.body.code], [401, 'AUTH_REQUIRED']);
    }
    const body = Buffer.from(handbook);
    const asEmployee = await staff.upload(`${path}?category=role-tools`, body, 'a.txt');
    assert.deepEqual([asEmployee.status, asEmployee.body.code], [403, 'HR_ROLE_REQUIRED']);
    const anonymous = await app.browser().upload(`${path}?category=role-tools`, body, 'a.txt');
    assert.deepEqual([anonymous.status, anonymous.body.code], [401, 'AUTH_REQUIRED']);
    // Another site's request is refused.
    const cross = await hr.upload(`${path}?category=role-tools`, body, 'a.txt', {
      Origin: 'https://other.example',
    });
    assert.equal(cross.status, 403);
    assert.deepEqual(app.firestore.paths('companyDocuments/'), []);

    app.firestore.fail(14, { only: ['query'] });
    const failed = await hr.get('/api/hr/company-knowledge');
    assert.deepEqual([failed.status, failed.body.code], [503, 'COMPANY_KNOWLEDGE_UNAVAILABLE']);
    app.firestore.fail(14, { only: ['transaction'] });
    const notSaved = await hr.upload(`${path}?category=alignment`, body, 'a.txt');
    assert.deepEqual([notSaved.status, notSaved.body.code], [503, 'COMPANY_KNOWLEDGE_UNAVAILABLE']);
    assert.deepEqual(app.firestore.paths('companyDocuments/'), []);
  });
  assert.deepEqual(
    onboardingDocumentTopics.map((topic) => topic.id),
    ['alignment', 'documentation', 'team-support', 'role-tools', 'policies'],
  );
});

test('logs never contain file names or text', async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    await withApp({}, async (app) => {
      const hr = await app.hrBrowser();
      app.firestore.fail(14, { only: ['transaction'] });
      await hr.upload(
        `${path}?category=role-tools`,
        Buffer.from('Secret synthetic text.'),
        'secret-name.txt',
      );
      await hr.upload(`${path}?category=role-tools`, Buffer.from('x'), 'secret-name.html');
      assert.ok([...lines, ...app.logs].every((l) => !/secret/i.test(l)));
    });
  } finally {
    console.warn = warn;
  }
});

test('the web proxy forwards the upload path as a 5 MiB raw upload with the reader’s 413 code', async () => {
  const seen = [];
  const proxy = createApiProxy({
    apiUrl: 'https://api.example',
    fetchImpl: async (url, init) => {
      seen.push([url, init.body?.length]);
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  const web = express().use('/api', proxy);
  const server = await new Promise((resolve) => {
    const listening = web.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/hr/company-knowledge/documents?category=role-tools`;
  const post = (size, type) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: Buffer.alloc(size, 'x'),
    });
  try {
    const ok = await post(workspaceLimits.bytes, 'application/octet-stream');
    assert.equal(ok.status, 201);
    assert.deepEqual(seen, [
      [
        'https://api.example/api/hr/company-knowledge/documents?category=role-tools',
        workspaceLimits.bytes,
      ],
    ]);
    const big = await post(workspaceLimits.bytes + 1, 'application/octet-stream');
    assert.deepEqual([big.status, (await big.json()).code], [413, 'FILE_TOO_LARGE']);
    // Without the octet-stream type the small JSON limit applies.
    const json = await post(70 * 1024, 'application/json');
    assert.deepEqual([json.status, (await json.json()).code], [413, 'REQUEST_TOO_LARGE']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Moved from the deleted workspace-company-knowledge.test.mjs (issue #55): the
// library and the company retriever are interleaved this way.
test('passages from two ranked sources alternate, keep their own order and stop at the limit', () => {
  assert.deepEqual(interleavePassages([1, 2, 3], ['a', 'b'], 6), [1, 'a', 2, 'b', 3]);
  assert.deepEqual(interleavePassages([1, 2, 3], ['a', 'b'], 2), [1, 'a']);
  assert.deepEqual(interleavePassages([], ['a', 'b', 'c'], 2), ['a', 'b']);
  assert.deepEqual(interleavePassages([1], [], 6), [1]);
  assert.deepEqual(interleavePassages([], [], 6), []);
});

test('HR uploads and deletes sync directly to GCS and trigger Vertex AI Search data store import', async () => {
  const calls = [];
  let failNextSync = false;
  await withApp(
    {
      env: {
        GOOGLE_CLOUD_PROJECT: 'demo-test',
        DOCS_BUCKET: 'demo-test-onboardai-docs',
        VERTEX_SEARCH_DATA_STORE_ID: 'onboardai-docs',
      },
      fetchImpl: async (url, init = {}) => {
        calls.push({
          method: init.method || 'GET',
          url: String(url),
          headers: init.headers || {},
          body: init.body,
        });
        if (failNextSync) {
          return new Response('upstream failure', { status: 500 });
        }
        return Response.json({ name: 'operations/import-1', done: false });
      },
    },
    async (app) => {
      const hr = await app.hrBrowser();
      const up = await hr.upload(
        `${path}?category=policies`,
        Buffer.from(handbook),
        'Employee Handbook.txt',
      );
      assert.equal(up.status, 201, up.text);
      const id = up.body.id;

      // 1. Uploaded raw buffer to GCS, then triggered INCREMENTAL import into Vertex AI Search.
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, 'POST');
      assert.equal(
        calls[0].url,
        `https://storage.googleapis.com/upload/storage/v1/b/demo-test-onboardai-docs/o?uploadType=media&name=${encodeURIComponent(`${id}/Employee Handbook.txt`)}`,
      );
      assert.equal(Buffer.from(calls[0].body).toString('utf8'), handbook);

      assert.equal(calls[1].method, 'POST');
      assert.equal(
        calls[1].url,
        'https://discoveryengine.googleapis.com/v1/projects/demo-test/locations/global/collections/default_collection/dataStores/onboardai-docs/branches/default_branch/documents:import',
      );
      assert.deepEqual(JSON.parse(calls[1].body), {
        inlineSource: {
          documents: [
            {
              id,
              content: {
                uri: `gs://demo-test-onboardai-docs/${id}/Employee Handbook.txt`,
                mimeType: 'text/plain; charset=utf-8',
              },
              structData: {
                companyId: DEFAULT_COMPANY_ID,
              },
            },
          ],
        },
        reconciliationMode: 'INCREMENTAL',
      });

      // Duplicate upload does not re-upload to GCS or re-trigger import.
      calls.length = 0;
      const dup = await hr.upload(
        `${path}?category=policies`,
        Buffer.from(handbook),
        'Employee Handbook.txt',
      );
      assert.deepEqual([dup.status, dup.body], [200, { id, duplicate: true, replaced: null }]);
      assert.equal(calls.length, 0);

      // Failed GCS/Vertex sync rolls back the Firestore metadata entry.
      failNextSync = true;
      const failedUp = await hr.upload(
        `${path}?category=policies`,
        Buffer.from(handbook2),
        'Friday Policy.txt',
      );
      assert.deepEqual(
        [failedUp.status, failedUp.body.code],
        [503, 'COMPANY_KNOWLEDGE_UNAVAILABLE'],
      );
      assert.deepEqual(app.firestore.paths('companyDocuments/'), [`companyDocuments/${id}`]);
      failNextSync = false;

      // 2. Deleting the document deletes the GCS object, then that one document
      // from Vertex AI Search by its ID, sha256(gs:// URI)[:32] (D-1). It never
      // re-imports the bucket: a FULL reconciliation would also drop indexed
      // documents whose objects are no longer in the bucket.
      calls.length = 0;
      const del = await hr.delete(`${path}/${id}`);
      assert.equal(del.status, 204);
      const documents =
        'https://discoveryengine.googleapis.com/v1/projects/demo-test/locations/global/collections/default_collection/dataStores/onboardai-docs/branches/default_branch/documents';
      const uri = `gs://demo-test-onboardai-docs/${id}/Employee Handbook.txt`;
      assert.deepEqual(
        calls.map((c) => [c.method, c.url]),
        [
          [
            'DELETE',
            `https://storage.googleapis.com/storage/v1/b/demo-test-onboardai-docs/o/${encodeURIComponent(`${id}/Employee Handbook.txt`)}`,
          ],
          ['DELETE', `${documents}/${sha(uri).slice(0, 32)}`],
        ],
      );
      assert.ok(calls.every((c) => !c.url.endsWith(':import')));
      assert.deepEqual(app.firestore.paths('companyDocuments/'), []);
    },
  );
});

test('a delete whose GCS or Vertex AI Search sync fails keeps the document listed, and a retry finishes it', async () => {
  const calls = [];
  // The status each Vertex AI Search document DELETE answers, in order.
  const vertexDeletes = [500, 200];
  let gcsGone = false;
  await withApp(
    {
      env: {
        GOOGLE_CLOUD_PROJECT: 'demo-test',
        DOCS_BUCKET: 'demo-test-onboardai-docs',
        VERTEX_SEARCH_DATA_STORE_ID: 'onboardai-docs',
      },
      fetchImpl: async (url, init = {}) => {
        const method = init.method || 'GET';
        calls.push([method, String(url)]);
        if (method === 'DELETE' && String(url).includes('storage.googleapis.com')) {
          // The first attempt deleted the object, so the retry sees a 404.
          const status = gcsGone ? 404 : 200;
          gcsGone = true;
          return new Response('{}', { status });
        }
        if (method === 'DELETE') return new Response('{}', { status: vertexDeletes.shift() });
        return Response.json({ name: 'operations/import-1', done: false });
      },
    },
    async (app) => {
      const hr = await app.hrBrowser();
      const up = await hr.upload(
        `${path}?category=policies`,
        Buffer.from(handbook),
        'Employee Handbook.txt',
      );
      assert.equal(up.status, 201, up.text);
      const id = up.body.id;

      // An unknown id is a 404 before anything reaches GCS or Vertex AI Search.
      calls.length = 0;
      const unknown = await hr.delete(`${path}/${randomUUID()}`);
      assert.deepEqual([unknown.status, unknown.body.code], [404, 'WORKSPACE_DOCUMENT_NOT_FOUND']);
      assert.deepEqual(calls, []);

      // The GCS object is deleted but the Vertex AI Search delete fails: 503,
      // and the document stays in the library so HR can try again.
      const failed = await hr.delete(`${path}/${id}`);
      assert.deepEqual([failed.status, failed.body.code], [503, 'COMPANY_KNOWLEDGE_UNAVAILABLE']);
      assert.deepEqual(app.firestore.paths('companyDocuments/'), [`companyDocuments/${id}`]);
      assert.deepEqual(
        (await hr.get('/api/hr/company-knowledge')).body.documents.map((d) => d.id),
        [id],
      );

      // The retry tolerates the GCS 404, deletes from Vertex AI Search by the
      // document's URI hash, then removes the metadata.
      calls.length = 0;
      const retried = await hr.delete(`${path}/${id}`);
      assert.equal(retried.status, 204, retried.text);
      assert.deepEqual(
        calls.map(([method]) => method),
        ['DELETE', 'DELETE'],
      );
      assert.deepEqual(app.firestore.paths('companyDocuments/'), []);
    },
  );
});
