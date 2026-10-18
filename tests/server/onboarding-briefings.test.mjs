// Alya's briefing before completing a required step (contract v1.5): the
// route, every gate (complete, check, agent approval), HR's ungated
// verification, reopening, the Onboarding shape and the checklist agent's
// refusal (a fake agent). pg-mem, the in-memory Firestore fake and synthetic
// people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { startAccountsApp } from './account-harness.mjs';
import { builtInTemplate, handbookTitle } from '../../server/onboarding-content.mjs';
import { findStep } from '../../server/onboarding-progress.mjs';
import { briefingFirstText } from '../../server/agent-actions.mjs';

const stepOf = (onboarding, id) =>
  onboarding.areas.flatMap((area) => area.steps).find((s) => s.id === id);
const briefingPath = (id) => `/api/me/onboarding/steps/${id}/briefing`;

async function withEmployee(options, check) {
  const app = await startAccountsApp(options);
  try {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    await check({ app, hr, browser, id: employee.account.id });
  } finally {
    await app.close();
  }
}

test('the Onboarding steps carry briefing, briefingRequired and briefed', async () => {
  await withEmployee({}, async ({ browser }) => {
    const view = (await browser.get('/api/me/onboarding')).body;
    const handbook = stepOf(view, 'policies.employee-handbook');
    const expected = findStep(builtInTemplate('employee'), 'policies.employee-handbook').step
      .briefing;
    assert.deepEqual(
      [handbook.briefing, handbook.briefingRequired, handbook.briefed],
      [expected, true, false],
    );
    assert.equal(handbook.briefing.sourceTitle, handbookTitle);
    const optional = stepOf(view, 'team-support.working-preferences');
    assert.deepEqual(
      [optional.briefing, optional.briefingRequired, optional.briefed],
      [null, false, false],
    );
    // Every required step of every area needs a briefing.
    for (const area of view.areas)
      for (const step of area.steps.filter((s) => s.required))
        assert.ok(step.briefingRequired && step.briefing.text, step.id);
  });
});

test('POST .../briefing records the first completion once; unknown and optional steps are 404, bad bodies 400', async () => {
  await withEmployee({}, async ({ app, hr, browser, id }) => {
    const first = await browser.post(briefingPath('policies.employee-handbook'), {
      completion: 'listened',
    });
    assert.equal(first.status, 200);
    assert.equal(stepOf(first.body, 'policies.employee-handbook').briefed, true);
    assert.equal(stepOf(first.body, 'policies.employee-handbook').status, 'todo');
    const stored = () => app.firestore.read(`onboardingProgress/${id}`).steps;
    assert.deepEqual(stored(), {
      'policies.employee-handbook': {
        briefedAt: '2026-10-15T01:00:00.000Z',
        briefedBy: 'listened',
      },
    });
    // Idempotent: a later "read" keeps the first time and completion.
    app.clock.advance(60_000);
    const again = await browser.post(briefingPath('policies.employee-handbook'), {
      completion: 'read',
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
    assert.deepEqual(stored()['policies.employee-handbook'], {
      briefedAt: '2026-10-15T01:00:00.000Z',
      briefedBy: 'listened',
    });

    const unknown = await browser.post(briefingPath('team-support.nope'), { completion: 'read' });
    assert.deepEqual([unknown.status, unknown.body.code], [404, 'STEP_NOT_FOUND']);
    const optional = await browser.post(briefingPath('team-support.working-preferences'), {
      completion: 'read',
    });
    assert.deepEqual([optional.status, optional.body.code], [404, 'BRIEFING_NOT_FOUND']);
    for (const body of [{}, { completion: 'skimmed' }, { completion: 'read', extra: 1 }, []]) {
      const invalid = await browser.post(briefingPath('alignment.mission-values'), body);
      assert.deepEqual(
        [invalid.status, invalid.body.code],
        [400, 'BRIEFING_COMPLETION_INVALID'],
        JSON.stringify(body),
      );
    }
    // Employee only; signed in only.
    const asHr = await hr.post(briefingPath('policies.employee-handbook'), {
      completion: 'read',
    });
    assert.deepEqual([asHr.status, asHr.body.code], [403, 'EMPLOYEE_ROLE_REQUIRED']);
    const anonymous = await app
      .browser()
      .post(briefingPath('policies.employee-handbook'), { completion: 'read' });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(Object.keys(stored()), ['policies.employee-handbook']);
  });
});

test('every gate: a quiz-proven step is finished by its activity; the check needs the briefing; a document step needs its upload', async () => {
  await withEmployee({}, async ({ app, hr, browser, id }) => {
    const gated = async (method, path, body) => {
      const response = await browser[method](path, body);
      assert.deepEqual([response.status, response.body.code], [409, 'BRIEFING_REQUIRED'], path);
    };
    // An alignment step is finished by its activity, briefed or not (no direct request).
    const quiz = await browser.post('/api/me/onboarding/steps/alignment.mission-values/complete');
    assert.deepEqual([quiz.status, quiz.body.code], [409, 'VERIFICATION_REQUIRED']);
    // A document step is finished by an approved upload, briefed or not.
    const document = await browser.post(
      '/api/me/onboarding/steps/documentation.employee-information-form/complete',
    );
    assert.deepEqual([document.status, document.body.code], [409, 'DOCUMENT_REQUIRED']);
    await gated('get', '/api/me/onboarding/steps/policies.employee-handbook/check');
    await gated('post', '/api/me/onboarding/steps/policies.employee-handbook/check', {
      optionId: 'h8t3',
    });
    // A check step's complete is still CHECK_REQUIRED; an optional step needs no briefing.
    const check = await browser.post(
      '/api/me/onboarding/steps/policies.employee-handbook/complete',
    );
    assert.deepEqual([check.status, check.body.code], [409, 'CHECK_REQUIRED']);
    const optional = await browser.post(
      '/api/me/onboarding/steps/team-support.working-preferences/complete',
    );
    assert.equal(stepOf(optional.body, 'team-support.working-preferences').status, 'done');
    // Nothing gated changed anything.
    assert.deepEqual(Object.keys(app.firestore.read(`onboardingProgress/${id}`).steps), [
      'team-support.working-preferences',
    ]);

    // HR's own verification of a step is not gated by the briefing.
    const verified = await hr.patch(
      `/api/hr/employees/${id}/onboarding/steps/documentation.employee-information-form`,
      { status: 'done' },
    );
    assert.equal(verified.status, 200);
    assert.equal(stepOf(verified.body, 'documentation.employee-information-form').status, 'done');

    // After the briefing the check works.
    assert.equal(
      (await browser.post(briefingPath('policies.employee-handbook'), { completion: 'read' }))
        .status,
      200,
    );
    assert.equal(
      (await browser.get('/api/me/onboarding/steps/policies.employee-handbook/check')).status,
      200,
    );
  });
});

// The checklist agent stand-in. Like the real agent (rules.py), it proposes
// nothing for a step that still needs its briefing, unless `ignoreBriefing`.
function fakeAgent(app, { ignoreBriefing = false } = {}) {
  const calls = [];
  const sessions = new Map();
  return {
    calls,
    async start({ accountId, text }) {
      calls.push(['start', text]);
      const sessionId = `checklist-${randomUUID()}`;
      const stepId = /overview/i.test(text) ? 'alignment.mission-values' : null;
      if (!stepId) return { sessionId, text: 'Which step did you finish?', confirmation: null };
      const record = app.firestore.read(`onboardingProgress/${accountId}`)?.steps?.[stepId];
      if (!ignoreBriefing && !record?.briefedAt)
        return {
          sessionId,
          text: "Before I mark it, please listen to Alya's briefing for Read and Understand Company Overview on your dashboard.",
          confirmation: null,
        };
      const callId = `adk-${randomUUID()}`;
      sessions.set(sessionId, { accountId, stepId, callId });
      return { sessionId, text: '', confirmation: { callId, stepId } };
    },
    async resume({ accountId, sessionId, confirmed }) {
      calls.push(['resume', confirmed]);
      const session = sessions.get(sessionId);
      if (!confirmed || !session) return { text: 'Okay, I left it unchanged.', confirmation: null };
      const path = `onboardingProgress/${accountId}`;
      const current = app.firestore.read(path) || { accountId, steps: {} };
      const at = app.clock.now().toISOString();
      app.firestore.write(path, {
        accountId,
        updatedAt: at,
        steps: {
          ...current.steps,
          [session.stepId]: {
            ...(current.steps[session.stepId] || {}),
            status: 'done',
            updatedAt: at,
            source: 'alya-agent',
            actorId: accountId,
          },
        },
      });
      return { text: 'Done! Your company overview step is marked.', confirmation: null };
    },
    async remove({ sessionId }) {
      sessions.delete(sessionId);
    },
    async removeUser() {
      return 0;
    },
  };
}
// gemini-chat models whose plan routes "I've ..." to the checklist agent.
const planningModels = () => ({
  plan: {
    invoke: async (messages) =>
      /^i('ve| have)/i.test(String(messages.at(-1).content))
        ? {
            kind: 'checklist',
            query: 'I have read the company overview',
            clarification: '',
            category: 'onboarding',
            topic: 'checklist',
          }
        : {
            kind: 'company',
            query: 'chat groups',
            clarification: '',
            category: 'onboarding',
            topic: 'chat groups',
          },
  },
  answer: {
    invoke: async () => ({ answer: 'A buddy helps you.', citations: [1], coverage: 'full' }),
  },
  summarize: { invoke: async () => new AIMessage('Earlier questions.') },
});
async function withAgent(agentOptions, check) {
  const holder = {};
  const app = await startAccountsApp({
    mode: 'gemini-chat',
    models: planningModels,
    checklistAgent: {
      start: (...a) => holder.agent.start(...a),
      resume: (...a) => holder.agent.resume(...a),
      remove: (...a) => holder.agent.remove(...a),
      removeUser: (...a) => holder.agent.removeUser(...a),
    },
  });
  holder.agent = fakeAgent(app, agentOptions);
  try {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    await check({ app, browser, id: employee.account.id, agent: holder.agent });
  } finally {
    await app.close();
  }
}
const ask = (browser, conversationId, question) =>
  browser.post('/api/chat', {
    question,
    taskId: 'quiz-part-1',
    conversationId,
    requestId: randomUUID(),
  });

test('the agent: "I\'ve read the company overview" before the briefing points to it and proposes nothing', async () => {
  await withAgent({}, async ({ app, browser }) => {
    const chat = (await browser.post('/api/conversations')).body;
    const before = await ask(browser, chat.id, "I've read the company overview");
    assert.equal(before.status, 200);
    assert.equal(before.body.proposedAction, null);
    assert.match(
      before.body.answer,
      /listen to Alya's briefing for Read and Understand Company Overview/,
    );
    assert.deepEqual(app.firestore.paths('agentActions/'), []);
    assert.deepEqual(app.firestore.paths('onboardingProgress/'), []);
    // After the briefing the same message is a proposal.
    await browser.post(briefingPath('alignment.mission-values'), {
      completion: 'listened',
    });
    const after = await ask(browser, chat.id, "I've read the company overview");
    assert.equal(after.body.proposedAction.stepId, 'alignment.mission-values');
    const approved = await browser.post(`/api/me/agent-actions/${after.body.proposedAction.id}`, {
      decision: 'approve',
    });
    assert.equal(approved.status, 200);
    assert.equal(stepOf(approved.body.onboarding, 'alignment.mission-values').status, 'done');
  });
});

test('the backstop: an agent that proposes an unbriefed step anyway is answered no, and approving needs the briefing', async () => {
  await withAgent({ ignoreBriefing: true }, async ({ app, browser, id, agent }) => {
    const chat = (await browser.post('/api/conversations')).body;
    const proposed = await ask(browser, chat.id, "I've read the company overview");
    assert.equal(proposed.body.proposedAction, null);
    assert.equal(proposed.body.answer, briefingFirstText('Read and Understand Company Overview'));
    assert.deepEqual(agent.calls.at(-1), ['resume', false]);
    assert.deepEqual(app.firestore.paths('agentActions/'), []);

    // An action that is already pending (made before v1.5) cannot be approved
    // until the briefing; it stays pending, and declining is never gated.
    const at = app.clock.now();
    const action = {
      id: randomUUID(),
      accountId: id,
      conversationId: chat.id,
      messageId: 'synthetic-message',
      stepId: 'alignment.mission-values',
      newStatus: 'done',
      status: 'pending',
      agentSessionId: 'checklist-synthetic',
      confirmationCallId: 'adk-synthetic',
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + 30 * 60 * 1000).toISOString(),
      decidedAt: null,
    };
    app.firestore.write(`agentActions/${action.id}`, action);
    const refused = await browser.post(`/api/me/agent-actions/${action.id}`, {
      decision: 'approve',
    });
    assert.deepEqual([refused.status, refused.body.code], [409, 'BRIEFING_REQUIRED']);
    assert.equal(app.firestore.read(`agentActions/${action.id}`).status, 'pending');
    await browser.post(briefingPath('alignment.mission-values'), { completion: 'read' });
    const approved = await browser.post(`/api/me/agent-actions/${action.id}`, {
      decision: 'approve',
    });
    assert.equal(approved.status, 200);
    assert.equal(app.firestore.read(`agentActions/${action.id}`).status, 'approved');
  });
});

test('Helpful: marking a briefing or a step’s chat answer (or re-explanation) helpful unlocks the quick check and step completion', async () => {
  await withEmployee({}, async ({ app, browser, id }) => {
    // 1. Direct briefing route with completion: 'helpful'.
    const direct = await browser.post(briefingPath('alignment.mission-values'), {
      completion: 'helpful',
    });
    assert.equal(direct.status, 200);
    assert.equal(stepOf(direct.body, 'alignment.mission-values').briefed, true);
    assert.equal(
      app.firestore.read(`onboardingProgress/${id}`).steps['alignment.mission-values'].briefedBy,
      'helpful',
    );

    // 2. Asking a check step's question in chat and clicking Helpful unlocks its check.
    const chat = (await browser.post('/api/conversations')).body;
    const req1 = randomUUID();
    const answered = await browser.post('/api/chat', {
      question: 'What does the Employee Handbook say about the dress code?',
      taskId: 'quiz-part-1',
      conversationId: chat.id,
      requestId: req1,
      quickQuestionId: 'step:policies.employee-handbook',
    });
    assert.equal(answered.status, 200);
    // Still gated before Helpful.
    const gatedCheck = await browser.get(
      '/api/me/onboarding/steps/policies.employee-handbook/check',
    );
    assert.deepEqual([gatedCheck.status, gatedCheck.body.code], [409, 'BRIEFING_REQUIRED']);

    const feedback = await browser.post(`/api/conversations/${chat.id}/feedback`, {
      messageId: `${req1}-a`,
      rating: 'helpful',
    });
    assert.deepEqual([feedback.status, feedback.body], [200, { rating: 'helpful' }]);

    // Now the quick check with Alya is unlocked without needing the briefing first.
    const unlockedCheck = await browser.get(
      '/api/me/onboarding/steps/policies.employee-handbook/check',
    );
    assert.equal(unlockedCheck.status, 200);
    const passed = await browser.post('/api/me/onboarding/steps/policies.employee-handbook/check', {
      optionId: 'h8t3',
    });
    assert.equal(passed.status, 200);
    assert.equal(passed.body.correct, true);
    assert.equal(stepOf(passed.body.onboarding, 'policies.employee-handbook').status, 'done');

    // 3. A re-explanation (reexplainOf) marked Helpful also unlocks its step.
    const req2 = randomUUID();
    await browser.post('/api/chat', {
      question: 'How do I submit my Employee Information Form?',
      taskId: 'quiz-part-1',
      conversationId: chat.id,
      requestId: req2,
      quickQuestionId: 'step:documentation.employee-information-form',
    });
    const req3 = randomUUID();
    await browser.post('/api/chat', {
      question:
        'Please keep the answer brief for this question: How do I submit my Employee Information Form?',
      taskId: 'quiz-part-1',
      conversationId: chat.id,
      requestId: req3,
      reexplainOf: `${req2}-a`,
    });
    await browser.post(`/api/conversations/${chat.id}/feedback`, {
      messageId: `${req3}-a`,
      rating: 'helpful',
    });
    // Marking it helpful records the briefing; a document step still needs its upload.
    const submitted = await browser.post(
      '/api/me/onboarding/steps/documentation.employee-information-form/complete',
    );
    assert.deepEqual([submitted.status, submitted.body.code], [409, 'DOCUMENT_REQUIRED']);
  });
});
