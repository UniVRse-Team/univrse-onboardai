import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccountsApp } from './account-harness.mjs';
import {
  ALIGNMENT_ACTIVITIES,
  ALIGNMENT_ACTIVITY_STEP_IDS,
  APPROVED_POLICIES,
  DEFAULT_POLICY_PASSING_SCORE,
  SUPPORT_ROUTING_SCENARIOS,
  routingQuestions,
} from '../../server/task-verification.mjs';
import { templateWithAdditionalPolicies } from './template-fixtures.mjs';

async function withApp(check) {
  const app = await startAccountsApp();
  try {
    await check(app);
  } finally {
    await app.close();
  }
}

const post = (browser, area, activity, body) =>
  browser.post(`/api/me/task-verifications/${area}/${activity}`, body);
const stepOf = async (browser, areaId, stepId) =>
  (await browser.get('/api/me/onboarding')).body.areas
    .find((a) => a.id === areaId)
    .steps.find((s) => s.id === stepId);

// The answer key, from the server's own content (the browser never sees it).
const key = (question) =>
  question.type === 'match'
    ? Object.fromEntries(question.pairs.map((p) => [p.id, p.correct]))
    : question.multiple
      ? question.correct
      : question.correct[0];
const correctAnswers = (questions) => Object.fromEntries(questions.map((q) => [q.id, key(q)]));
// One wrong answer for every question.
const wrongAnswers = (questions) =>
  Object.fromEntries(
    questions.map((q) => [
      q.id,
      q.type === 'match'
        ? Object.fromEntries(
            q.pairs.map((p) => [p.id, q.choices.find((c) => c.id !== p.correct).id]),
          )
        : q.multiple
          ? ['__none__']
          : q.options.find((o) => !q.correct.includes(o.id)).id,
    ]),
  );

test('Handbook content is served without answer keys and names its content requirements', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    const res = await browser.get('/api/me/company-policy-handbook');
    assert.equal(res.status, 200);
    assert.ok(res.body.metadata.contentRequirementNotice.includes('Content requirement'));
    assert.equal(Object.keys(res.body.policies).length, 4);
    assert.equal(res.body.config.policyPassingScore, DEFAULT_POLICY_PASSING_SCORE);
    assert.ok(res.body.contentRequirements.length >= 3);
    assert.ok(res.body.toolAccessSteps.includes('role-tools.gsheet-account'));
    // substantial policy assessments: at least 8 questions each
    for (const policy of Object.values(res.body.policies))
      assert.ok(policy.quiz.questions.length >= 8);
    assert.ok(res.body.supportRouting.questions.length >= 8);
    const raw = JSON.stringify(res.body);
    assert.ok(!/"correct"|"matchedItem"|correctId|explanation/.test(raw));
  });
});

test('Area 1: acknowledgement first; wrong answers retry with feedback; a pass completes; records are separate', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    const id = 'policies.employee-handbook';
    const questions = APPROVED_POLICIES[id].quiz.questions;

    // The quiz tests the policy; no acknowledgement is needed first.
    assert.equal((await stepOf(browser, 'policies', id)).status, 'todo');

    const fail = await post(browser, 'policies', id, {
      action: 'quiz',
      answers: wrongAnswers(questions),
      passingScore: 0,
      score: 100,
    });
    assert.equal(fail.body.passed, false);
    assert.equal(fail.body.score, 0);
    assert.equal(fail.body.passingScore, DEFAULT_POLICY_PASSING_SCORE);
    assert.ok(fail.body.questionResults.every((r) => !r.correct && r.explanation));
    assert.equal((await stepOf(browser, 'policies', id)).status, 'todo');

    const almost = {
      ...correctAnswers(questions),
      q1: wrongAnswers(questions).q1,
      q2: wrongAnswers(questions).q2,
      q3: wrongAnswers(questions).q3,
    };
    const near = await post(browser, 'policies', id, { action: 'quiz', answers: almost });
    assert.equal(near.body.passed, false); // 80% is required by default
    assert.equal(near.body.score, 70);

    const pass = await post(browser, 'policies', id, {
      action: 'quiz',
      answers: correctAnswers(questions),
    });
    assert.equal(pass.body.passed, true);
    assert.equal(pass.body.attempts, 3);
    assert.equal((await stepOf(browser, 'policies', id)).status, 'done');

    const saved = (await browser.get('/api/me/task-verifications')).body.verifications.policies[id];
    assert.equal(saved.quiz.attempts, 3);
    assert.equal(saved.quiz.passed, true);
    assert.deepEqual(
      saved.quiz.history.map((h) => h.score),
      [0, 70, 100],
    );
  });
});

test('Area 1: the pass mark is server configuration', async () => {
  await withApp(async (app) => {
    // The data protection quiz is an approved policy activity that is not in the
    // current checklist, so the step is added through a stored template.
    app.firestore.write('onboardingTemplates/employee', templateWithAdditionalPolicies());
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    const id = 'policies.data-protection';
    const questions = APPROVED_POLICIES[id].quiz.questions;
    await post(browser, 'policies', id, { action: 'acknowledge' });
    const answers = { ...correctAnswers(questions), q1: wrongAnswers(questions).q1 }; // 7 of 8 = 88%
    process.env.POLICY_QUIZ_PASSING_SCORE = '80';
    try {
      const res = await post(browser, 'policies', id, { action: 'quiz', answers });
      assert.equal(res.body.score, 88);
      assert.equal(res.body.passingScore, 80);
      assert.equal(res.body.passed, true);
    } finally {
      delete process.env.POLICY_QUIZ_PASSING_SCORE;
    }
    assert.equal((await stepOf(browser, 'policies', id)).status, 'done');
  });
});

test('Drafts: answers in progress are saved, restored and cleared by a submission; HR never sees them', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { browser, employee } = await app.readyEmployee(hr);
    const draft = await post(browser, 'alignment', 'mission-values', {
      action: 'draft',
      answers: { q1: 'a' },
    });
    assert.equal(draft.body.saved, true);
    assert.deepEqual(
      (await browser.get('/api/me/task-verifications')).body.verifications.drafts[
        'alignment/mission-values'
      ].answers,
      { q1: 'a' },
    );
    const unknown = await post(browser, 'alignment', 'not-an-activity', {
      action: 'draft',
      answers: {},
    });
    assert.equal(unknown.status, 404);
    const huge = await post(browser, 'alignment', 'mission-values', {
      action: 'draft',
      answers: { q1: 'x'.repeat(30000) },
    });
    assert.ok([400, 413].includes(huge.status)); // too large for the body limit or for the draft limit

    const hrView = await hr.get(`/api/hr/employees/${employee.account.id}/task-verifications`);
    assert.ok(!JSON.stringify(hrView.body).includes('drafts'));

    await post(browser, 'alignment', 'mission-values', { answers: { q1: 'b' } });
    assert.equal(
      (await browser.get('/api/me/task-verifications')).body.verifications.drafts?.[
        'alignment/mission-values'
      ],
      undefined,
    );
  });
});

test('Area 2: every activity (matching and questions) records attempts and completes its step on a pass', async () => {
  await withApp(async (app) => {
    app.firestore.write('onboardingTemplates/employee', templateWithAdditionalPolicies());
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    const slugs = {
      'products-customers': ALIGNMENT_ACTIVITIES.products,
      'mission-values': ALIGNMENT_ACTIVITIES.values,
      'org-structure': ALIGNMENT_ACTIVITIES.teams,
      'role-contribution': ALIGNMENT_ACTIVITIES.roleContribution,
    };
    for (const [slug, activity] of Object.entries(slugs)) {
      const bad = await post(browser, 'alignment', slug, {
        answers: wrongAnswers(activity.questions),
      });
      assert.equal(bad.body.passed, false);
      assert.notEqual((await stepOf(browser, 'alignment', 'alignment.' + slug)).status, 'done');
      const good = await post(browser, 'alignment', slug, {
        answers: correctAnswers(activity.questions),
        notes: 'Fewer admin hours for clinics.',
      });
      assert.equal(good.body.passed, true);
      assert.equal(good.body.attempts, 2);
    }
    const area = (await browser.get('/api/me/onboarding')).body.areas.find(
      (a) => a.id === 'alignment',
    );
    assert.ok(
      area.steps
        .filter((s) => ALIGNMENT_ACTIVITY_STEP_IDS.includes(s.id))
        .every((s) => s.status === 'done'),
    );
    // the matching question needs every pair right
    const products = ALIGNMENT_ACTIVITIES.products.questions;
    const partial = correctAnswers(products);
    partial.q1 = { ...partial.q1, p1: 'univrse-pay' };
    assert.equal(
      (await post(browser, 'alignment', 'products-customers', { answers: partial })).body.passed,
      false,
    );
  });
});

test('Area 3: the checklist is an acknowledgement; the AI self-assessment completes its optional step', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);

    const partial = await post(browser, 'role-tools', 'responsibilities', { checkedItems: ['0'] });
    assert.equal(partial.status, 400);
    const checklist = await post(browser, 'role-tools', 'responsibilities', {
      department: 'Engineering',
      checkedItems: ['0', '1', '2'],
    });
    assert.equal(checklist.status, 200);

    const saved = (await browser.get('/api/me/task-verifications')).body.verifications.roleTools;
    assert.ok(saved.responsibilities.acknowledgedAt);

    // The AI self-assessment is separate from setup tasks and is not pass/fail.
    const assess = await browser.put('/api/me/ai-proficiency', { status: 'assessed', level: 4 });
    assert.equal(assess.status, 200);
    // A submitted assessment completes the step (no pass mark); the practice
    // exercise is recorded separately.
    assert.equal(assess.body.aiProficiency.trainingCompleted, false);
    assert.equal(
      (await stepOf(browser, 'role-tools', 'role-tools.ai-readiness-training')).status,
      'done',
    );
    const practice = await browser.post('/api/me/ai-proficiency/complete-training', {});
    assert.equal(practice.body.aiProficiency.trainingCompleted, true);
  });
});

test('Area 4: routing scenarios are graded and recorded, and no People & Support step is marked done', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    const questions = routingQuestions(SUPPORT_ROUTING_SCENARIOS);
    const wrong = await post(browser, 'team-support', 'support-routing', {
      answers: wrongAnswers(questions),
    });
    assert.equal(wrong.body.passed, false);
    assert.ok(wrong.body.questionResults.every((r) => r.explanation));
    const right = await post(browser, 'team-support', 'support-routing', {
      answers: correctAnswers(questions),
    });
    assert.equal(right.body.passed, true);
    const help = await post(browser, 'team-support', 'confirm-help', {});
    assert.ok(help.body.confirmedHelpAt);

    // The only People & Support task left is the optional working preferences.
    const teamSteps = (await browser.get('/api/me/onboarding')).body.areas.find(
      (a) => a.id === 'team-support',
    ).steps;
    assert.deepEqual(
      teamSteps.map((step) => step.id),
      ['team-support.working-preferences'],
    );
    const optional = await stepOf(browser, 'team-support', 'team-support.working-preferences');
    assert.equal(optional.required, false);

    const saved = (await browser.get('/api/me/task-verifications')).body.verifications.teamSupport;
    assert.equal(saved.routing.attempts, 2);
    assert.equal(saved.routing.passed, true);
    assert.ok(saved.confirmedHelpAt);
  });
});

test('Optional working preferences are private, optional and never affect progress', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { browser, employee } = await app.readyEmployee(hr);
    const before = (await browser.get('/api/me/onboarding')).body.percent;
    const saved = await post(browser, 'team-support', 'working-preferences', {
      text: 'Written agendas, please.',
    });
    assert.equal(
      saved.body.verifications.teamSupport.workingPreferences.text,
      'Written agendas, please.',
    );
    assert.equal((await browser.get('/api/me/onboarding')).body.percent, before);
    // HR never receives the text.
    const hrView = await hr.get(`/api/hr/employees/${employee.account.id}/task-verifications`);
    assert.ok(!JSON.stringify(hrView.body).includes('Written agendas'));
    // An empty answer removes it.
    const removed = await post(browser, 'team-support', 'working-preferences', { text: '' });
    assert.equal(removed.body.verifications.teamSupport.workingPreferences, undefined);
  });
});

test('A direct request cannot complete or reopen a quiz-proven step', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    for (const id of ['alignment.mission-values']) {
      for (const action of ['complete', 'reopen']) {
        const res = await browser.post(`/api/me/onboarding/steps/${id}/${action}`);
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'VERIFICATION_REQUIRED');
      }
    }
    // an optional task is still employee-confirmed
    const ok = await browser.post(
      '/api/me/onboarding/steps/team-support.working-preferences/complete',
    );
    assert.equal(ok.status, 200);
  });
});
