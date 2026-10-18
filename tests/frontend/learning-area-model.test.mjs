import test from 'node:test';
import assert from 'node:assert/strict';
import {
  learningSummary,
  learningStatus,
  continueLearning,
  taskResources,
} from '../../src/portal/learning-area-model.mjs';
test('optional activities do not block area completion or continue action', () => {
  const area = {
    id: 'team-support',
    steps: [
      { id: 'required', required: true, status: 'done' },
      { id: 'optional', required: false, status: 'todo' },
    ],
  };
  assert.deepEqual(learningSummary(area), { done: 1, total: 1, next: undefined, action: 'Review' });
  assert.equal(continueLearning([area]), undefined);
});
test('continue stays in the four learning areas and skips completed mandatory tasks', () => {
  const areas = [
    { id: 'documentation', steps: [{ id: 'doc', status: 'todo' }] },
    {
      id: 'policies',
      steps: [
        { id: 'done', status: 'done' },
        { id: 'optional', required: false, status: 'todo' },
        { id: 'next', status: 'todo', briefed: true },
      ],
    },
  ];
  assert.equal(continueLearning(areas).id, 'next');
  assert.equal(learningSummary(areas[1]).action, 'Continue');
  assert.equal(learningStatus(areas[1].steps[2]), 'In Progress');
  assert.equal(learningStatus({ status: 'todo' }), 'Not Started');
  assert.equal(learningStatus({ status: 'done' }), 'Completed');
});
test('resource links come only from provided HTTPS descriptions', () => {
  assert.deepEqual(taskResources({ description: 'Use the assigned invitation.' }), []);
  assert.deepEqual(
    taskResources({ description: 'Read (https://example.com/resource) or javascript:alert(1)' }),
    ['https://example.com/resource'],
  );
});

import { checklistModel } from '../../src/portal/learning-area-model.mjs';
test('checklist mirrors saved steps: every area incl. Documentation, required count only, done only when done', () => {
  const step = (id, status, extra = {}) => ({ id, title: id, status, ...extra });
  const model = checklistModel({
    areas: [
      { id: 'documentation', title: 'Documentation', steps: [step('doc', 'done')] },
      {
        id: 'policies',
        title: 'P',
        icon: 'p',
        steps: [step('a', 'done'), step('b', 'todo', { briefed: true }), step('c', 'submitted')],
      },
      {
        id: 'team-support',
        title: 'T',
        steps: [step('d', 'todo'), step('opt', 'todo', { required: false })],
      },
    ],
  });
  assert.deepEqual(
    model.groups.map((g) => g.id),
    ['documentation', 'policies', 'team-support'],
  );
  assert.equal(model.done, 2);
  assert.equal(model.total, 5);
  assert.equal(model.percent, 40);
  // With the server's overall percent (as on My onboarding), that number is shown.
  assert.equal(checklistModel({ percent: 7, areas: [] }).percent, 7);
  const [, policies, team] = model.groups;
  assert.deepEqual(
    policies.tasks.map((t) => [t.done, t.started]),
    [
      [true, false],
      [false, true],
      [false, true],
    ],
  );
  assert.equal(team.total, 1);
  assert.equal(team.tasks[1].required, false);
  assert.deepEqual(checklistModel(null), {
    groups: [],
    done: 0,
    total: 0,
    percent: 0,
    current: null,
    waiting: 0,
    complete: false,
  });
});

test('checklist current task skips done and waiting tasks; complete only when all required are done', () => {
  const step = (id, status, extra = {}) => ({ id, title: id, status, ...extra });
  const build = (statuses, optional = 'todo') =>
    checklistModel({
      areas: [
        {
          id: 'policies',
          title: 'P',
          steps: [
            ...statuses.map((status, index) => step('p' + index, status)),
            step('opt', optional, { required: false }),
          ],
        },
      ],
    });
  const first = build(['done', 'submitted', 'todo', 'todo']);
  assert.equal(first.current.id, 'p2');
  assert.equal(first.waiting, 1);
  assert.equal(first.complete, false);
  assert.equal(first.groups[0].tasks[2].current, true);
  assert.equal(first.groups[0].tasks[3].current, false);
  // Waiting on a coordinator is not completion.
  const pending = build(['done', 'submitted']);
  assert.equal(pending.current, null);
  assert.equal(pending.complete, false);
  // An incomplete optional task does not block completion.
  const finished = build(['done', 'done']);
  assert.equal(finished.complete, true);
  assert.equal(finished.current, null);
});

import { quizStage } from '../../src/portal/learning-area-model.mjs';
test('quiz stage comes only from saved records', () => {
  assert.equal(quizStage({}), 'not-started');
  assert.equal(quizStage({ record: { attempts: 1, passed: false } }), 'failed');
  assert.equal(
    quizStage({ record: { attempts: 1, passed: false }, session: { answers: { q1: {} } } }),
    'in-progress',
  );
  assert.equal(quizStage({ record: { attempts: 2, passed: true } }), 'passed');
});

test('the handbook link reads "View Employee Handbook"; other policies keep their document title', async () => {
  const { policyDocumentLabel } = await import('../../src/portal/learning-area-model.mjs');
  const document = { title: 'Code of Conduct', url: 'https://example.com/x.pdf' };
  assert.equal(
    policyDocumentLabel('policies.employee-handbook', document),
    'View Employee Handbook',
  );
  assert.equal(
    policyDocumentLabel('policies.workplace-conduct', document),
    'Open Code of Conduct ↗',
  );
});
