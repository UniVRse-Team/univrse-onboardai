import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGNMENT_ACTIVITIES,
  APPROVED_POLICIES,
  RESPONSIBILITY_ITEMS,
  SUPPORT_ROUTING_SCENARIOS,
  TOOL_ACCESS_STEP_IDS,
  gradeQuestions,
  publicVerificationContent,
} from '../../server/task-verification.mjs';
import { buildVerificationContent } from '../../server/verification-content.mjs';
import { templateWithAdditionalPolicies } from '../server/template-fixtures.mjs';
import { accessState, verificationGuide } from '../../src/portal/learning-area-model.mjs';

const steps = templateWithAdditionalPolicies('employee').areas.flatMap((area) =>
  area.steps.map((step) => ({ ...step, areaId: area.id })),
);
const stepById = Object.fromEntries(steps.map((step) => [step.id, step]));
const allQuestions = [
  ...Object.values(APPROVED_POLICIES).flatMap((p) => p.quiz.questions),
  ...ALIGNMENT_ACTIVITIES.values.questions,
  ...ALIGNMENT_ACTIVITIES.teams.questions,
  ...ALIGNMENT_ACTIVITIES.roleContribution.questions,
];

test('every quiz targets a real policy step and has a valid answer key and explanation', () => {
  for (const id of Object.keys(APPROVED_POLICIES)) assert.equal(stepById[id]?.areaId, 'policies');
  for (const question of allQuestions) {
    assert.ok(question.explanation);
    assert.ok(question.correct.length >= 1);
    for (const id of question.correct) assert.ok(question.options.some((o) => o.id === id));
    assert.equal(question.multiple, question.correct.length > 1);
  }
  for (const s of SUPPORT_ROUTING_SCENARIOS) assert.ok(s.options.some((o) => o.id === s.correctId));
  assert.ok(RESPONSIBILITY_ITEMS.length > 0);
});

test('public content never carries an answer key', () => {
  const raw = JSON.stringify(publicVerificationContent(buildVerificationContent()));
  assert.ok(!/"correct"|matchedItem|correctId|explanation/.test(raw));
});

test('grading needs the exact set of answers', () => {
  const [, multi] = ALIGNMENT_ACTIVITIES.values.questions;
  const questions = [multi];
  assert.equal(gradeQuestions(questions, { [multi.id]: multi.correct }).score, 100);
  assert.equal(gradeQuestions(questions, { [multi.id]: multi.correct.slice(1) }).score, 0);
  assert.equal(gradeQuestions(questions, { [multi.id]: [...multi.correct, 'e'] }).score, 0);
  assert.equal(gradeQuestions(questions, {}).score, 0);
});

test('each task states how it is verified, and optional tasks never look required', () => {
  const access = [...TOOL_ACCESS_STEP_IDS];
  const kind = (id) => {
    const step = stepById[id];
    return verificationGuide(step, step.areaId, access).kind;
  };
  assert.equal(kind('policies.data-protection'), 'policy');
  assert.equal(kind('alignment.products-customers'), 'matching');
  assert.equal(kind('alignment.mission-values'), 'knowledge');
  assert.equal(kind('role-tools.ai-readiness-training'), 'assessment');
  // Read-and-confirm steps have no quiz: the employee confirms them.
  assert.equal(kind('alignment.mission-values'), 'knowledge');
  assert.equal(kind('policies.employee-handbook'), 'policy');
  assert.equal(kind('team-support.working-preferences'), 'optional');
  assert.equal(
    verificationGuide(stepById['team-support.working-preferences'], 'team-support').mandatory,
    false,
  );
});

test('an access request is never "done" until confirmed', () => {
  assert.equal(accessState({ status: 'todo' }, undefined), 'none');
  assert.equal(accessState({ status: 'todo' }, { status: 'awaiting_confirmation' }), 'awaiting');
  assert.equal(accessState({ status: 'done' }, { status: 'awaiting_confirmation' }), 'done');
  assert.equal(accessState({ status: 'todo' }, { status: 'confirmed' }), 'done');
});

test('task statuses are honest: awaiting verification, verified, employee-confirmed', async () => {
  const { taskStatusLabel } = await import('../../src/portal/learning-area-model.mjs');
  const access = ['role-tools.gsheet-account'];
  const step = (over) => ({
    id: 'role-tools.gsheet-account',
    status: 'todo',
    completion: 'self',
    ...over,
  });
  assert.equal(taskStatusLabel(step(), 'role-tools', access), 'Not Started');
  assert.equal(
    taskStatusLabel(step(), 'role-tools', access, { status: 'awaiting_confirmation' }),
    'Awaiting verification',
  );
  assert.equal(
    taskStatusLabel(step({ status: 'done' }), 'role-tools', access, { status: 'confirmed' }),
    'Verified',
  );
  const plain = { id: 'role-tools.email-signature', status: 'done', completion: 'self' };
  assert.equal(taskStatusLabel(plain, 'role-tools', access), 'Employee-confirmed');
  assert.equal(
    taskStatusLabel({ id: 'policies.x', status: 'done', completion: 'check' }, 'policies', access),
    'Completed',
  );
});

test('each task gets one appropriate primary button', async () => {
  const { primaryAction } = await import('../../src/portal/learning-area-model.mjs');
  const access = ['role-tools.gsheet-account'];
  const step = (id, over = {}) => ({
    id,
    status: 'todo',
    required: true,
    completion: 'self',
    ...over,
  });
  const label = (s, area, ctx) => primaryAction(s, area, { accessStepIds: access, ...ctx })?.label;
  const policy = step('policies.data-protection', { completion: 'check' });
  // A policy with a quiz is tested by the quiz; the handbook is a separate link.
  assert.equal(label(policy, 'policies', { hasQuiz: true }), 'Start Quiz');
  const next = (quiz) => label(policy, 'policies', { hasQuiz: true, quiz });
  assert.equal(next('in-progress'), 'Continue Quiz');
  assert.equal(next('failed'), 'Retry Quiz');
  assert.equal(next('not-started'), 'Start Quiz');
  // A policy without an approved quiz is acknowledged.
  assert.equal(label(policy, 'policies', { hasQuiz: false }), 'Read and Confirm Acknowledgement');
  assert.equal(label({ ...policy, status: 'done' }, 'policies', { hasQuiz: true }), 'Review');
  assert.equal(label(step('alignment.products-customers'), 'alignment'), 'Start Activity');
  assert.equal(label(step('alignment.mission-values'), 'alignment'), 'Start Quiz');
  assert.equal(
    label(step('role-tools.gsheet-account'), 'role-tools'),
    'Request Access Verification',
  );
  // waiting on the coordinator, or verified: nothing for the employee to press
  assert.equal(
    label(step('role-tools.gsheet-account'), 'role-tools', {
      tool: { status: 'awaiting_confirmation' },
    }),
    undefined,
  );
  assert.equal(
    label(step('role-tools.ai-readiness-training'), 'role-tools'),
    'Start Self-Assessment',
  );
  assert.equal(label(step('role-tools.email-signature'), 'role-tools'), 'Confirm Setup');
  assert.equal(
    label(step('role-tools.gsheet-training-sop', { completion: 'check' }), 'role-tools'),
    'Start Quiz',
  );
  assert.equal(
    label(step('team-support.working-preferences', { required: false }), 'team-support'),
    'Open Optional Form',
  );
});
