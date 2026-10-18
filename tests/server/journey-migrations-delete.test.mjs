// The first Firestore migrations (seeded templates and chips) and the employee
// delete cascade for the onboarding journey (issues #47-#50). In-memory
// Firestore fake, pg-mem and synthetic people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeFirestore } from './fake-firestore.mjs';
import { startAccountsApp, syntheticProfile } from './account-harness.mjs';
import { firestoreMigrationFiles, migrateFirestore } from '../../server/firestore-migrations.mjs';
import { builtInQuickQuestions, builtInTemplate } from '../../server/onboarding-content.mjs';
import { up as seedTemplates } from '../../server/migrations/firestore/001_onboarding_templates.mjs';
import { up as seedChips } from '../../server/migrations/firestore/002_quick_questions.mjs';

test('the journey migrations seed templates and chips once, and re-running changes nothing', async () => {
  assert.deepEqual(firestoreMigrationFiles().slice(0, 2), [
    '001_onboarding_templates.mjs',
    '002_quick_questions.mjs',
  ]);
  const firestore = new FakeFirestore();
  const lines = [];
  const first = await migrateFirestore(firestore, { log: (line) => lines.push(line) });
  assert.deepEqual(first.applied.slice(0, 2), [
    '001_onboarding_templates.mjs',
    '002_quick_questions.mjs',
  ]);
  assert.deepEqual(firestore.paths('onboardingTemplates/'), [
    'onboardingTemplates/contractor',
    'onboardingTemplates/employee',
    'onboardingTemplates/intern',
    'onboardingTemplates/starter.contractor',
    'onboardingTemplates/starter.employee',
    'onboardingTemplates/starter.intern',
  ]);
  for (const track of ['employee', 'intern', 'contractor'])
    assert.deepEqual(firestore.read(`onboardingTemplates/${track}`), builtInTemplate(track));
  assert.deepEqual(firestore.read('config/quickQuestions'), builtInQuickQuestions());
  assert.ok(lines.includes('onboarding templates: 3 created, 0 already present'), lines.join('\n'));
  assert.ok(lines.includes('quick questions: created'));
  // Log lines carry counts only, never template text.
  assert.ok(lines.every((line) => !line.includes('employment contract')));

  // A second run skips both files.
  const second = await migrateFirestore(firestore, { log: () => {} });
  assert.deepEqual(second.applied, []);
  // Re-running the files themselves (a retry after a partial failure) keeps
  // what is there, including a later edit.
  const edited = builtInTemplate('employee');
  edited.areas[0].steps[0].title = 'Edited by HR';
  firestore.write('onboardingTemplates/employee', edited);
  await firestore.collection('onboardingTemplates').doc('intern').delete();
  const rerun = [];
  await seedTemplates({ firestore, log: (line) => rerun.push(line) });
  await seedChips({ firestore, log: (line) => rerun.push(line) });
  assert.deepEqual(rerun, [
    'onboarding templates: 1 created, 2 already present',
    'quick questions: already present',
  ]);
  assert.equal(
    firestore.read('onboardingTemplates/employee').areas[0].steps[0].title,
    'Edited by HR',
  );
  assert.deepEqual(firestore.read('onboardingTemplates/intern'), builtInTemplate('intern'));
});

test('the server reads the seeded documents exactly as the built-in fallback would answer', async () => {
  const app = await startAccountsApp();
  try {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const fallback = (await browser.get('/api/me/onboarding')).body;
    const chips = (await browser.get('/api/me/quick-questions')).body;
    await migrateFirestore(app.firestore, { log: () => {} });
    assert.deepEqual((await browser.get('/api/me/onboarding')).body, fallback);
    assert.deepEqual((await browser.get('/api/me/quick-questions')).body, chips);
  } finally {
    await app.close();
  }
});

test('deleting an employee deletes their progress, first-day details and support requests; gaps stay', async () => {
  const app = await startAccountsApp({ mode: 'gemini-chat' });
  try {
    const hr = await app.hrBrowser();
    const setUp = async (name) => {
      const { employee, browser } = await app.readyEmployee(hr, {
        profile: syntheticProfile(name),
      });
      const id = employee.account.id;
      // The briefing (v1.5) lives in the same progress document.
      await browser.post('/api/me/onboarding/steps/alignment.mission-values/briefing', {
        completion: 'listened',
      });
      await browser.post('/api/me/onboarding/steps/alignment.mission-values/complete');
      assert.equal(
        app.firestore.read(`onboardingProgress/${id}`).steps['alignment.mission-values'].briefedBy,
        'listened',
      );
      await hr.put(`/api/hr/employees/${id}/first-day`, {
        location: 'Reception',
        arrivalTime: '09:00',
        hostName: 'Riley Host',
      });
      const chat = (await browser.post('/api/conversations')).body;
      for (let i = 0; i < 2; i++) {
        const requestId = randomUUID();
        await browser.post('/api/chat', {
          question: `What should I wear, part ${i}?`,
          taskId: 'quiz-part-1',
          conversationId: chat.id,
          requestId,
        });
        const made = await browser.post('/api/me/support-requests', {
          conversationId: chat.id,
          messageId: requestId + '-a',
        });
        assert.equal(made.status, 201);
      }
      return id;
    };
    const gone = await setUp('Avery Example');
    const kept = await setUp('Blake Sample');
    app.firestore.write('knowledgeGaps/synthetic-gap', {
      questionRedacted: 'Where do I park?',
      topic: 'parking',
      track: 'employee',
      nearestSource: null,
      createdDay: '2026-10-15',
    });
    const requestsOf = (id) =>
      app.firestore
        .paths('supportRequests/')
        .filter((path) => app.firestore.read(path).accountId === id);
    assert.equal(requestsOf(gone).length, 2);

    const deleted = await hr.delete(`/api/hr/employees/${gone}`);
    assert.equal(deleted.status, 204);
    assert.deepEqual(app.firestore.paths(`onboardingProgress/${gone}`), []);
    assert.deepEqual(app.firestore.paths(`employeeFirstDay/${gone}`), []);
    assert.deepEqual(requestsOf(gone), []);
    // The other employee's data and the anonymous gaps stay.
    assert.deepEqual(app.firestore.paths(`onboardingProgress/${kept}`), [
      `onboardingProgress/${kept}`,
    ]);
    assert.deepEqual(app.firestore.paths(`employeeFirstDay/${kept}`), [`employeeFirstDay/${kept}`]);
    assert.equal(requestsOf(kept).length, 2);
    assert.deepEqual(app.firestore.paths('knowledgeGaps/'), ['knowledgeGaps/synthetic-gap']);
    // HR's list no longer shows the deleted employee's requests.
    const listed = (await hr.get('/api/hr/support-requests')).body;
    assert.equal(listed.requests.length, 2);
    assert.ok(listed.requests.every((r) => r.employee.id === kept));
    // A retry is safe.
    assert.equal((await hr.delete(`/api/hr/employees/${gone}`)).status, 404);
  } finally {
    await app.close();
  }
});
