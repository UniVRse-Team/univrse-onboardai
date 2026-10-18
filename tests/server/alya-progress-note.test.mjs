import test from 'node:test';
import assert from 'node:assert/strict';
import { progressNote } from '../../server/alya-progress-note.mjs';

const step = (id, status, extra = {}) => ({
  id,
  title: 'Task ' + id,
  status,
  required: true,
  ...extra,
});
const onboarding = {
  areas: [
    { id: 'documentation', title: 'Documentation', steps: [step('doc', 'todo')] },
    {
      id: 'policies',
      title: 'Policies',
      steps: [step('a', 'done'), step('b', 'submitted'), step('c', 'todo'), step('d', 'todo')],
    },
  ],
};

test('Alya is told only saved statuses and the current task, never Documentation', () => {
  const note = progressNote(onboarding);
  assert.match(note, /completed: 1 of 4/);
  assert.match(note, /Completed: Task a\./);
  assert.match(note, /NOT complete\): Task b\./);
  assert.match(note, /Current task: "Task c"/);
  assert.doesNotMatch(note, /Task doc/);
  assert.match(note, /Never say a task is completed/);
});

test('an unreadable or empty footprint yields no note; all done says so', () => {
  assert.equal(progressNote(null), '');
  assert.equal(progressNote({ areas: [] }), '');
  const done = progressNote({
    areas: [{ id: 'policies', title: 'P', steps: [step('a', 'done')] }],
  });
  assert.match(done, /All required learning tasks are complete/);
});
