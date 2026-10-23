// Issue #126: the onboarding journey follows the employee's company. Luna
// Digital (and the univrse alias) keep the built-in template and chips; every
// other company gets onboardingTemplates/starter.<track> and the starter chips,
// in the employee's own views and in HR's views of that employee. pg-mem, the
// in-memory Firestore fake and synthetic people and companies only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccountsApp, syntheticProfile } from './account-harness.mjs';
import { FakeFirestore } from './fake-firestore.mjs';
import { createOnboardingJourney } from '../../server/onboarding-journey.mjs';
import { createMemorySubmissionFiles } from '../../server/submission-files.mjs';
import {
  builtInQuickQuestions,
  builtInTemplate,
  starterQuickQuestions,
  starterTemplate,
  starterTemplateVersion,
  stepQuestions,
  templateVersion,
} from '../../server/onboarding-content.mjs';
import { pdf } from './document-fixtures.mjs';

const stepIds = (template) => template.areas.flatMap((area) => area.steps.map((step) => step.id));
const viewStepIds = (onboarding) =>
  onboarding.areas.flatMap((area) => area.steps.map((step) => step.id));
const stepTitle = (onboarding, id) =>
  onboarding.areas.flatMap((area) => area.steps).find((step) => step.id === id)?.title;
const chipIds = async (browser, query = '') =>
  (await browser.get(`/api/me/quick-questions${query}`)).body.chips.map((chip) => chip.id);
const lunaOnly = Object.freeze(['working-hours', 'dress-code', 'company-background']);

async function withApp(options, check) {
  const app = await startAccountsApp(options);
  try {
    await check(app);
  } finally {
    await app.close();
  }
}

// A starter company's HR, and one of its employees signed in.
async function starterEmployee(app, companyId, prefix, profile = syntheticProfile()) {
  const hr = await app.companyHrBrowser({ companyId, name: `Synthetic ${companyId}`, prefix });
  const { employee, browser } = await app.readyEmployee(hr, { profile });
  return { hr, employee, browser };
}

test('template choice per company: luna-digital gets the built-in checklist, lumora, demo-seri-bayu-digital and rimba the starter one', async () => {
  await withApp({}, async (app) => {
    const lunaHr = await app.hrBrowser();
    const luna = await app.readyEmployee(lunaHr);
    const lunaView = await luna.browser.get('/api/me/onboarding');
    assert.equal(lunaView.status, 200, lunaView.text);
    assert.deepEqual(viewStepIds(lunaView.body), stepIds(builtInTemplate('employee')));
    assert.ok(viewStepIds(lunaView.body).includes('policies.employee-handbook'));

    for (const [companyId, prefix] of [
      ['lumora', 'LU'],
      ['demo-seri-bayu-digital', 'SB'],
      ['rimba', 'RB'],
    ]) {
      const { browser } = await starterEmployee(app, companyId, prefix);
      const view = await browser.get('/api/me/onboarding');
      assert.equal(view.status, 200, view.text);
      assert.deepEqual(viewStepIds(view.body), stepIds(starterTemplate('employee')), companyId);
      assert.equal(
        stepTitle(view.body, 'policies.company-rules'),
        'Company rules and workplace expectations',
      );
      assert.equal(stepTitle(view.body, 'policies.employee-handbook'), undefined);
      assert.equal(view.body.nextStep.id, 'documentation.contract');
    }
  });
});

test('the stored starter.<track> template is read for starter companies and onboardingTemplates/<track> for Luna Digital, each by its own version', async () => {
  await withApp({}, async (app) => {
    // Stored versions: starter v1 is current for the starter pack (it is
    // below the built-in version 9, which only Luna Digital's must reach).
    const starter = starterTemplate('employee');
    starter.areas[1].steps[0].title = 'Stored starter rules';
    app.firestore.write('onboardingTemplates/starter.employee', starter);
    const built = builtInTemplate('employee');
    built.areas[1].steps[0].title = 'Stored Luna handbook';
    app.firestore.write('onboardingTemplates/employee', built);

    const luna = await app.readyEmployee(await app.hrBrowser());
    const { browser } = await starterEmployee(app, 'lumora', 'LU');
    const lunaView = (await luna.browser.get('/api/me/onboarding')).body;
    const lumoraView = (await browser.get('/api/me/onboarding')).body;
    assert.equal(stepTitle(lunaView, 'policies.employee-handbook'), 'Stored Luna handbook');
    assert.equal(stepTitle(lumoraView, 'policies.company-rules'), 'Stored starter rules');
    assert.equal(starterTemplateVersion < templateVersion, true);

    // An older stored version falls back to its own pack's built-in content.
    app.firestore.write('onboardingTemplates/starter.employee', { ...starter, version: 0 });
    app.firestore.write('onboardingTemplates/employee', { ...built, version: templateVersion - 1 });
    assert.equal(
      stepTitle((await browser.get('/api/me/onboarding')).body, 'policies.company-rules'),
      'Company rules and workplace expectations',
    );
    assert.equal(
      stepTitle((await luna.browser.get('/api/me/onboarding')).body, 'policies.employee-handbook'),
      builtInTemplate('employee').areas[1].steps[0].title,
    );
    assert.ok(
      app.logs.some((line) =>
        /template starter\.employee is version 0; the built-in version 1/.test(line),
      ),
    );

    // A malformed starter template falls back to the starter pack, never to Luna's.
    app.firestore.write('onboardingTemplates/starter.employee', { areas: [] });
    assert.deepEqual(
      viewStepIds((await browser.get('/api/me/onboarding')).body),
      stepIds(starterTemplate('employee')),
    );
    assert.ok(app.logs.some((line) => /template is malformed \(starter\.employee\)/.test(line)));
  });
});

test('the template cache is keyed by document id: the packs never share an entry, and starter companies share starter.<track>', async () => {
  const firestore = new FakeFirestore();
  const starter = starterTemplate('intern');
  starter.areas[0].steps[0].title = 'Stored intern agreement';
  firestore.write('onboardingTemplates/starter.intern', starter);
  const journey = createOnboardingJourney({ firestore, accounts: {}, cacheMs: 60000 });

  const luna = await journey.template('luna-digital', 'intern');
  const lumora = await journey.template('lumora', 'intern');
  assert.deepEqual(stepIds(luna), stepIds(builtInTemplate('intern')));
  assert.equal(lumora.areas[0].steps[0].title, 'Stored intern agreement');
  assert.equal(firestore.calls.get, 2);
  // Cached: the same entries again, and another starter company reads nothing new.
  assert.equal(await journey.template('luna-digital', 'intern'), luna);
  assert.equal(await journey.template('rimba', 'intern'), lumora);
  assert.equal(firestore.calls.get, 2);
  // The univrse alias and a missing company are Luna Digital's pack.
  assert.equal(await journey.template('univrse', 'intern'), luna);
  assert.equal(await journey.template(undefined, 'intern'), luna);
  assert.equal(await journey.template(null, 'intern'), luna);
  assert.equal(firestore.calls.get, 2);
  // Another track is its own entry.
  assert.deepEqual(
    stepIds(await journey.template('lumora', 'contractor')),
    stepIds(starterTemplate('contractor')),
  );
  assert.equal(firestore.calls.get, 3);
});

test('HR views of a starter-company employee use the starter template: detail, list percent, verification and step changes', async () => {
  await withApp({}, async (app) => {
    const { hr, employee, browser } = await starterEmployee(app, 'lumora', 'LU');
    const id = employee.account.id;

    const detail = await hr.get(`/api/hr/employees/${id}/onboarding`);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual(viewStepIds(detail.body), stepIds(starterTemplate('employee')));

    // An hr_verify step that exists only in the starter template.
    const verified = await hr.patch(
      `/api/hr/employees/${id}/onboarding/steps/documentation.emergency-contact`,
      { status: 'done' },
    );
    assert.equal(verified.status, 200, verified.text);
    assert.equal(
      verified.body.areas[0].steps.find((s) => s.id === 'documentation.emergency-contact').status,
      'done',
    );
    // Luna Digital's steps are not this employee's.
    const foreign = await hr.patch(
      `/api/hr/employees/${id}/onboarding/steps/documentation.employee-information-form`,
      { status: 'done' },
    );
    assert.deepEqual([foreign.status, foreign.body.code], [404, 'STEP_NOT_FOUND']);

    // The employee's own completion of a starter step counts in HR's list.
    app.briefAll(id, { companyId: 'lumora' });
    const done = await browser.post('/api/me/onboarding/steps/policies.company-rules/complete');
    assert.equal(done.status, 200, done.text);
    const listed = await hr.get('/api/hr/employees');
    assert.equal(listed.status, 200, listed.text);
    const item = listed.body.employees.find((e) => e.account.id === id);
    const mine = (await browser.get('/api/me/onboarding')).body;
    assert.ok(item.onboarding.percent > 0);
    assert.equal(item.onboarding.percent, mine.percent);
    assert.equal(item.onboarding.waitingOnHr, mine.waitingOnHr);
    // HR sees the same view of the employee as the employee does.
    assert.deepEqual((await hr.get(`/api/hr/employees/${id}/onboarding`)).body.areas, mine.areas);
  });
});

test('a starter employee’s document upload completes their starter documentation step at once', async () => {
  await withApp({ submissionFiles: createMemorySubmissionFiles() }, async (app) => {
    const { employee, browser } = await starterEmployee(app, 'lumora', 'LU');
    const uploaded = await browser.upload(
      '/api/me/document-submissions?' +
        new URLSearchParams({
          type: 'Employment Documents',
          title: 'Signed contract',
          stepId: 'documentation.contract',
        }),
      pdf('Synthetic signed contract'),
      'contract.pdf',
    );
    assert.equal(uploaded.status, 201, uploaded.text);
    // Written by the submission's sync (its company's template), before any read.
    const progress = app.firestore.read(`onboardingProgress/${employee.account.id}`);
    assert.equal(progress.steps['documentation.contract'].status, 'done');
  });
});

test('quick questions per pack: a starter employee never gets Luna Digital’s chips or related questions', async () => {
  await withApp({}, async (app) => {
    const lunaHr = await app.hrBrowser();
    const luna = { hr: lunaHr, ...(await app.readyEmployee(lunaHr)) };
    const { hr, browser } = await starterEmployee(app, 'lumora', 'LU');

    // Before the start date: the next step's own question, then the personal chips.
    assert.deepEqual(await chipIds(browser), [
      'step:documentation.contract',
      'day-one-arrival',
      'day-one-host',
    ]);
    // A task's chips: its own question only (Luna's related questions are not offered).
    assert.ok(stepQuestions['documentation.personal-bank-details'].length > 0);
    const task = await browser.get(
      '/api/me/quick-questions?stepId=documentation.personal-bank-details',
    );
    assert.deepEqual(task.body.chips, [
      {
        id: 'step:documentation.personal-bank-details',
        label: 'What personal and bank details do I need to submit?',
        question: 'What personal and bank details do I need to submit?',
        kind: 'knowledge',
        stepId: 'documentation.personal-bank-details',
      },
    ]);
    // Luna Digital's employee keeps its own task's related questions.
    assert.equal(
      (await chipIds(luna.browser, '?stepId=documentation.employee-information-form')).length,
      3,
    );

    // After the start date (a colleague who started earlier): the starter
    // knowledge chips, the starter steps' own questions; a general chip
    // repeating the next step's question is skipped.
    const earlier = syntheticProfile('Blake Example');
    earlier.job.startDate = '2026-09-01';
    const started = await app.readyEmployee(hr, { profile: earlier });
    assert.deepEqual(await chipIds(started.browser), [
      'step:documentation.contract',
      'company-overview',
      'company-rules',
    ]);
    for (const step of ['contract', 'personal-bank-details', 'tax-id-documents'])
      assert.equal(
        (
          await hr.patch(
            `/api/hr/employees/${started.employee.account.id}/onboarding/steps/documentation.${step}`,
            { status: 'done' },
          )
        ).status,
        200,
      );
    assert.deepEqual(await chipIds(started.browser), [
      'step:policies.company-rules',
      'company-overview',
      'who-to-ask',
    ]);
    for (const id of [...(await chipIds(browser)), ...(await chipIds(started.browser))])
      assert.equal(lunaOnly.includes(id), false);
    // Luna Digital's employee who has started still gets Luna's general chips.
    const lunaStarted = syntheticProfile('Casey Example');
    lunaStarted.job.startDate = '2026-09-01';
    const lunaColleague = await app.readyEmployee(luna.hr, { profile: lunaStarted });
    assert.ok((await chipIds(lunaColleague.browser)).some((id) => lunaOnly.includes(id)));
  });
});

test('starter chips: built from the starter steps’ questions, configurable as config/quickQuestions["starter.<track>"], resolved per company', async () => {
  const firestore = new FakeFirestore();
  const profile = { job: { track: 'contractor', startDate: '2026-11-02' } };
  const accounts = { myProfile: async () => profile };
  const journey = createOnboardingJourney({
    firestore,
    accounts,
    cacheMs: 0,
    now: () => new Date('2026-12-01T01:00:00Z'),
  });
  const lumora = { id: 'a1', role: 'employee', companyId: 'lumora' };
  const luna = { id: 'a2', role: 'employee', companyId: 'luna-digital' };

  const chips = starterQuickQuestions().contractor;
  const asked = starterTemplate('contractor')
    .areas.flatMap((area) => area.steps)
    .map((step) => step.askAlya);
  for (const chip of chips.filter((c) => c.kind === 'knowledge'))
    assert.ok(asked.includes(chip.question), chip.id);
  assert.deepEqual(
    chips.filter((c) => c.kind === 'personal').map((c) => c.id),
    ['day-one-arrival', 'day-one-host'],
  );

  // Each company resolves only its own pack's chips.
  assert.equal((await journey.resolveChip(lumora, 'company-rules')).id, 'company-rules');
  assert.equal(await journey.resolveChip(lumora, 'dress-code'), null);
  assert.equal(await journey.resolveChip(luna, 'company-rules'), null);
  assert.equal((await journey.resolveChip(luna, 'dress-code')).id, 'dress-code');
  assert.equal(
    (await journey.resolveChip(lumora, 'step:policies.company-rules')).stepId,
    'policies.company-rules',
  );
  assert.equal(await journey.resolveChip(lumora, 'step:policies.employee-handbook'), null);

  // A stored starter list replaces the built-in one for starter companies only;
  // Luna Digital's stored list stays its own.
  firestore.write('config/quickQuestions', {
    ...builtInQuickQuestions(),
    'starter.contractor': [
      { id: 'stored-starter', label: 'Stored?', question: 'Stored?', kind: 'knowledge' },
    ],
  });
  assert.equal((await journey.resolveChip(lumora, 'stored-starter')).id, 'stored-starter');
  assert.equal(await journey.resolveChip(luna, 'stored-starter'), null);
  assert.equal((await journey.resolveChip(luna, 'working-hours')).id, 'working-hours');
});
