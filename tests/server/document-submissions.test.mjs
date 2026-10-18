import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startAccountsApp } from './account-harness.mjs';
import {
  createMemorySubmissionFiles,
  createSubmissionFiles,
} from '../../server/submission-files.mjs';
import { validateSubmissionFile } from '../../server/document-submissions.mjs';
import { createApiProxy } from '../../server/api-proxy.mjs';
import { maxFileBytes } from '../../shared/document-submissions.mjs';
import { pdf, docx } from './document-fixtures.mjs';
const path = '/api/me/document-submissions';
const hrPath = '/api/hr/document-submissions';
const content = pdf('Synthetic employee submission. Not a real document.');
const upload = (browser, extra = {}) =>
  browser.upload(
    path +
      '?' +
      new URLSearchParams({ type: 'Employment Documents', title: 'Signed agreement', ...extra }),
    content,
    'agreement.pdf',
  );

test('employee uploads, HR reviews, owner reads remarks, resubmits; other employee cannot read or download', async () => {
  const app = await startAccountsApp({ submissionFiles: createMemorySubmissionFiles() });
  try {
    const hr = await app.hrBrowser();
    const owner = await app.readyEmployee(hr);
    const other = await app.readyEmployee(hr);
    assert.equal((await upload(app.browser())).status, 401);
    assert.equal((await upload(hr)).status, 403);
    const created = await upload(owner.browser, { employeeName: 'Spoofed', employeeId: 'OTHER' });
    assert.equal(created.status, 201, created.text);
    const item = created.body.submission;
    assert.equal(item.employeeId, owner.employee.account.username);
    assert.notEqual(item.employeeName, 'Spoofed');
    assert.equal((await owner.browser.get(path)).body.available, true);
    assert.equal((await other.browser.get(path)).body.submissions.length, 0);
    for (const suffix of ['', '/file'])
      assert.equal((await other.browser.get(`${path}/${item.id}${suffix}`)).status, 404);
    assert.equal((await owner.browser.get(hrPath)).status, 403);
    assert.equal((await hr.get(hrPath)).body.submissions.length, 1);
    const download = await owner.browser.get(`${path}/${item.id}/file`);
    assert.equal(download.status, 200);
    assert.match(download.text, /%PDF/);
    assert.equal(
      (await hr.patch(`${hrPath}/${item.id}`, { status: 'Rejected', remarks: '', revision: 1 }))
        .status,
      400,
    );
    const rejected = await hr.patch(`${hrPath}/${item.id}`, {
      status: 'Rejected',
      remarks: 'Please include all pages.',
      revision: 1,
    });
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(
      (await owner.browser.get(`${path}/${item.id}`)).body.submission.remarks,
      'Please include all pages.',
    );
    assert.equal(
      (await hr.patch(`${hrPath}/${item.id}`, { status: 'Approved', revision: 1 })).status,
      409,
    );
    const newCopy = await upload(owner.browser, { resubmissionOf: item.id });
    assert.equal(newCopy.status, 201, newCopy.text);
    assert.equal(newCopy.body.submission.status, 'Pending Review');
    assert.equal(newCopy.body.submission.resubmissionOf, item.id);
    assert.equal((await owner.browser.get(path)).body.submissions.length, 2);
    assert.equal((await upload(other.browser, { resubmissionOf: item.id })).status, 404);
    const erased = await hr.delete('/api/hr/employees/' + owner.employee.account.id);
    assert.equal(erased.status, 204, erased.text);
    assert.equal((await hr.get(hrPath)).body.submissions.length, 0);
  } finally {
    await app.close();
  }
});

test('file validation rejects spoofed, empty, oversized, invalid and dangerous names; scanned PDFs remain allowed', async () => {
  for (const [name, bytes] of [
    ['fake.pdf', Buffer.from('not pdf')],
    ['fake.png', content],
    ['x.svg', content],
    ['empty.pdf', Buffer.alloc(0)],
    ['large.pdf', Buffer.alloc(25 * 1024 * 1024 + 1)],
    ['../x.pdf', content],
    ['x.docx', Buffer.from('PK not a document')],
  ])
    await assert.rejects(() => validateSubmissionFile(name, bytes));
  assert.equal(await validateSubmissionFile('scan.pdf', pdf('')), 'application/pdf');
  assert.match(
    await validateSubmissionFile('document.docx', docx('Employee document')),
    /wordprocessingml/,
  );
});

test('unconfigured private storage reports available: false and never reports a successful upload', async () => {
  const app = await startAccountsApp();
  try {
    const hr = await app.hrBrowser();
    const employee = await app.readyEmployee(hr);
    const listing = await employee.browser.get(path);
    assert.equal(listing.body.available, false);
    assert.equal(listing.body.submissions.length, 0);
    assert.equal((await upload(employee.browser)).status, 503);
  } finally {
    await app.close();
  }
});

test('private GCS adapter never uses the knowledge bucket or search index and authenticates all file requests', async () => {
  assert.equal(createSubmissionFiles({ env: {} }), null);
  assert.equal(
    createSubmissionFiles({ env: { DOCS_BUCKET: 'same', EMPLOYEE_DOCUMENTS_BUCKET: 'same' } }),
    null,
  );
  const calls = [];
  const files = createSubmissionFiles({
    env: { EMPLOYEE_DOCUMENTS_BUCKET: 'private-test' },
    getAccessToken: async () => 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(content, { status: 200 });
    },
  });
  await files.put('id', content, 'application/pdf');
  assert.deepEqual(await files.get('id'), content);
  await files.remove('id');
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (c) =>
        c.url.startsWith('https://storage.googleapis.com/') &&
        c.options.headers.Authorization === 'Bearer test-token',
    ),
  );
  assert.match(calls[0].url, /ifGenerationMatch=0/);
});

test('dashboard uploads bind to an actual documentation step and resubmissions cannot move steps', async () => {
  const app = await startAccountsApp({ submissionFiles: createMemorySubmissionFiles() });
  try {
    const hr = await app.hrBrowser();
    const owner = await app.readyEmployee(hr);
    for (const stepId of ['documentation.missing', 'orientation.company']) {
      assert.equal((await upload(owner.browser, { stepId })).status, 400);
    }
    const created = await upload(owner.browser, {
      stepId: 'documentation.employee-information-form',
      title: 'Spoofed title',
    });
    assert.equal(created.status, 201, created.text);
    const record = created.body.submission;
    assert.equal(record.stepId, 'documentation.employee-information-form');
    assert.notEqual(record.title, 'Spoofed title');
    assert.equal(record.title, record.stepTitle);
    await hr.patch(`${hrPath}/${record.id}`, {
      status: 'Rejected',
      remarks: 'Please sign all pages.',
      revision: 1,
    });
    assert.equal(
      (
        await upload(owner.browser, {
          stepId: 'documentation.personal-bank-details',
          resubmissionOf: record.id,
        })
      ).status,
      400,
    );
    assert.equal((await upload(owner.browser, { resubmissionOf: record.id })).status, 400);
    const corrected = await upload(owner.browser, {
      stepId: record.stepId,
      resubmissionOf: record.id,
    });
    assert.equal(corrected.status, 201, corrected.text);
    assert.equal(corrected.body.submission.stepId, record.stepId);
    assert.equal(corrected.body.submission.status, 'Pending Review');
  } finally {
    await app.close();
  }
});

const stepStatus = async (browser, stepId) =>
  (await browser.get('/api/me/onboarding')).body.areas
    .find((a) => a.id === 'documentation')
    .steps.find((s) => s.id === stepId);
const uploadStep = (browser, stepId, name = 'doc.pdf') =>
  browser.upload(
    path + '?' + new URLSearchParams({ type: 'Employment Documents', title: 'Doc', stepId }),
    content,
    name,
  );

test('a failed upload or save never changes a step or its progress', async () => {
  const files = createMemorySubmissionFiles();
  const app = await startAccountsApp({ submissionFiles: files });
  try {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const stepId = 'documentation.employee-information-form';
    // The file store fails: nothing is submitted.
    const put = files.put;
    files.put = async () => {
      throw new Error('storage down');
    };
    const failed = await uploadStep(browser, stepId);
    assert.ok(failed.status >= 400, failed.text);
    files.put = put;
    assert.equal((await browser.get(path)).body.submissions.length, 0);
    assert.equal((await stepStatus(browser, stepId)).status, 'todo');
    // A file the server rejects (wrong content for its type) changes nothing.
    const bad = await browser.upload(
      path + '?' + new URLSearchParams({ type: 'Employment Documents', title: 'x', stepId }),
      Buffer.from('not a pdf'),
      'fake.pdf',
    );
    assert.ok(bad.status >= 400);
    assert.equal((await stepStatus(browser, stepId)).status, 'todo');
    const onboarding = (await browser.get('/api/me/onboarding')).body;
    assert.deepEqual([onboarding.percent, onboarding.waitingOnHr], [0, 0]);
  } finally {
    await app.close();
  }
});

test('a saved document completes its task, a lost sync heals, and saved progress is never reset', async () => {
  const app = await startAccountsApp({ submissionFiles: createMemorySubmissionFiles() });
  try {
    const hr = await app.hrBrowser();
    const { browser, employee } = await app.readyEmployee(hr);
    const id = employee.account.id;
    const stepId = 'documentation.employee-information-form';
    const progress = `onboardingProgress/${id}`;
    const writeStep = (status, source) => {
      const current = app.firestore.read(progress) || { accountId: id, steps: {} };
      app.firestore.write(progress, {
        ...current,
        steps: {
          ...current.steps,
          [stepId]: { status, source, updatedAt: new Date().toISOString() },
        },
      });
    };
    const onboarding = async () => (await browser.get('/api/me/onboarding')).body;
    // A brand-new employee: 0% in Documentation and every task to do. Reading changes nothing.
    const fresh = await onboarding();
    const documentation = fresh.areas.find((a) => a.id === 'documentation');
    assert.deepEqual([documentation.percent, documentation.done], [0, 0]);
    assert.ok(documentation.steps.every((s) => s.status === 'todo'));
    assert.equal(app.firestore.read(progress), undefined);
    // Saved progress from before (an HR verification, or a step waiting on HR) stands.
    writeStep('done', 'hr');
    assert.equal((await stepStatus(browser, stepId)).status, 'done');
    writeStep('submitted', 'employee');
    assert.equal((await stepStatus(browser, stepId)).status, 'submitted');
    writeStep('todo', 'employee');
    // A saved document completes its task; a lost sync is applied on the next read.
    const uploaded = await uploadStep(browser, stepId);
    assert.equal(uploaded.status, 201);
    writeStep('todo', 'employee'); // the sync after the upload was lost
    assert.equal((await stepStatus(browser, stepId)).status, 'done');
    // A later HR review changes nothing for the employee.
    await hr.patch(`${hrPath}/${uploaded.body.submission.id}`, {
      status: 'Rejected',
      remarks: 'Blurry.',
      revision: 1,
    });
    assert.equal((await stepStatus(browser, stepId)).status, 'done');
  } finally {
    await app.close();
  }
});

test('only HR reviews, and the review states are one-way; none of it moves the employee step', async () => {
  const app = await startAccountsApp({ submissionFiles: createMemorySubmissionFiles() });
  try {
    const hr = await app.hrBrowser();
    const owner = await app.readyEmployee(hr);
    const other = await app.readyEmployee(hr);
    const created = await uploadStep(owner.browser, 'documentation.employee-information-form');
    const target = `${hrPath}/${created.body.submission.id}`;
    for (const browser of [owner.browser, other.browser, app.browser()]) {
      const refused = await browser.patch(target, { status: 'Approved', revision: 1 });
      assert.ok([401, 403].includes(refused.status), String(refused.status));
    }
    const done = async () =>
      (await stepStatus(owner.browser, 'documentation.employee-information-form')).status;
    assert.equal(await done(), 'done'); // saved = submitted
    assert.equal((await hr.patch(target, { status: 'Under Review', revision: 1 })).status, 200);
    const rejected = await hr.patch(target, {
      status: 'Rejected',
      remarks: 'Blurry.',
      revision: 2,
    });
    assert.equal(rejected.body.submission.reviewedBy.length > 0, true);
    assert.equal(await done(), 'done');
    assert.equal((await hr.patch(target, { status: 'Approved', revision: 3 })).status, 409);
    // Another employee's step is untouched.
    assert.equal(
      (await stepStatus(other.browser, 'documentation.employee-information-form')).status,
      'todo',
    );
  } finally {
    await app.close();
  }
});

test('the web proxy forwards employee document submissions up to 25 MB and keeps 413 FILE_TOO_LARGE', async () => {
  const seen = [];
  const proxy = createApiProxy({
    apiUrl: 'https://api.example',
    fetchImpl: async (url, init) => {
      seen.push([url, init.body?.length]);
      return new Response(JSON.stringify({ submission: { id: 'sub-1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const web = express().use('/api', proxy);
  const server = await new Promise((resolve) => {
    const listening = web.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const targetUrl = `http://127.0.0.1:${server.address().port}${path}?type=Employment+Documents&title=Upload+your+Employee+Information+Form&stepId=documentation.employee-information-form`;
  const post = (size, type = 'application/octet-stream') =>
    fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': type, 'X-File-Name': 'info.pdf' },
      body: Buffer.alloc(size, 'x'),
    });
  try {
    const issueSize = 143 * 1024;
    const okIssue = await post(issueSize);
    assert.equal(okIssue.status, 201);
    assert.deepEqual(seen, [
      [
        `https://api.example${path}?type=Employment+Documents&title=Upload+your+Employee+Information+Form&stepId=documentation.employee-information-form`,
        issueSize,
      ],
    ]);

    const maxOk = await post(maxFileBytes);
    assert.equal(maxOk.status, 201);

    const big = await post(maxFileBytes + 1);
    assert.deepEqual([big.status, (await big.json()).code], [413, 'FILE_TOO_LARGE']);

    const json = await post(70 * 1024, 'application/json');
    assert.deepEqual([json.status, (await json.json()).code], [413, 'REQUEST_TOO_LARGE']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
