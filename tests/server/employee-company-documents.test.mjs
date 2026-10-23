// Issue #126: GET /api/me/company-documents and /api/me/company-documents/:id/file.
// An employee lists and opens only their own company's active documents, never
// their text, object name or bucket; another company's, a retired or an
// unknown id is the same 404. pg-mem, the in-memory Firestore fake, an
// in-memory bucket and synthetic documents only; GCS is a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAccountsApp } from './account-harness.mjs';
import { pdf, docx } from './document-fixtures.mjs';
import {
  createCompanyDocumentFiles,
  createMemoryCompanyDocumentFiles,
} from '../../server/company-document-files.mjs';
import { createWebApp } from '../../server/web-app.mjs';

const handbookText = 'Synthetic Lumora handbook: staff start at 08:30 on weekdays.';
const lunaText = 'Synthetic Luna guide: the Friday meeting is at 09:30.';
const parkingText = 'Synthetic parking: staff park on level 3 of the visitor garage.';
const unknownId = '00000000-0000-4000-8000-000000000000';
const documentKeys = ['id', 'title', 'category', 'fileName', 'uploadedAt', 'viewUrl'];

async function withApp(options, check) {
  const app = await startAccountsApp(options);
  try {
    await check(app);
  } finally {
    await app.close();
  }
}
// The app with an in-memory documents bucket that the HR uploads write to.
function withLibrary(check, options = {}) {
  const bucket = createMemoryCompanyDocumentFiles();
  return withApp(
    { companyDocumentSync: bucket.documentSync, companyDocumentFiles: bucket, ...options },
    (app) => check(app, bucket),
  );
}
async function upload(hr, category, buffer, fileName, name) {
  const query = new URLSearchParams({ category, ...(name ? { name } : {}) });
  const added = await hr.upload(`/api/hr/company-knowledge/documents?${query}`, buffer, fileName);
  assert.equal(added.status, 201, added.text);
  return added.body.id;
}
// Lumora (a starter company) with five documents and an employee; Luna
// Digital with one document and an employee.
async function twoCompanies(app) {
  const lunaHr = await app.hrBrowser();
  const lunaDocId = await upload(lunaHr, 'policies', Buffer.from(lunaText), 'Luna Guide.txt');
  const luna = await app.readyEmployee(lunaHr);
  const lumoraHr = await app.companyHrBrowser({
    companyId: 'lumora',
    name: 'Lumora',
    prefix: 'LU',
  });
  const ids = {
    extra: await upload(lumoraHr, 'additional', Buffer.from(parkingText), 'parking.md'),
    leave: await upload(
      lumoraHr,
      'policies',
      Buffer.from('Synthetic leave rules: apply for annual leave two weeks ahead.'),
      'leave.txt',
      '10 Leave Policy',
    ),
    handbook: await upload(
      lumoraHr,
      'policies',
      pdf(handbookText),
      '02 Company Handbook.pdf',
      '02 Company Handbook',
    ),
    values: await upload(
      lumoraHr,
      'alignment',
      docx('Synthetic values: we keep our promises and share what we learn.'),
      'Our Values.docx',
    ),
    forms: await upload(
      lumoraHr,
      'documentation',
      Buffer.from('Synthetic forms list: the bank form and the emergency contact form.'),
      'Forms.txt',
    ),
  };
  const lumora = await app.readyEmployee(lumoraHr);
  return { lunaHr, lunaDocId, luna, lumoraHr, ids, lumora };
}

test('GET /api/me/company-documents lists the account’s own company’s active documents by area then title, without text or storage names', async () => {
  await withLibrary(async (app) => {
    const { lunaDocId, luna, ids, lumora } = await twoCompanies(app);
    // A retired entry of the same company is not listed.
    const retiredId = '11111111-2222-4333-8444-555555555555';
    app.firestore.write(`companyDocuments/${retiredId}`, {
      category: 'policies',
      title: '01 Old Handbook',
      fileName: 'old.txt',
      status: 'retired',
      companyId: 'lumora',
      connectedAt: '2026-10-01T00:00:00.000Z',
    });

    const listed = await lumora.browser.get('/api/me/company-documents');
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(listed.body), ['documents']);
    assert.deepEqual(
      listed.body.documents.map((d) => [d.category, d.title]),
      [
        ['documentation', 'Forms'],
        ['policies', '02 Company Handbook'],
        ['policies', '10 Leave Policy'],
        ['alignment', 'Our Values'],
        ['additional', 'parking'],
      ],
    );
    const handbook = listed.body.documents[1];
    assert.deepEqual(handbook, {
      id: ids.handbook,
      title: '02 Company Handbook',
      category: 'policies',
      fileName: '02 Company Handbook.pdf',
      uploadedAt: app.firestore.read(`companyDocuments/${ids.handbook}`).connectedAt,
      viewUrl: `/api/me/company-documents/${ids.handbook}/file`,
    });
    assert.match(handbook.uploadedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (const document of listed.body.documents)
      assert.deepEqual(Object.keys(document), documentKeys);
    // Never the text, the object name, the bucket or another company's entry.
    for (const hidden of [
      'Synthetic leave rules',
      'Synthetic parking',
      'companies/lumora',
      'objectName',
      'characters',
      'fingerprint',
      'companyId',
      lunaDocId,
      retiredId,
    ])
      assert.equal(listed.text.includes(hidden), false, hidden);

    // Luna Digital's employee sees only Luna Digital's document.
    const lunaList = await luna.browser.get('/api/me/company-documents');
    assert.deepEqual(
      lunaList.body.documents.map((d) => [d.id, d.title, d.category]),
      [[lunaDocId, 'Luna Guide', 'policies']],
    );
  });
});

test('GET /api/me/company-documents/:id/file sends the own company’s file inline; another company’s, a retired, an unknown or a malformed id is the same 404', async () => {
  await withLibrary(async (app, bucket) => {
    const { lunaDocId, luna, ids, lumora } = await twoCompanies(app);

    const file = await fetch(`${app.url}/api/me/company-documents/${ids.handbook}/file`, {
      headers: { cookie: lumora.browser.cookieHeader },
    });
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf(handbookText));
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(
      file.headers.get('content-disposition'),
      "inline; filename*=UTF-8''02%20Company%20Handbook.pdf",
    );
    assert.equal(file.headers.get('cache-control'), 'private, no-store');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    // The object the upload wrote, under the company's prefix.
    assert.ok(bucket.files.has(`companies/lumora/${ids.handbook}/02 Company Handbook.pdf`));

    const word = await lumora.browser.get(`/api/me/company-documents/${ids.values}/file`);
    assert.equal(word.status, 200);
    assert.equal(
      word.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    // Text and Markdown uploads are stored (and sent) as their UTF-8 text.
    const markdown = await lumora.browser.get(`/api/me/company-documents/${ids.extra}/file`);
    assert.equal(markdown.status, 200);
    assert.equal(markdown.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(markdown.text, parkingText);
    assert.equal(
      markdown.headers.get('content-disposition'),
      "inline; filename*=UTF-8''parking.md",
    );

    // Luna Digital's own employee opens Luna Digital's document.
    const own = await luna.browser.get(`/api/me/company-documents/${lunaDocId}/file`);
    assert.deepEqual([own.status, own.text], [200, lunaText]);

    const retiredId = '11111111-2222-4333-8444-555555555555';
    app.firestore.write(`companyDocuments/${retiredId}`, {
      category: 'policies',
      title: 'Old Handbook',
      fileName: 'old.txt',
      status: 'retired',
      companyId: 'lumora',
      objectName: `companies/lumora/${retiredId}/old.txt`,
    });
    bucket.put(`companies/lumora/${retiredId}/old.txt`, Buffer.from('Retired text.'));
    for (const [browser, id] of [
      [lumora.browser, lunaDocId],
      [luna.browser, ids.handbook],
      [lumora.browser, retiredId],
      [lumora.browser, unknownId],
      [lumora.browser, 'not-an-id'],
    ]) {
      const refused = await browser.get(`/api/me/company-documents/${id}/file`);
      assert.equal(refused.status, 404, id);
      assert.equal(refused.body.code, 'DOCUMENT_NOT_FOUND');
      assert.equal(refused.text.includes('Retired text'), false);
      assert.equal(refused.text.includes(lunaText), false);
    }
  });
});

test('company documents: 503 when the library or the bucket is unavailable or not configured', async () => {
  // A bucket that fails every read.
  const failing = {
    get: async () => {
      throw new Error('synthetic bucket outage');
    },
  };
  await withLibrary(
    async (app) => {
      const { ids, lumora } = await twoCompanies(app);
      const broken = await lumora.browser.get(`/api/me/company-documents/${ids.handbook}/file`);
      assert.deepEqual([broken.status, broken.body.code], [503, 'COMPANY_DOCUMENTS_UNAVAILABLE']);
      assert.equal(broken.text.includes('outage'), false);
      // The library (Firestore) failing: the list and the file are 503, without details.
      app.firestore.fail(14, { times: 2, match: /^companyDocuments/ });
      const list = await lumora.browser.get('/api/me/company-documents');
      assert.deepEqual([list.status, list.body.code], [503, 'COMPANY_DOCUMENTS_UNAVAILABLE']);
      assert.equal(list.text.includes('Injected failure'), false);
      const file = await lumora.browser.get(`/api/me/company-documents/${ids.handbook}/file`);
      assert.deepEqual([file.status, file.body.code], [503, 'COMPANY_DOCUMENTS_UNAVAILABLE']);
    },
    { companyDocumentFiles: failing },
  );
  // No DOCS_BUCKET: the list still works; the file is 503.
  const bucket = createMemoryCompanyDocumentFiles();
  await withApp(
    { companyDocumentSync: bucket.documentSync, companyDocumentFiles: null },
    async (app) => {
      const { ids, lumora } = await twoCompanies(app);
      assert.equal((await lumora.browser.get('/api/me/company-documents')).status, 200);
      const file = await lumora.browser.get(`/api/me/company-documents/${ids.forms}/file`);
      assert.deepEqual([file.status, file.body.code], [503, 'COMPANY_DOCUMENTS_UNAVAILABLE']);
    },
  );
});

test('company documents: HR, admin and signed-out requests get the existing role and session errors', async () => {
  await withLibrary(async (app) => {
    const { lumoraHr, ids, lumora } = await twoCompanies(app);
    await app.store.createAccount({
      username: 'ADMIN-0001',
      role: 'admin',
      passwordHash: await app.hashing.hash('admin-pass-1'),
      mustChangePassword: false,
      action: 'admin_created',
      at: app.clock.now(),
      companyId: null,
    });
    const admin = app.browser();
    assert.equal((await admin.signIn('ADMIN-0001', 'admin-pass-1')).status, 200);
    // The admin token sent as a company account cookie.
    const adminAsAccount = app.browser();
    adminAsAccount.cookies.set('onboardai_account', [...admin.cookies.values()][0]);
    const expired = lumora.browser.copy();
    await lumora.browser.post('/api/auth/sign-out');

    for (const [who, browser, status, code] of [
      ['hr', lumoraHr, 403, 'EMPLOYEE_ROLE_REQUIRED'],
      ['admin', admin, 401, 'AUTH_REQUIRED'],
      ['admin as account', adminAsAccount, 403, 'COMPANY_ACCOUNT_REQUIRED'],
      ['signed out', app.browser(), 401, 'AUTH_REQUIRED'],
      ['ended session', expired, 401, 'SESSION_EXPIRED'],
    ]) {
      // The same answer as another employee-only route.
      const reference = await browser.copy().get('/api/me/onboarding');
      assert.deepEqual([reference.status, reference.body.code], [status, code], who);
      for (const path of [
        '/api/me/company-documents',
        `/api/me/company-documents/${ids.handbook}/file`,
      ]) {
        const refused = await browser.copy().get(path);
        assert.deepEqual([refused.status, refused.body.code], [status, code], `${who} ${path}`);
        assert.equal(refused.text.includes('Company Handbook'), false);
      }
    }
  });
});

test('createCompanyDocumentFiles reads gs://DOCS_BUCKET/<object> with the api token; a missing object is 404, any other failure 503', async () => {
  assert.equal(createCompanyDocumentFiles({ env: {}, getAccessToken: async () => 't' }), null);
  const requests = [];
  let answer = () => new Response(Buffer.from('bytes'), { status: 200 });
  const files = createCompanyDocumentFiles({
    env: { DOCS_BUCKET: 'synthetic-docs' },
    getAccessToken: async () => 'synthetic-token',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return answer();
    },
  });
  assert.deepEqual(
    await files.get('companies/lumora/11111111-2222-4333-8444-555555555555/02 Handbook.pdf'),
    Buffer.from('bytes'),
  );
  assert.equal(
    requests[0].url,
    'https://storage.googleapis.com/storage/v1/b/synthetic-docs/o/companies%2Flumora%2F11111111-2222-4333-8444-555555555555%2F02%20Handbook.pdf?alt=media',
  );
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer synthetic-token');
  assert.ok(requests[0].init.signal);

  answer = () => new Response('gone', { status: 404 });
  await assert.rejects(files.get('x/y.txt'), { status: 404, code: 'DOCUMENT_NOT_FOUND' });
  for (const failure of [
    () => new Response('denied', { status: 403 }),
    () => new Response('oops', { status: 500 }),
    () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    answer = failure;
    await assert.rejects(files.get('x/y.txt'), {
      status: 503,
      code: 'COMPANY_DOCUMENTS_UNAVAILABLE',
    });
  }
  const noToken = createCompanyDocumentFiles({
    env: { DOCS_BUCKET: 'synthetic-docs' },
    getAccessToken: async () => {
      throw new Error('no credentials');
    },
    fetchImpl: async () => new Response('x'),
  });
  await assert.rejects(noToken.get('x/y.txt'), { status: 503 });
});

test('the default reader: an entry without objectName is read from the upload rule’s object name in DOCS_BUCKET', async () => {
  const reads = [];
  const bytes = pdf('Synthetic legacy handbook.');
  await withApp(
    {
      env: { DOCS_BUCKET: 'synthetic-docs' },
      fetchImpl: async (url) => {
        reads.push(url);
        return new Response(bytes, { status: 200 });
      },
    },
    async (app) => {
      const hr = await app.companyHrBrowser({ companyId: 'rimba', name: 'Rimba', prefix: 'RB' });
      const { browser } = await app.readyEmployee(hr);
      const id = '22222222-3333-4444-8555-666666666666';
      app.firestore.write(`companyDocuments/${id}`, {
        category: 'policies',
        title: 'Handbook',
        fileName: 'Handbook.pdf',
        status: 'active',
        companyId: 'rimba',
        connectedAt: '2026-10-23T13:49:00.000Z',
      });
      const listed = await browser.get('/api/me/company-documents');
      assert.deepEqual(listed.body.documents, [
        {
          id,
          title: 'Handbook',
          category: 'policies',
          fileName: 'Handbook.pdf',
          uploadedAt: '2026-10-23T13:49:00.000Z',
          viewUrl: `/api/me/company-documents/${id}/file`,
        },
      ]);
      const file = await fetch(`${app.url}/api/me/company-documents/${id}/file`, {
        headers: { cookie: browser.cookieHeader },
      });
      assert.equal(file.status, 200);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      assert.deepEqual(reads, [
        `https://storage.googleapis.com/storage/v1/b/synthetic-docs/o/${encodeURIComponent(`companies/rimba/${id}/Handbook.pdf`)}?alt=media`,
      ]);
    },
  );
});

test('the web service proxy streams the file with its headers', async () => {
  await withLibrary(async (app) => {
    const { ids, lumora } = await twoCompanies(app);
    const distDir = await mkdtemp(join(tmpdir(), 'web-proxy-docs-'));
    await writeFile(join(distDir, 'index.html'), '<!doctype html><title>OnboardAi</title>');
    const web = createWebApp({ apiUrl: app.url, distDir, env: {}, idTokenProvider: null }).listen(
      0,
      '127.0.0.1',
    );
    await once(web, 'listening');
    try {
      const webUrl = `http://127.0.0.1:${web.address().port}`;
      const listed = await fetch(`${webUrl}/api/me/company-documents`, {
        headers: { cookie: lumora.browser.cookieHeader },
      });
      assert.equal(listed.status, 200);
      const viewUrl = (await listed.json()).documents.find((d) => d.id === ids.handbook).viewUrl;
      const file = await fetch(webUrl + viewUrl, {
        headers: { cookie: lumora.browser.cookieHeader },
      });
      assert.equal(file.status, 200);
      const body = Buffer.from(await file.arrayBuffer());
      assert.deepEqual(body, pdf(handbookText));
      assert.equal(file.headers.get('content-type'), 'application/pdf');
      assert.equal(file.headers.get('content-length'), String(body.length));
      assert.equal(
        file.headers.get('content-disposition'),
        "inline; filename*=UTF-8''02%20Company%20Handbook.pdf",
      );
      assert.equal(file.headers.get('cache-control'), 'private, no-store');
      assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
      const other = await fetch(`${webUrl}/api/me/company-documents/${unknownId}/file`, {
        headers: { cookie: lumora.browser.cookieHeader },
      });
      assert.deepEqual([other.status, (await other.json()).code], [404, 'DOCUMENT_NOT_FOUND']);
    } finally {
      await new Promise((resolve) => web.close(resolve));
    }
  });
});
