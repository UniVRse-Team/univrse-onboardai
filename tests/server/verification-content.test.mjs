import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVerificationContent,
  createVerificationContentSource,
} from '../../server/verification-content.mjs';
import { publicVerificationContent } from '../../server/task-verification.mjs';

const question = {
  id: 'q1',
  prompt: 'Which is right?',
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
  correct: ['a'],
  explanation: 'Because A.',
};

test('approved content overrides the defaults and invalid parts are ignored', () => {
  const warnings = [];
  const content = buildVerificationContent(
    {
      policies: {
        'policies.data-protection': {
          title: 'Data',
          document: { title: 'Policy', url: 'https://example.com/p.pdf' },
          quiz: { questions: [question] },
        },
        'policies.responsible-ai': { title: 'AI' }, // no quiz: acknowledgement only
        'policies.broken': { title: 'x', quiz: { questions: [{ ...question, correct: ['zzz'] }] } },
        'other.key': { title: 'x' },
        'policies.badlink': { title: 'x', document: { title: 'd', url: 'http://insecure' } },
      },
      supportContacts: [{ name: 'IT', email: 'not-an-email', purpose: 'x' }],
      responsibilities: { default: ['Do a'], byDepartment: { Finance: ['Do b'] } },
    },
    (m) => warnings.push(m),
  );
  assert.equal(content.policies['policies.data-protection'].quiz.questions.length, 1);
  assert.equal(content.policies['policies.responsible-ai'].quiz, undefined);
  assert.equal(content.policies['policies.broken'], undefined);
  assert.equal(content.policies['other.key'], undefined);
  assert.equal(content.policies['policies.badlink'], undefined);
  assert.equal(warnings.length, 4);
  assert.deepEqual(content.responsibilities.byDepartment.Finance, ['Do b']);
  // the invalid contact list left the built-in directory in place
  assert.ok(content.directory.contacts.some((c) => c.email === 'it-help@company.example'));

  const view = publicVerificationContent(content);
  assert.equal(view.policies['policies.responsible-ai'].quiz, null);
  assert.equal(view.policies['policies.data-protection'].document.url, 'https://example.com/p.pdf');
  assert.ok(!JSON.stringify(view).includes('Because A'));
});

test('the content file is re-read when it changes and a missing file falls back to defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-'));
  const file = join(dir, 'content.json');
  const log = () => {};
  assert.ok(
    createVerificationContentSource({ env: {}, log })().policies['policies.data-protection'],
  );
  assert.ok(
    createVerificationContentSource({
      env: { VERIFICATION_CONTENT_FILE: join(dir, 'none.json') },
      log,
    })().policies['policies.data-protection'],
  );
  writeFileSync(file, JSON.stringify({ responsibilities: { default: ['One'] } }));
  const source = createVerificationContentSource({ env: { VERIFICATION_CONTENT_FILE: file }, log });
  assert.deepEqual(source().responsibilities.default, ['One']);
  writeFileSync(file, '{ not json');
  assert.ok(source().responsibilities.default.length > 0);
});

import { createTaskVerificationStore } from '../../server/task-verification.mjs';
import { FakeFirestore } from './fake-firestore.mjs';

test('records persist in Firestore across store instances, and a failing Firestore is an error, not memory', async () => {
  const db = new FakeFirestore();
  const first = createTaskVerificationStore({ firestore: db, log: () => {} });
  await first.saveVerification('acc-1', (v) => ({
    ...v,
    policies: { a: { acknowledgedAt: 'now' } },
  }));
  // a new store (a server restart) with the same database still sees it
  const second = createTaskVerificationStore({ firestore: () => db, log: () => {} });
  assert.equal(
    (await second.getVerifications('acc-1')).verifications.policies.a.acknowledgedAt,
    'now',
  );
  assert.deepEqual((await second.getVerifications('acc-2')).verifications, {});

  const broken = createTaskVerificationStore({
    firestore: {
      collection: () => {
        throw new Error('unavailable');
      },
      runTransaction: async () => {
        throw new Error('unavailable');
      },
    },
    log: () => {},
  });
  await assert.rejects(
    () => broken.getVerifications('acc-1'),
    (e) => e.status === 503 && e.code === 'VERIFICATION_STORAGE_UNAVAILABLE',
  );
  await assert.rejects(
    () => broken.saveVerification('acc-1', (v) => v),
    (e) => e.status === 503,
  );
});
