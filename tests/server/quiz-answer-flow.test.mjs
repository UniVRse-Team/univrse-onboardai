import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccountsApp } from './account-harness.mjs';
import { ALIGNMENT_ACTIVITIES, APPROVED_POLICIES } from '../../server/task-verification.mjs';

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
const keyOf = (question) =>
  question.type === 'match'
    ? Object.fromEntries(question.pairs.map((p) => [p.id, p.correct]))
    : question.multiple
      ? question.correct
      : question.correct[0];
const wrongOf = (question) =>
  question.type === 'match'
    ? Object.fromEntries(
        question.pairs.map((p) => [p.id, question.choices.find((c) => c.id !== p.correct).id]),
      )
    : question.multiple
      ? [question.options.find((o) => !question.correct.includes(o.id)).id]
      : question.options.find((o) => !question.correct.includes(o.id)).id;
const stepOf = async (browser, areaId, stepId) =>
  (await browser.get('/api/me/onboarding')).body.areas
    .find((a) => a.id === areaId)
    .steps.find((s) => s.id === stepId);

const id = 'policies.employee-handbook';
const questions = APPROVED_POLICIES[id].quiz.questions;
const answer = (browser, question, value) =>
  post(browser, 'policies', id, { action: 'answer', questionId: question.id, answer: value });

test('an answer needs a valid shape and a known question; finishing needs every answer', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    assert.equal((await answer(browser, questions[0], '__nope__')).status, 400);
    assert.equal(
      (await post(browser, 'policies', id, { action: 'answer', questionId: 'zz', answer: 'a' }))
        .status,
      404,
    );
    assert.equal((await post(browser, 'policies', id, { action: 'finish' })).status, 409);
  });
});

test('each answer is checked at once against the key, locked, and recorded exactly once', async () => {
  await withApp(async (app) => {
    const hr = await app.hrBrowser();
    const { browser, employee } = await app.readyEmployee(hr);
    const [first, second] = questions;

    const right = await answer(browser, first, keyOf(first));
    assert.equal(right.body.correct, true);
    assert.ok(right.body.explanation);
    assert.equal(right.body.answered, 1);
    assert.equal(right.body.alreadyAnswered, false);

    const wrong = await answer(browser, second, wrongOf(second));
    assert.equal(wrong.body.correct, false);
    assert.deepEqual(wrong.body.correctAnswer, second.correct);
    assert.ok(wrong.body.explanation);
    assert.equal(wrong.body.answered, 2);

    // Changing or repeating the answer returns the locked first answer.
    const again = await answer(browser, second, keyOf(second));
    assert.equal(again.body.alreadyAnswered, true);
    assert.equal(again.body.correct, false);
    assert.equal(again.body.answered, 2);

    // The locked answers survive a reload, so a quiz can be resumed.
    const saved = (await browser.get('/api/me/task-verifications')).body.verifications;
    assert.deepEqual(Object.keys(saved.sessions[`policies/${id}`].answers), [first.id, second.id]);
    // Nothing is recorded as an attempt until the quiz is finished.
    assert.equal(saved.policies?.[id]?.quiz, undefined);
    // HR never sees an answer session.
    const hrView = await hr.get(`/api/hr/employees/${employee.account.id}/task-verifications`);
    assert.ok(!JSON.stringify(hrView.body).includes('sessions'));
  });
});

test('a failed quiz stays incomplete, a double finish is one attempt, and a retry can pass', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    for (const question of questions) await answer(browser, question, wrongOf(question));

    const [one, two] = await Promise.all([
      post(browser, 'policies', id, { action: 'finish' }),
      post(browser, 'policies', id, { action: 'finish' }),
    ]);
    const statuses = [one.status, two.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const failed = [one, two].find((res) => res.status === 200).body;
    assert.equal(failed.passed, false);
    assert.equal(failed.score, 0);
    assert.equal(failed.attempts, 1);
    assert.equal(failed.correctCount, 0);
    assert.equal(failed.totalCount, questions.length);
    assert.equal((await stepOf(browser, 'policies', id)).status, 'todo');

    // The session is gone: a retry starts clean and the first answer is not locked.
    const retry = await answer(browser, questions[0], keyOf(questions[0]));
    assert.equal(retry.body.alreadyAnswered, false);
    assert.equal(retry.body.attempt, 2);
    assert.equal((await post(browser, 'policies', id, { action: 'finish' })).status, 409);
    for (const question of questions.slice(1)) await answer(browser, question, keyOf(question));
    const pass = await post(browser, 'policies', id, { action: 'finish' });
    assert.equal(pass.body.passed, true);
    assert.equal(pass.body.attempts, 2);
    assert.equal((await stepOf(browser, 'policies', id)).status, 'done');
    const saved = (await browser.get('/api/me/task-verifications')).body.verifications;
    assert.equal(saved.policies[id].quiz.attempts, 2);
    assert.equal(saved.sessions?.[`policies/${id}`], undefined);
  });
});

test('a match question is evaluated as a whole and shows its key afterwards', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    const matching = ALIGNMENT_ACTIVITIES.products.questions.find((q) => q.type === 'match');
    assert.ok(matching, 'products activity has a match question');
    const incomplete = await post(browser, 'alignment', 'products-customers', {
      action: 'answer',
      questionId: matching.id,
      answer: { [matching.pairs[0].id]: matching.choices[0].id },
    });
    assert.equal(incomplete.status, 400);
    const wrong = await post(browser, 'alignment', 'products-customers', {
      action: 'answer',
      questionId: matching.id,
      answer: wrongOf(matching),
    });
    assert.equal(wrong.body.correct, false);
    assert.ok(wrong.body.correctPairs);
    assert.ok(wrong.body.wrongPairs.length > 0);
  });
});

test('a multiple-choice answer is judged on the whole selection', async () => {
  await withApp(async (app) => {
    const { browser } = await app.readyEmployee(await app.hrBrowser());
    const all = [
      ...Object.entries(APPROVED_POLICIES).flatMap(([policy, value]) =>
        value.quiz.questions.map((q) => ['policies', policy, q]),
      ),
    ].find(([, , q]) => q.multiple);
    assert.ok(all, 'approved content has a multiple-choice question');
    const [, policy, question] = all;
    await post(browser, 'policies', policy, { action: 'acknowledge' });
    const partial = await post(browser, 'policies', policy, {
      action: 'answer',
      questionId: question.id,
      answer: [question.correct[0]],
    });
    assert.equal(partial.body.correct, false);
    assert.deepEqual(partial.body.missed, question.correct.slice(1));
    assert.deepEqual(partial.body.extra, []);
  });
});
