import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answeredCount,
  feedbackDelayMs,
  quizReducer,
  startQuiz,
} from '../../src/portal/quiz-flow.mjs';

const questions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
const run = (state, ...actions) => actions.reduce(quizReducer(questions), state);
const fb = (correct = true, selected = 'a') => ({ correct, selected });

test('an answer is sent once, locked, and only then does the quiz advance', () => {
  let state = startQuiz(questions);
  assert.equal(state.status, 'answering');
  state = run(state, { type: 'saving', value: 'a' });
  assert.equal(state.status, 'saving');
  // A second click while saving, or a change of mind, is ignored.
  assert.equal(run(state, { type: 'saving', value: 'b' }), state);
  assert.equal(run(state, { type: 'choose', value: 'b' }), state);
  // The quiz never advances before the save came back.
  assert.equal(run(state, { type: 'advance' }), state);
  state = run(state, { type: 'saved', feedback: fb() });
  assert.equal(state.status, 'feedback');
  assert.equal(state.index, 0);
  assert.equal(answeredCount(questions, state), 1);
  // The locked question cannot be changed or answered again.
  assert.equal(run(state, { type: 'choose', value: 'c' }), state);
  assert.equal(run(state, { type: 'saving', value: 'c' }), state);
  state = run(state, { type: 'advance' });
  assert.deepEqual([state.status, state.index, state.draft], ['answering', 1, null]);
});

test('a failed save keeps the question open, shows the error, and allows a safe retry', () => {
  let state = run(startQuiz(questions), { type: 'saving', value: 'a' });
  state = run(state, { type: 'save-failed', message: 'offline' });
  assert.deepEqual([state.status, state.error, state.index], ['answering', 'offline', 0]);
  assert.equal(state.draft, null); // a single choice is chosen again, so the radio fires
  const multi = run(
    startQuiz(questions),
    { type: 'saving', value: ['a', 'b'] },
    { type: 'save-failed', message: 'x', keepDraft: true },
  );
  assert.deepEqual(multi.draft, ['a', 'b']);
  assert.equal(answeredCount(questions, state), 0);
  state = run(state, { type: 'saving', value: 'a' });
  assert.equal(state.status, 'saving');
});

test('after the last answer the quiz finishes, and a failed finish can be retried', () => {
  let state = startQuiz(questions);
  for (const id of ['a', 'b', 'c'])
    state = run(
      state,
      { type: 'saving', value: id },
      { type: 'saved', feedback: fb() },
      {
        type: 'advance',
      },
    );
  assert.equal(state.status, 'finishing');
  state = run(state, { type: 'finish-failed', message: 'x' });
  assert.equal(state.status, 'finish-failed');
  state = run(state, { type: 'retry-finish' });
  assert.equal(state.status, 'finishing');
  state = run(state, { type: 'finished', result: { passed: true } });
  assert.equal(state.status, 'results');
});

test('a resumed quiz continues at its first unanswered question', () => {
  const resumed = startQuiz(questions, { answers: { q1: { value: 'a' }, q2: { value: 'b' } } });
  assert.equal(resumed.index, 2);
  assert.equal(answeredCount(questions, resumed), 2);
  const complete = startQuiz(questions, {
    answers: { q1: { value: 'a' }, q2: { value: 'b' }, q3: { value: 'c' } },
  });
  assert.equal(complete.status, 'finishing');
});

test('feedback stays longer when the answer was wrong', () => {
  assert.ok(feedbackDelayMs(false) > feedbackDelayMs(true));
  assert.ok(feedbackDelayMs(true) >= 3000);
});

test('retrying a failed quiz starts clean', () => {
  let state = startQuiz(questions);
  state = run(state, { type: 'saving', value: 'a' }, { type: 'saved', feedback: fb() });
  state = run(state, { type: 'restart' });
  assert.equal(answeredCount(questions, state), 0);
  assert.equal(state.status, 'answering');
});
