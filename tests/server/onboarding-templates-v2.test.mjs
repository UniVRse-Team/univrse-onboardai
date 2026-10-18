// Template version 2 (contract v1.4 and v1.5, issue #63): Firestore migration
// 003 upgrades version-1 templates and leaves progress untouched, and the
// server never serves a stored template older than the built-in one. The
// in-memory Firestore fake, pg-mem and synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeFirestore } from './fake-firestore.mjs';
import { startAccountsApp } from './account-harness.mjs';
import {
  MARKER_COLLECTION,
  firestoreMigrationFiles,
  migrateFirestore,
} from '../../server/firestore-migrations.mjs';
import { builtInTemplate, templateVersion, tracks } from '../../server/onboarding-content.mjs';
import { validTemplate } from '../../server/onboarding-progress.mjs';
import { up as upgradeTemplates } from '../../server/migrations/firestore/003_onboarding_templates_v2.mjs';

// A template as migration 001 seeded it before v1.4: version 1, every check a
// multiple choice with letter ids and the answer at "b", and no briefings.
function versionOne(track) {
  const template = builtInTemplate(track);
  template.version = 1;
  for (const area of template.areas)
    for (const step of area.steps) {
      delete step.briefing;
      if (step.check)
        step.check = {
          scenario: step.check.scenario,
          options: [
            { id: 'a', text: 'Synthetic option one' },
            { id: 'b', text: 'Synthetic option two' },
            { id: 'c', text: 'Synthetic option three' },
          ],
          correctOptionId: 'b',
          explanation: step.check.explanation,
          sourceTitle: step.check.sourceTitle,
        };
    }
  return template;
}
const progress = (accountId) => ({
  accountId,
  updatedAt: '2026-10-14T01:00:00.000Z',
  steps: {
    'documentation.contract': {
      status: 'submitted',
      updatedAt: 'x',
      source: 'employee',
      actorId: accountId,
    },
    'policies.employee-handbook': {
      status: 'done',
      updatedAt: 'x',
      source: 'employee',
      actorId: accountId,
    },
    'team-support.company-chat-groups': {
      status: 'done',
      updatedAt: 'x',
      source: 'alya-agent',
      actorId: accountId,
    },
  },
});

test('migration 003 and 005 upgrade older templates, are idempotent and never touch progress', async () => {
  assert.equal(templateVersion, 8);
  assert.ok(firestoreMigrationFiles().includes('003_onboarding_templates_v2.mjs'));
  assert.ok(firestoreMigrationFiles().includes('005_onboarding_templates_v3.mjs'));
  assert.ok(firestoreMigrationFiles().includes('006_onboarding_templates_v4.mjs'));
  assert.ok(firestoreMigrationFiles().includes('007_onboarding_templates_v5.mjs'));
  assert.ok(firestoreMigrationFiles().includes('008_onboarding_templates_v6.mjs'));
  assert.ok(firestoreMigrationFiles().includes('009_onboarding_templates_v7.mjs'));
  assert.ok(firestoreMigrationFiles().includes('010_onboarding_templates_v8.mjs'));
  const firestore = new FakeFirestore();
  for (const track of tracks) {
    // A version-1 template is still a valid (legacy) template.
    assert.ok(validTemplate(versionOne(track), track));
    firestore.write(`onboardingTemplates/${track}`, versionOne(track));
  }
  firestore.write('onboardingProgress/synthetic-a', progress('synthetic-a'));
  firestore.write('onboardingProgress/synthetic-b', progress('synthetic-b'));
  const before = ['synthetic-a', 'synthetic-b'].map((id) =>
    firestore.read(`onboardingProgress/${id}`),
  );

  const lines = [];
  await upgradeTemplates({ firestore, log: (line) => lines.push(line) });
  assert.deepEqual(lines, [
    `onboarding templates v${templateVersion}: 3 upgraded, 0 created, 0 already current`,
  ]);
  for (const track of tracks)
    assert.deepEqual(firestore.read(`onboardingTemplates/${track}`), builtInTemplate(track));
  // Progress is never touched. Steps that remain keep their ids; a step the new
  // checklist no longer lists (documentation.contract) is simply not shown.
  const after = ['synthetic-a', 'synthetic-b'].map((id) =>
    firestore.read(`onboardingProgress/${id}`),
  );
  assert.deepEqual(after, before);
  const ids = new Set(
    builtInTemplate('employee').areas.flatMap((area) => area.steps.map((step) => step.id)),
  );
  assert.ok(ids.has('policies.employee-handbook'));
  assert.ok(!ids.has('documentation.contract'));

  // Re-running changes nothing.
  await upgradeTemplates({ firestore, log: (line) => lines.push(line) });
  assert.equal(
    lines[1],
    `onboarding templates v${templateVersion}: 0 upgraded, 0 created, 3 already current`,
  );
  for (const track of tracks)
    assert.deepEqual(firestore.read(`onboardingTemplates/${track}`), builtInTemplate(track));

  // A missing template is created; a newer one (a later migration) is kept.
  const newer = { ...builtInTemplate('intern'), version: templateVersion + 1 };
  firestore.write('onboardingTemplates/intern', newer);
  await firestore.collection('onboardingTemplates').doc('contractor').delete();
  await upgradeTemplates({ firestore, log: (line) => lines.push(line) });
  assert.equal(
    lines[2],
    `onboarding templates v${templateVersion}: 0 upgraded, 1 created, 2 already current`,
  );
  assert.deepEqual(firestore.read('onboardingTemplates/intern'), newer);
  assert.deepEqual(firestore.read('onboardingTemplates/contractor'), builtInTemplate('contractor'));
  // Log lines carry counts only.
  assert.ok(lines.every((line) => !line.includes('contract ') && !line.includes('briefing')));
});

test('a stack where 001 and 002 already ran gets 003 to 011, which upgrade its templates', async () => {
  const firestore = new FakeFirestore();
  for (const track of tracks) firestore.write(`onboardingTemplates/${track}`, versionOne(track));
  for (const name of ['001_onboarding_templates.mjs', '002_quick_questions.mjs'])
    firestore.write(`${MARKER_COLLECTION}/${name}`, { appliedAt: '2026-10-14T01:00:00.000Z' });
  const { applied } = await migrateFirestore(firestore, { log: () => {} });
  assert.deepEqual(applied, [
    '003_onboarding_templates_v2.mjs',
    '004_company_documents_areas.mjs',
    '005_onboarding_templates_v3.mjs',
    '006_onboarding_templates_v4.mjs',
    '007_onboarding_templates_v5.mjs',
    '008_onboarding_templates_v6.mjs',
    '009_onboarding_templates_v7.mjs',
    '010_onboarding_templates_v8.mjs',
    '011_company_scope.mjs',
  ]);
  assert.equal(firestore.read('onboardingTemplates/employee').version, templateVersion);
  assert.deepEqual((await migrateFirestore(firestore, { log: () => {} })).applied, []);
});

test('the server serves the built-in template version over a stored version 1, and the same after upgrade', async () => {
  const app = await startAccountsApp();
  try {
    for (const track of tracks)
      app.firestore.write(`onboardingTemplates/${track}`, versionOne(track));
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const served = (await browser.get('/api/me/onboarding')).body;
    const handbook = served.areas[1].steps[0];
    assert.equal(handbook.briefingRequired, true);
    assert.ok(handbook.briefing.text);
    assert.ok(
      app.logs.some((line) =>
        new RegExp(
          `template employee is version 1; the built-in version ${templateVersion} is used`,
        ).test(line),
      ),
    );
    app.briefAll((await browser.get('/api/auth/session')).body.account.id);
    const question = (
      await browser.get('/api/me/onboarding/steps/policies.employee-handbook/check')
    ).body;
    assert.equal(question.type, 'choice');
    assert.ok(question.options.every((o) => /^[a-z0-9]{4}$/.test(o.id)));
    await upgradeTemplates({ firestore: app.firestore, log: () => {} });
    const upgraded = (await browser.get('/api/me/onboarding')).body;
    assert.deepEqual(
      upgraded.areas.map((a) => a.steps.map((s) => [s.id, s.briefing])),
      served.areas.map((a) => a.steps.map((s) => [s.id, s.briefing])),
    );
  } finally {
    await app.close();
  }
});
