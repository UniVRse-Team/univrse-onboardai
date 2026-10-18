import test from 'node:test';
import assert from 'node:assert/strict';
import {
  documentSectionStatus,
  documentStepState,
  documentTasks,
  latestFor,
} from '../../src/documents/document-steps.mjs';
import { stepActions } from '../../src/access/onboarding-view.mjs';

const step = (id, status = 'todo') => ({
  id,
  status,
  required: true,
  completion: 'hr_verify',
  requiresDocument: true,
});
const sub = (stepId, status, at) => ({ id: stepId + at, stepId, status, submittedAt: at });

test('a task is Not Started until its document is saved, then Completed, whatever HR decides', () => {
  const a = step('a');
  const todo = documentStepState(a, []);
  assert.deepEqual(
    [todo.key, todo.label, todo.action, todo.done],
    ['todo', 'Not Started', 'Start', false],
  );
  // Having the upload open is In Progress; it saves nothing and is never done.
  const open = documentStepState(a, [], true);
  assert.deepEqual(
    [open.key, open.label, open.action, open.done],
    ['progress', 'In Progress', 'Continue', false],
  );
  // Another task's document never counts.
  assert.equal(documentStepState(a, [sub('b', 'Approved', '1')]).done, false);
  for (const hr of ['Pending Review', 'Under Review', 'Approved', 'Rejected']) {
    const state = documentStepState(step('a', 'done'), [sub('a', hr, '1')]);
    assert.deepEqual([state.label, state.action, state.done], ['Completed', null, true], hr);
  }
  // A saved document counts even while the step record catches up.
  assert.equal(documentStepState(a, [sub('a', 'Pending Review', '1')]).done, true);
  // The employee list never shows the review words.
  const shown = JSON.stringify(documentStepState(step('a', 'done'), [sub('a', 'Rejected', '1')]));
  assert.doesNotMatch(shown.replace(/"latest":.*$/, ''), /Pending|Submitted|Rejected|Under Review/);
  assert.equal(
    latestFor([sub('a', 'Rejected', '1'), sub('a', 'Pending Review', '2')], 'a').status,
    'Pending Review',
  );
});

test('tasks open one at a time; the section counts the real required total', () => {
  const steps = [step('a', 'done'), step('b'), step('c'), { ...step('o'), required: false }];
  const tasks = documentTasks(steps, [sub('a', 'Pending Review', '1')]);
  assert.deepEqual(
    tasks.map((t) => [t.step.id, t.done, t.isNext, t.locked]),
    [
      ['a', true, false, false],
      ['b', false, true, false],
      ['c', false, false, true],
    ],
  );
  const some = documentSectionStatus(steps, [sub('a', 'Pending Review', '1')]);
  assert.deepEqual(
    [some.completedCount, some.total, some.percent, some.completed, some.nextStepId],
    [1, 3, 33, false, 'b'],
  );
  assert.equal(some.text, '1 of 3 required tasks completed');
  assert.equal(some.completionMessage, '');
  // Any task count works: 2 of 5 is 40%.
  const five = Array.from({ length: 5 }, (_, i) => step('s' + i, i < 2 ? 'done' : 'todo'));
  assert.equal(documentSectionStatus(five, []).percent, 40);
  const all = documentSectionStatus([step('a', 'done'), step('b', 'done')], []);
  assert.deepEqual([all.percent, all.completed, all.nextStepId], [100, true, null]);
  assert.match(all.completionMessage, /complete/i);
  // A brand-new employee starts at 0%.
  assert.deepEqual(
    [
      documentSectionStatus([step('a'), step('b')], []).percent,
      documentSectionStatus([step('a')], []).completed,
    ],
    [0, false],
  );
});

test('a document step offers no mark-as-submitted or withdraw button', () => {
  assert.deepEqual(stepActions({ ...step('a'), status: 'todo' }), []);
  assert.deepEqual(stepActions({ ...step('a'), status: 'done' }), []);
  const plain = { id: 'x', status: 'todo', completion: 'hr_verify', required: true };
  assert.deepEqual(stepActions(plain), ['submit']);
});
