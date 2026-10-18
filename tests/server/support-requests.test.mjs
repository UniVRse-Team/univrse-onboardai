// Consented support requests and team insights (issue #48, D1 Option A):
// pg-mem, the in-memory Firestore fake and synthetic people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startAccountsApp, syntheticProfile } from './account-harness.mjs';
import { supportRequestId } from '../../server/support-requests.mjs';
import { DEFAULT_COMPANY_ID } from '../../server/companies.mjs';

async function withApp(options, check) {
  const app = await startAccountsApp(options);
  try {
    await check(app);
  } finally {
    await app.close();
  }
}
const ask = (browser, conversationId, question, requestId = randomUUID(), extra = {}) =>
  browser.post('/api/chat', {
    question,
    taskId: 'quiz-part-1',
    conversationId,
    requestId,
    ...extra,
  });
// An employee with one answered question: { browser, employee, chat, messageId, answer }.
async function employeeWithAnswer(
  app,
  hr,
  profile = syntheticProfile(),
  question = 'What should I wear?',
) {
  const { employee, browser } = await app.readyEmployee(hr, { profile });
  const chat = (await browser.post('/api/conversations')).body;
  const requestId = randomUUID();
  const answered = await ask(browser, chat.id, question, requestId);
  assert.equal(answered.status, 200, answered.text);
  return { employee, browser, chat, messageId: requestId + '-a', answer: answered.body };
}

test('the preview shows only the question, Alya’s answer and its sources; cancelling sends nothing', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const { browser, chat, messageId, answer } = await employeeWithAnswer(app, hr);
    // A second turn in the same chat must not leak into the preview.
    await ask(browser, chat.id, 'And a private follow-up about my health?');
    const preview = await browser.post('/api/me/support-requests/preview', {
      conversationId: chat.id,
      messageId,
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, {
      question: 'What should I wear?',
      alyaAnswer: answer.answer,
      sources: [{ title: 'Synthetic handbook', heading: 'Dress' }],
    });
    assert.ok(!preview.text.includes('private follow-up'));
    // Previewing (and cancelling) writes nothing and HR sees nothing.
    assert.deepEqual(app.firestore.paths('supportRequests/'), []);
    assert.deepEqual((await hr.get('/api/hr/support-requests')).body, {
      requests: [],
      counts: { open: 0, briefing_scheduled: 0, resolved: 0 },
    });
  });
});

test('previews and requests need an assistant message in the caller’s own conversation', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const avery = await employeeWithAnswer(app, hr);
    const blake = await employeeWithAnswer(app, hr, syntheticProfile('Blake Sample'));
    for (const path of ['/api/me/support-requests/preview', '/api/me/support-requests']) {
      for (const [body, code] of [
        // Another employee's conversation and message.
        [{ conversationId: blake.chat.id, messageId: blake.messageId }, 'CHAT_NOT_FOUND'],
        // Another employee's message id in my conversation.
        [{ conversationId: avery.chat.id, messageId: blake.messageId }, 'ANSWER_NOT_FOUND'],
        // My own question, not an answer.
        [
          { conversationId: avery.chat.id, messageId: avery.messageId.replace(/-a$/, '-u') },
          'ANSWER_NOT_FOUND',
        ],
        [{ conversationId: 'not-a-chat', messageId: avery.messageId }, 'CHAT_NOT_FOUND'],
      ]) {
        const refused = await avery.browser.post(path, body);
        assert.deepEqual([refused.status, refused.body.code], [404, code], `${path} ${code}`);
      }
    }
    const malformed = await avery.browser.post('/api/me/support-requests/preview', {});
    assert.equal(malformed.status, 404);
    assert.deepEqual(app.firestore.paths('supportRequests/'), []);
  });
});

test('confirming creates one request per answer, records a help observation and appears for HR by name', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const { employee, browser, chat, messageId, answer } = await employeeWithAnswer(app, hr);
    const created = await browser.post('/api/me/support-requests', {
      conversationId: chat.id,
      messageId,
      note: '  I still do not get the Friday rule.  ',
    });
    assert.equal(created.status, 201);
    const id = supportRequestId(employee.account.id, chat.id, messageId);
    assert.deepEqual(created.body, {
      request: {
        id,
        messageId,
        question: 'What should I wear?',
        status: 'open',
        briefingAt: null,
        createdAt: '2026-10-15T01:00:00.000Z',
        updatedAt: '2026-10-15T01:00:00.000Z',
      },
    });
    // The same answer again: 200 with the same request, nothing new.
    const repeated = await browser.post('/api/me/support-requests', {
      conversationId: chat.id,
      messageId,
      note: 'A different note',
    });
    assert.deepEqual([repeated.status, repeated.body], [200, created.body]);
    assert.deepEqual(app.firestore.paths('supportRequests/'), [`supportRequests/${id}`]);
    const stored = app.firestore.read(`supportRequests/${id}`);
    assert.equal(stored.employeeNote, 'I still do not get the Friday rule.');
    assert.equal(stored.accountId, employee.account.id);
    // The chat's existing human-help observation was recorded too.
    const summary = await app.memory.supportSummary(`account:${employee.account.id}`);
    assert.equal(summary.humanHelpRequests, 1);
    const opened = await browser.get(`/api/conversations/${chat.id}`);
    assert.equal(opened.body.messages[1].humanHelpRequested, true);

    // The employee's list: status and briefing time, never HR's note.
    assert.deepEqual((await browser.get('/api/me/support-requests')).body, {
      requests: [created.body.request],
    });

    // HR: by name, without account or conversation ids.
    const list = await hr.get('/api/hr/support-requests');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.counts, { open: 1, briefing_scheduled: 0, resolved: 0 });
    assert.deepEqual(list.body.requests, [
      {
        id,
        companyId: DEFAULT_COMPANY_ID,
        assignedHrAccountId: null,
        messageId,
        question: 'What should I wear?',
        alyaAnswer: answer.answer,
        sources: [{ title: 'Synthetic handbook', heading: 'Dress' }],
        employeeNote: 'I still do not get the Friday rule.',
        status: 'open',
        hrNote: null,
        briefingAt: null,
        docNeedsUpdate: false,
        docToUpdate: null,
        createdAt: '2026-10-15T01:00:00.000Z',
        updatedAt: '2026-10-15T01:00:00.000Z',
        updatedBy: null,
        employee: { id: employee.account.id, username: 'PC-0001', name: 'Avery' },
        assignedHr: null,
      },
    ]);
    assert.ok(!list.text.includes(chat.id));
    assert.ok(!list.text.includes('"accountId"'));

    // Note limits.
    for (const note of ['x'.repeat(501), 42, 'bad\u0000char']) {
      const refused = await browser.post('/api/me/support-requests', {
        conversationId: chat.id,
        messageId,
        note,
      });
      assert.deepEqual([refused.status, refused.body.code], [400, 'SUPPORT_REQUEST_INVALID']);
    }
    const unknown = await browser.post('/api/me/support-requests', {
      conversationId: chat.id,
      messageId,
      extra: 1,
    });
    assert.deepEqual(unknown.body.fields, [{ field: 'extra', problem: 'unknown' }]);
  });
});

test('HR works a request through briefing_scheduled and resolved; the employee sees each status', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const hrId = (await hr.get('/api/auth/session')).body.account.id;
    const { employee, browser, chat, messageId } = await employeeWithAnswer(app, hr);
    const { id } = (
      await browser.post('/api/me/support-requests', { conversationId: chat.id, messageId })
    ).body.request;
    const path = `/api/hr/support-requests/${id}`;

    const noTime = await hr.patch(path, { status: 'briefing_scheduled' });
    assert.deepEqual([noTime.status, noTime.body.code], [400, 'BRIEFING_TIME_REQUIRED']);
    app.clock.advance(60000);
    const scheduled = await hr.patch(path, {
      status: 'briefing_scheduled',
      briefingAt: '2026-10-20T10:00:00+08:00',
      hrNote: 'Book the small room.',
    });
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.body.request.status, 'briefing_scheduled');
    assert.equal(scheduled.body.request.briefingAt, '2026-10-20T02:00:00.000Z');
    assert.equal(scheduled.body.request.hrNote, 'Book the small room.');
    assert.equal(scheduled.body.request.updatedBy, hrId);
    assert.equal(scheduled.body.request.updatedAt, '2026-10-15T01:01:00.000Z');
    assert.equal(scheduled.body.request.employee.name, 'Avery');
    const mine = (await browser.get('/api/me/support-requests')).body.requests[0];
    assert.deepEqual(
      [mine.status, mine.briefingAt, 'hrNote' in mine],
      ['briefing_scheduled', '2026-10-20T02:00:00.000Z', false],
    );
    // Clearing the time while scheduled is refused.
    const cleared = await hr.patch(path, { briefingAt: null });
    assert.equal(cleared.body.code, 'BRIEFING_TIME_REQUIRED');

    // Doc needs update: one of the request's source titles only.
    const wrongDoc = await hr.patch(path, { docNeedsUpdate: true, docToUpdate: 'Some other file' });
    assert.deepEqual(wrongDoc.body.fields, [{ field: 'docToUpdate', problem: 'invalid_choice' }]);
    const doc = await hr.patch(path, { docToUpdate: 'Synthetic handbook' });
    assert.deepEqual(
      [doc.body.request.docNeedsUpdate, doc.body.request.docToUpdate],
      [true, 'Synthetic handbook'],
    );
    const undoc = await hr.patch(path, { docNeedsUpdate: false });
    assert.deepEqual(
      [undoc.body.request.docNeedsUpdate, undoc.body.request.docToUpdate],
      [false, null],
    );

    const resolved = await hr.patch(path, { status: 'resolved', hrNote: null });
    assert.deepEqual(
      [resolved.body.request.status, resolved.body.request.hrNote],
      ['resolved', null],
    );
    assert.equal(
      (await browser.get('/api/me/support-requests')).body.requests[0].status,
      'resolved',
    );
    assert.deepEqual((await hr.get('/api/hr/support-requests')).body.counts, {
      open: 0,
      briefing_scheduled: 0,
      resolved: 1,
    });

    for (const [body, code] of [
      [{}, 'SUPPORT_REQUEST_INVALID'],
      [{ status: 'closed' }, 'SUPPORT_REQUEST_INVALID'],
      [{ hrNote: 'x'.repeat(1001) }, 'SUPPORT_REQUEST_INVALID'],
      [{ briefingAt: 'next Tuesday' }, 'SUPPORT_REQUEST_INVALID'],
      [{ briefingAt: '2026-10-20' }, 'SUPPORT_REQUEST_INVALID'],
      [{ docNeedsUpdate: 'yes' }, 'SUPPORT_REQUEST_INVALID'],
      [{ accountId: 'x' }, 'SUPPORT_REQUEST_INVALID'],
    ]) {
      const refused = await hr.patch(path, body);
      assert.deepEqual([refused.status, refused.body.code], [400, code], JSON.stringify(body));
    }
    for (const missing of ['0'.repeat(32), 'not-an-id']) {
      const refused = await hr.patch(`/api/hr/support-requests/${missing}`, { status: 'open' });
      assert.deepEqual([refused.status, refused.body.code], [404, 'SUPPORT_REQUEST_NOT_FOUND']);
    }
    // Successful changes wrote support_request_updated rows about the employee.
    const events = await app.rows(
      "SELECT actor_id, target_id FROM account_events WHERE action = 'support_request_updated'",
    );
    assert.equal(events.length, 4);
    assert.ok(events.every((e) => e.actor_id === hrId && e.target_id === employee.account.id));
  });
});

test('HR lists open requests first, then newest first', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const a = await employeeWithAnswer(app, hr);
    const b = await employeeWithAnswer(app, hr, syntheticProfile('Blake Sample'));
    const make = async (who) =>
      (
        await who.browser.post('/api/me/support-requests', {
          conversationId: who.chat.id,
          messageId: who.messageId,
        })
      ).body.request.id;
    const first = await make(a);
    app.clock.advance(1000);
    const second = await make(b);
    await hr.patch(`/api/hr/support-requests/${second}`, { status: 'resolved' });
    app.clock.advance(1000);
    const extra = randomUUID();
    await ask(a.browser, a.chat.id, 'Where is the dress code?', extra);
    const third = (
      await a.browser.post('/api/me/support-requests', {
        conversationId: a.chat.id,
        messageId: extra + '-a',
      })
    ).body.request.id;
    const listed = (await hr.get('/api/hr/support-requests')).body.requests.map((r) => r.id);
    assert.deepEqual(listed, [third, first, second]);
    // The employee sees only their own, newest first.
    assert.deepEqual(
      (await a.browser.get('/api/me/support-requests')).body.requests.map((r) => r.id),
      [third, first],
    );
  });
});

test('named per-employee summaries are gone; team insights need at least 3 employees with data', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const removed = await hr.get('/api/hr/support-summaries');
    assert.deepEqual([removed.status, removed.body.code], [404, 'NOT_FOUND']);

    const empty = await hr.get('/api/hr/team-insights');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, {
      minimumGroup: 3,
      employeesWithData: 0,
      available: false,
      openSupportRequests: 0,
    });
    const avery = await employeeWithAnswer(app, hr);
    const blake = await employeeWithAnswer(app, hr, syntheticProfile('Blake Sample'));
    // An employee without activity does not count.
    await app.readyEmployee(hr, { profile: syntheticProfile('Casey Example') });
    await avery.browser.post('/api/me/support-requests', {
      conversationId: avery.chat.id,
      messageId: avery.messageId,
    });
    const two = (await hr.get('/api/hr/team-insights')).body;
    assert.deepEqual(two, {
      minimumGroup: 3,
      employeesWithData: 2,
      available: false,
      openSupportRequests: 1,
    });

    const dana = await employeeWithAnswer(app, hr, syntheticProfile('Dana Sample'));
    // The "Keep it brief" button's text counts as a brief request (issue #48 fix).
    await ask(dana.browser, dana.chat.id, 'Please keep the answer brief.');
    await blake.browser.post(`/api/conversations/${blake.chat.id}/feedback`, {
      messageId: blake.messageId,
      rating: 'unclear',
    });
    const three = await hr.get('/api/hr/team-insights');
    // The chat store keeps its own (real) clock; the period is calendar days only.
    const { period } = three.body;
    assert.match(period.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(period.to, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(period.from <= period.to);
    assert.deepEqual(three.body, {
      minimumGroup: 3,
      employeesWithData: 3,
      available: true,
      openSupportRequests: 1,
      period,
      turns: 4,
      feedback: { helpful: 0, unclear: 1 },
      formats: { standard: 3, steps: 0, example: 0, brief: 1 },
      requests: { steps: 0, example: 0, brief: 1 },
      humanHelpRequests: 1,
    });
    // Aggregates only: no names, IDs, questions or answers.
    for (const text of [
      'Avery',
      'PC-0001',
      'What should I wear?',
      avery.chat.id,
      avery.answer.answer,
    ])
      assert.ok(!three.text.includes(text), text);
  });
});

test('the employee’s recording choice is respected by team insights', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const people = [];
    for (const name of ['Avery Example', 'Blake Sample', 'Casey Example'])
      people.push(await employeeWithAnswer(app, hr, syntheticProfile(name)));
    assert.equal((await hr.get('/api/hr/team-insights')).body.turns, 3);
    const paused = await people[0].browser.post('/api/support-summary/settings', {
      recording: false,
    });
    assert.equal(paused.status, 200);
    await ask(people[0].browser, people[0].chat.id, 'And on Fridays?');
    assert.equal((await hr.get('/api/hr/team-insights')).body.turns, 3);
    // A chat-store failure is the HR routes' Firestore error.
    app.firestore.fail(14, { only: ['query'] });
    const failed = await hr.get('/api/hr/team-insights');
    assert.deepEqual([failed.status, failed.body.code], [503, 'PROFILE_STORAGE_UNAVAILABLE']);
  });
});

test('D2: a re-explained answer’s request carries the employee’s original question, not the app’s prompt', async () => {
  await withApp({ mode: 'gemini-chat' }, async (app) => {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const chat = (await browser.post('/api/conversations')).body;
    const original = 'Which documents do I bring on my first day?';
    const first = randomUUID();
    await ask(browser, chat.id, original, first);
    // Two re-explanations in a row, each naming the answer it re-explains.
    const second = randomUUID();
    const steps = await ask(
      browser,
      chat.id,
      `Please explain this step by step for this question: ${original}`,
      second,
      { reexplainOf: `${first}-a` },
    );
    assert.equal(steps.status, 200, steps.text);
    const third = randomUUID();
    const brief = await ask(
      browser,
      chat.id,
      `Please keep the answer brief for this question: ${original}`,
      third,
      { reexplainOf: `${second}-a` },
    );
    assert.equal(brief.status, 200, brief.text);

    const preview = await browser.post('/api/me/support-requests/preview', {
      conversationId: chat.id,
      messageId: `${third}-a`,
    });
    assert.deepEqual(preview.body, {
      question: original,
      alyaAnswer: brief.body.answer,
      sources: [{ title: 'Synthetic handbook', heading: 'Dress' }],
    });
    const created = await browser.post('/api/me/support-requests', {
      conversationId: chat.id,
      messageId: `${third}-a`,
    });
    assert.equal(created.body.request.question, original);
    const stored = app.firestore.read(`supportRequests/${created.body.request.id}`);
    assert.equal(stored.question, original);
    assert.equal(stored.messageId, `${third}-a`);
    // A request for the original answer has the same question.
    const forOriginal = await browser.post('/api/me/support-requests', {
      conversationId: chat.id,
      messageId: `${first}-a`,
    });
    assert.equal(forOriginal.status, 201);
    assert.equal(forOriginal.body.request.question, original);
    // HR sees the original question on both.
    const listed = (await hr.get('/api/hr/support-requests')).body.requests;
    assert.deepEqual(
      listed.map((r) => r.question),
      [original, original],
    );
    assert.ok(!JSON.stringify(listed).includes('Please explain this step by step'));
  });
});
