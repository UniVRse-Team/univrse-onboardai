// Proposed checklist changes (#51) through the api: routing a completion report
// to the checklist agent, agentActions, POST /api/me/agent-actions/:id and the
// saved messages. The agent is a stand-in with the Python agent's behaviour
// (it writes onboardingProgress itself after an approval); pg-mem, the
// in-memory Firestore fake and synthetic people only. No Python, no Gemini.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { startAccountsApp, syntheticProfile } from './account-harness.mjs';
import { reportsCompletion } from '../../server/agent-actions.mjs';

const MINUTE = 60 * 1000;
const ask = (browser, conversationId, question, requestId = randomUUID()) =>
  browser.post('/api/chat', { question, taskId: 'quiz-part-1', conversationId, requestId });

// Like the Python agent: proposes mark_step for self and hr_verify steps
// (ADK tool confirmation), explains check steps, asks when unsure, and writes
// the step only when resumed with confirmed true.
function fakeAgent(app) {
  const sessions = new Map();
  const calls = [];
  const steps = [
    ['buddy', 'team-support.company-chat-groups', 'done'],
    ['chat', 'team-support.company-chat-groups', 'done'],
    ['ai practice', 'role-tools.ai-readiness-training', 'done'],
    ['contract', 'documentation.tax-id-documents', 'submitted'],
    ['handbook', 'policies.employee-handbook', null],
    ['mystery', 'nonsense.step', 'done'],
  ];
  return {
    calls,
    sessions,
    async start({ accountId, track, text }) {
      calls.push(['start', { accountId, track, text }]);
      const sessionId = `checklist-${randomUUID()}`;
      const match = steps.find(([word]) => text.toLowerCase().includes(word));
      if (!match) return { sessionId, text: 'Which step did you finish?', confirmation: null };
      if (!match[2])
        return {
          sessionId,
          text: 'That step is a short scenario check: take it on your onboarding dashboard.',
          confirmation: null,
        };
      const callId = `adk-${randomUUID()}`;
      sessions.set(sessionId, { accountId, stepId: match[1], status: match[2], callId });
      return { sessionId, text: '', confirmation: { callId, stepId: match[1] } };
    },
    async resume({ accountId, sessionId, callId, confirmed }) {
      calls.push(['resume', { accountId, sessionId, callId, confirmed }]);
      const session = sessions.get(sessionId);
      assert.ok(session && session.accountId === accountId && session.callId === callId);
      if (!confirmed) return { text: 'Okay, I left it unchanged.', confirmation: null };
      const path = `onboardingProgress/${accountId}`;
      const at = app.clock.now().toISOString();
      const current = app.firestore.read(path) || { accountId, steps: {} };
      const next = {
        ...current,
        accountId,
        updatedAt: at,
        steps: {
          ...current.steps,
          [session.stepId]: {
            ...(current.steps[session.stepId] || {}),
            status: session.status,
            updatedAt: at,
            source: 'alya-agent',
            actorId: accountId,
          },
        },
      };
      if (session.stepId === 'role-tools.ai-readiness-training' && session.status === 'done') {
        next.aiProficiency = {
          ...(current.aiProficiency || {
            status: 'unanswered',
            level: null,
            learningPathId: 'beginner',
            assessedAt: null,
          }),
          updatedAt: at,
          trainingCompleted: true,
          trainingCompletedAt: at,
        };
      }
      app.firestore.write(path, next);
      return {
        text: 'Done! Your next step is to sign your employment contract.',
        confirmation: null,
      };
    },
    async remove({ accountId, sessionId }) {
      calls.push(['remove', { accountId, sessionId }]);
      sessions.delete(sessionId);
    },
    async removeUser({ accountId }) {
      calls.push(['removeUser', { accountId }]);
      let removed = 0;
      for (const [id, session] of sessions)
        if (session.accountId === accountId) {
          sessions.delete(id);
          removed++;
        }
      return removed;
    },
  };
}

// gemini-chat models whose plan says "checklist" for completion reports.
const planningModels = () => ({
  plan: {
    invoke: async (messages) => {
      const text = String(messages.at(-1).content).toLowerCase();
      return /^i('ve| have)? |^done/.test(text)
        ? {
            kind: 'checklist',
            query: `I ${text.replace(/^i('ve| have)? /, 'have ')}`,
            clarification: '',
            category: 'onboarding',
            topic: 'checklist',
          }
        : {
            kind: 'company',
            query: 'dress code',
            clarification: '',
            category: 'onboarding',
            topic: 'dress code',
          };
    },
  },
  answer: {
    invoke: async () => ({ answer: 'Business casual clothing.', citations: [1], coverage: 'full' }),
  },
  summarize: { invoke: async () => new AIMessage('Earlier questions.') },
});

// Every stored step status, as "<progress path>:<stepId>": status. The
// briefing records of v1.5 carry no status, so "nothing was marked" is {}.
const statusesIn = (app) =>
  Object.fromEntries(
    app.firestore.paths('onboardingProgress/').flatMap((path) =>
      Object.entries(app.firestore.read(path).steps || {})
        .filter(([, entry]) => entry.status)
        .map(([stepId, entry]) => [`${path}:${stepId}`, entry.status]),
    ),
  );

// The agent needs the app's clock and Firestore, so it is attached after the
// app starts, through a forwarding stand-in.
async function withAgentApp(options, check) {
  const holder = {};
  const { briefed, ...appOptions } = options;
  const app = await startAccountsApp({
    mode: 'gemini-chat',
    models: planningModels,
    ...appOptions,
    checklistAgent: {
      start: (...a) => holder.agent.start(...a),
      resume: (...a) => holder.agent.resume(...a),
      remove: (...a) => holder.agent.remove(...a),
      removeUser: (...a) => holder.agent.removeUser(...a),
    },
  });
  holder.agent = fakeAgent(app);
  // These employees have had every briefing (contract v1.5): the tests below
  // are about proposals and decisions. The briefing gate has its own tests.
  if (briefed !== false) {
    const ready = app.readyEmployee.bind(app);
    app.readyEmployee = async (...args) => {
      const made = await ready(...args);
      app.briefAll(made.employee.account.id);
      return made;
    };
  }
  try {
    await check(app, holder.agent);
  } finally {
    await app.close();
  }
}

test('"I\'ve met my buddy today": a proposal, nothing written until Approve, then done and the next step', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    const id = employee.account.id;
    const chat = (await browser.post('/api/conversations')).body;
    const requestId = randomUUID();
    const answered = await ask(browser, chat.id, "I've met my buddy today", requestId);
    assert.equal(answered.status, 200, answered.text);
    const action = answered.body.proposedAction;
    assert.deepEqual(Object.keys(action), [
      'id',
      'stepId',
      'stepTitle',
      'areaTitle',
      'newStatus',
      'status',
      'expiresAt',
    ]);
    assert.deepEqual(
      [action.stepId, action.stepTitle, action.areaTitle, action.newStatus, action.status],
      [
        'team-support.company-chat-groups',
        'Join company chat groups',
        'People & Workplace Support',
        'done',
        'pending',
      ],
    );
    assert.equal(action.expiresAt, new Date(app.clock.now().getTime() + 30 * MINUTE).toISOString());
    assert.equal(answered.body.answer, 'Shall I mark “Join company chat groups” as done?');
    assert.deepEqual(
      [answered.body.coverage, answered.body.category, answered.body.source],
      [null, 'onboarding', 'Your onboarding checklist'],
    );
    // The agent got the plan's standalone sentence; the account id only through its own parameter.
    assert.deepEqual(agent.calls[0], [
      'start',
      { accountId: id, track: 'employee', text: 'I have met my buddy today' },
    ]);
    // Stored: the contract shape, and nothing written to the progress yet.
    const stored = app.firestore.read(`agentActions/${action.id}`);
    assert.deepEqual(Object.keys(stored).sort(), [
      'accountId',
      'agentSessionId',
      'confirmationCallId',
      'conversationId',
      'createdAt',
      'decidedAt',
      'expiresAt',
      'id',
      'messageId',
      'newStatus',
      'status',
      'stepId',
    ]);
    assert.deepEqual(
      [stored.accountId, stored.conversationId, stored.messageId, stored.status, stored.decidedAt],
      [id, chat.id, `${requestId}-a`, 'pending', null],
    );
    assert.deepEqual(statusesIn(app), {});
    // The saved message carries the proposal at the top level.
    let opened = (await browser.get(`/api/conversations/${chat.id}`)).body.messages;
    assert.deepEqual(opened[1].proposedAction, action);

    const approved = await browser.post(`/api/me/agent-actions/${action.id}`, {
      decision: 'approve',
    });
    assert.equal(approved.status, 200, approved.text);
    assert.deepEqual(approved.body.action, { ...action, status: 'approved' });
    assert.equal(approved.body.reply, 'Done! Your next step is to sign your employment contract.');
    const chatGroup = approved.body.onboarding.areas[4].steps.find(
      (s) => s.id === 'team-support.company-chat-groups',
    );
    assert.deepEqual([chatGroup.status, chatGroup.source], ['done', 'alya-agent']);
    assert.equal(approved.body.onboarding.nextStep.id, 'documentation.tax-id-documents');
    assert.equal(app.firestore.read(`agentActions/${action.id}`).status, 'approved');
    // The reply is a new assistant message; the proposal shows its status.
    opened = (await browser.get(`/api/conversations/${chat.id}`)).body.messages;
    assert.equal(opened.length, 3);
    assert.equal(opened[1].proposedAction.status, 'approved');
    assert.deepEqual(
      [opened[2].role, opened[2].text, opened[2].proposedAction, opened[2].category],
      ['assistant', approved.body.reply, null, 'onboarding'],
    );
    // The agent session is gone once the action resolved.
    assert.equal(agent.sessions.size, 0);
    assert.equal(agent.calls.at(-1)[0], 'remove');
    // Single use.
    const again = await browser.post(`/api/me/agent-actions/${action.id}`, { decision: 'approve' });
    assert.deepEqual([again.status, again.body.code], [409, 'ACTION_NOT_PENDING']);
  });
});

test('"Not yet" leaves the step unchanged and the action cannot be approved later', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const { proposedAction } = (await ask(browser, chat.id, "I've met my buddy")).body;
    const declined = await browser.post(`/api/me/agent-actions/${proposedAction.id}`, {
      decision: 'decline',
    });
    assert.equal(declined.status, 200);
    assert.deepEqual(
      [declined.body.action.status, declined.body.reply, declined.body.onboarding],
      ['declined', 'Okay, I left it unchanged.', null],
    );
    assert.deepEqual(agent.calls.find((c) => c[0] === 'resume')[1].confirmed, false);
    assert.deepEqual(statusesIn(app), {});
    const late = await browser.post(`/api/me/agent-actions/${proposedAction.id}`, {
      decision: 'approve',
    });
    assert.deepEqual([late.status, late.body.code], [409, 'ACTION_NOT_PENDING']);
    assert.deepEqual(statusesIn(app), {});
  });
});

test('a document step is never marked through chat; a policy step points to the check and marks nothing', async () => {
  await withAgentApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const contract = (await ask(browser, chat.id, 'I signed my contract')).body;
    assert.equal(contract.proposedAction, null);
    assert.match(contract.answer, /upload your document/i);
    assert.match(contract.answer, /submitted once it is saved/);
    const saved = app.firestore.read(`onboardingProgress/${employee.account.id}`);
    assert.equal(saved?.steps?.['documentation.tax-id-documents']?.status, undefined);

    const handbook = (await ask(browser, chat.id, "I've read the handbook")).body;
    assert.equal(handbook.proposedAction, null);
    assert.match(handbook.answer, /scenario check/);
    const progress = app.firestore.read(`onboardingProgress/${employee.account.id}`);
    assert.equal(progress.steps['policies.employee-handbook']?.status, undefined);
    // A proposal for a step the employee's template does not have is answered
    // no for them, so nothing can change.
    const odd = (await ask(browser, chat.id, "I've finished the mystery step")).body;
    assert.equal(odd.proposedAction, null);
    assert.equal(app.firestore.paths('agentActions/').length, 0); // nothing was proposed
  });
});

test('only the owner can decide, only while pending and before it expires; invalid decisions are 400', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const other = await app.readyEmployee(hr, { profile: syntheticProfile('Blake Sample') });
    const chat = (await browser.post('/api/conversations')).body;
    const { proposedAction } = (await ask(browser, chat.id, "I've met my buddy")).body;
    const path = `/api/me/agent-actions/${proposedAction.id}`;
    for (const [who, body, status, code] of [
      [other.browser, { decision: 'approve' }, 409, 'ACTION_NOT_PENDING'],
      [hr, { decision: 'approve' }, 403, 'EMPLOYEE_ROLE_REQUIRED'],
      [app.browser(), { decision: 'approve' }, 401, 'AUTH_REQUIRED'],
      [browser, { decision: 'yes' }, 400, 'ACTION_DECISION_INVALID'],
      [browser, { decision: 'approve', stepId: 'x' }, 400, 'ACTION_DECISION_INVALID'],
    ]) {
      const refused = await who.post(path, body);
      assert.deepEqual([refused.status, refused.body.code], [status, code]);
    }
    const unknown = await browser.post(`/api/me/agent-actions/${randomUUID()}`, {
      decision: 'approve',
    });
    assert.deepEqual([unknown.status, unknown.body.code], [409, 'ACTION_NOT_PENDING']);
    const foreign = await browser.post(
      path,
      { decision: 'approve' },
      { origin: 'https://attacker.example' },
    );
    assert.equal(foreign.status, 403);
    assert.equal(app.firestore.read(`agentActions/${proposedAction.id}`).status, 'pending');
    assert.deepEqual(statusesIn(app), {});

    // After 30 minutes it has expired: 409, marked expired, the session deleted.
    app.clock.advance(31 * MINUTE);
    const expired = await browser.post(path, { decision: 'approve' });
    assert.deepEqual([expired.status, expired.body.code], [409, 'ACTION_NOT_PENDING']);
    assert.equal(app.firestore.read(`agentActions/${proposedAction.id}`).status, 'expired');
    assert.equal(agent.sessions.size, 0);
    const opened = (await browser.get(`/api/conversations/${chat.id}`)).body.messages;
    assert.equal(opened[1].proposedAction.status, 'expired');
    assert.deepEqual(statusesIn(app), {});
  });
});

test('an expired proposal nobody answered is closed when the employee proposes the next one', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const first = (await ask(browser, chat.id, "I've met my buddy")).body.proposedAction;
    app.clock.advance(31 * MINUTE);
    await browser.signIn('PC-0001', 'employee-own-pass-1');
    // Shown as expired straight away, before anything else runs.
    assert.equal(
      (await browser.get(`/api/conversations/${chat.id}`)).body.messages[1].proposedAction.status,
      'expired',
    );
    await ask(browser, chat.id, "I've met my buddy");
    assert.equal(app.firestore.read(`agentActions/${first.id}`).status, 'expired');
    assert.equal(agent.sessions.size, 1); // only the new proposal's session
  });
});

test('routing: questions take the normal path; HR accounts and personal chips never reach the agent', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const question = await ask(browser, chat.id, 'What should I wear?');
    assert.equal(question.body.proposedAction, null);
    assert.equal(question.body.coverage, 'full');
    // HR: a completion-like message is an ordinary company question.
    const hrChat = (await hr.post('/api/conversations')).body;
    const hrAnswer = await ask(hr, hrChat.id, "I've met my buddy");
    assert.equal(hrAnswer.body.proposedAction, null);
    assert.equal(agent.calls.length, 0);
  });
});

test('document-search: a conservative heuristic routes completion reports only', async () => {
  await withAgentApp({ mode: 'document-search' }, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const searched = await ask(browser, chat.id, 'How do I meet my buddy?');
    assert.equal(searched.body.mode, 'document-search');
    assert.equal(searched.body.proposedAction, null);
    assert.equal(agent.calls.length, 0);
    const reported = await ask(browser, chat.id, "I've met my buddy today");
    assert.equal(reported.body.proposedAction.stepId, 'team-support.company-chat-groups');
    assert.equal(agent.calls[0][1].text, "I've met my buddy today");
    const opened = (await browser.get(`/api/conversations/${chat.id}`)).body.messages;
    assert.equal(opened[3].proposedAction.status, 'pending');
  });
});

test('AI proficiency in chat: self-assessment rating saves learning path without marking step done; completing practice task proposes role-tools.ai-readiness-training', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    const id = employee.account.id;
    const chat = (await browser.post('/api/conversations')).body;

    // 1. Reporting an AI self-assessment rating in chat saves the rating and learning path, without proposing or completing the step.
    const rated = await ask(browser, chat.id, 'My AI level is 5');
    assert.equal(rated.status, 200);
    assert.equal(rated.body.proposedAction, null);
    assert.match(rated.body.answer, /Better Prompts & Checking Results/);
    assert.match(rated.body.answer, /Practice task:/);
    assert.equal(agent.calls.length, 0);
    const storedAfterRating = app.firestore.read(`onboardingProgress/${id}`);
    assert.equal(storedAfterRating.aiProficiency.status, 'assessed');
    assert.equal(storedAfterRating.aiProficiency.level, 5);
    assert.equal(storedAfterRating.aiProficiency.learningPathId, 'intermediate');
    assert.equal(storedAfterRating.aiProficiency.trainingCompleted, false);
    assert.equal(
      statusesIn(app)[`onboardingProgress/${id}:role-tools.ai-readiness-training`],
      undefined,
    );

    // 2. Reporting completion of the AI practice task proposes role-tools.ai-readiness-training, and approving marks trainingCompleted = true and step done.
    const completed = await ask(browser, chat.id, 'I finished the AI practice task');
    assert.equal(completed.status, 200);
    assert.equal(completed.body.proposedAction.stepId, 'role-tools.ai-readiness-training');
    const approved = await browser.post(
      `/api/me/agent-actions/${completed.body.proposedAction.id}`,
      { decision: 'approve' },
    );
    assert.equal(approved.status, 200);
    const aiStep = approved.body.onboarding.areas[3].steps.find(
      (s) => s.id === 'role-tools.ai-readiness-training',
    );
    assert.equal(aiStep.status, 'done');
    assert.equal(approved.body.onboarding.aiProficiency.trainingCompleted, true);
  });
});

test('with the agent off, completion reports are ordinary questions and no action can be decided', async () => {
  const app = await startAccountsApp({ mode: 'gemini-chat', models: planningModels });
  try {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const answer = await ask(browser, chat.id, "I've met my buddy");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.proposedAction, null);
    assert.equal(answer.body.coverage, 'full'); // answered from the documents
    const decide = await browser.post(`/api/me/agent-actions/${randomUUID()}`, {
      decision: 'approve',
    });
    assert.deepEqual([decide.status, decide.body.code], [409, 'ACTION_NOT_PENDING']);
  } finally {
    await app.close();
  }
});

test('an agent failure answers politely, saves no action and lets a decision be retried', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const start = agent.start;
    agent.start = async () => {
      throw Object.assign(new Error('down'), { code: 'RUN_UNREACHABLE' });
    };
    const failed = await ask(browser, chat.id, "I've met my buddy");
    assert.equal(failed.status, 200);
    assert.equal(failed.body.proposedAction, null);
    assert.match(failed.body.answer, /couldn’t update your onboarding checklist/);
    agent.start = start;
    const { proposedAction } = (await ask(browser, chat.id, "I've met my buddy")).body;
    const resume = agent.resume;
    agent.resume = async () => {
      throw Object.assign(new Error('down'), { code: 'RUN_HTTP_503' });
    };
    const broken = await browser.post(`/api/me/agent-actions/${proposedAction.id}`, {
      decision: 'approve',
    });
    assert.deepEqual([broken.status, broken.body.code], [502, 'CHECKLIST_AGENT_UNAVAILABLE']);
    assert.equal(app.firestore.read(`agentActions/${proposedAction.id}`).status, 'pending');
    agent.resume = resume;
    const retried = await browser.post(`/api/me/agent-actions/${proposedAction.id}`, {
      decision: 'approve',
    });
    assert.equal(retried.body.action.status, 'approved');
  });
});

test('deleting an employee deletes their agent actions', async () => {
  await withAgentApp({}, async (app) => {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    const kept = await app.readyEmployee(hr, { profile: syntheticProfile('Blake Sample') });
    for (const who of [browser, kept.browser]) {
      const chat = (await who.post('/api/conversations')).body;
      await ask(who, chat.id, "I've met my buddy");
    }
    const owners = () =>
      app.firestore.paths('agentActions/').map((p) => app.firestore.read(p).accountId);
    assert.deepEqual(owners().sort(), [employee.account.id, kept.employee.account.id].sort());
    assert.equal((await hr.delete(`/api/hr/employees/${employee.account.id}`)).status, 204);
    assert.deepEqual(owners(), [kept.employee.account.id]);
  });
});

test('deleting an employee deletes their agent sessions too; an unreachable agent does not stop it', async () => {
  await withAgentApp({}, async (app, agent) => {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    const kept = await app.readyEmployee(hr, { profile: syntheticProfile('Blake Sample') });
    for (const who of [browser, kept.browser]) {
      const chat = (await who.post('/api/conversations')).body;
      await ask(who, chat.id, "I've met my buddy");
    }
    assert.equal(agent.sessions.size, 2);
    assert.equal((await hr.delete(`/api/hr/employees/${employee.account.id}`)).status, 204);
    assert.deepEqual(agent.calls.at(-1), ['removeUser', { accountId: employee.account.id }]);
    // Only the deleted employee's session is gone.
    assert.deepEqual(
      [...agent.sessions.values()].map((s) => s.accountId),
      [kept.employee.account.id],
    );
    // The agent is down: the deletion still succeeds and the failure is logged (code only).
    agent.removeUser = async () => {
      throw Object.assign(new Error('fetch failed: private'), { code: 'SESSION_LIST_UNREACHABLE' });
    };
    assert.equal((await hr.delete(`/api/hr/employees/${kept.employee.account.id}`)).status, 204);
    assert.equal((await hr.get(`/api/hr/employees/${kept.employee.account.id}`)).status, 404);
    assert.ok(
      app.logs.includes(
        'Checklist agent: {"operation":"delete employee sessions","outcome":"SESSION_LIST_UNREACHABLE"}',
      ),
    );
    assert.deepEqual(app.firestore.paths('agentActions/'), []);
  });
});

test('the completion heuristic is conservative', () => {
  for (const text of [
    "I've met my buddy today",
    'I signed my contract',
    'I have finished the IT security e-learning',
    'I just set up my laptop',
    'Done with the emergency contact form',
    'We met the whole team this morning',
  ])
    assert.equal(reportsCompletion(text), true, text);
  for (const text of [
    'How do I meet my buddy?',
    'Have I met all the requirements?',
    "I haven't signed my contract yet",
    'I need to sign my contract',
    'I will meet my buddy tomorrow',
    'What is the dress code',
    'Can you mark my buddy step as done',
    'The contract was signed by HR',
    '',
  ])
    assert.equal(reportsCompletion(text), false, text);
});
