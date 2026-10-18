import test from 'node:test';
import assert from 'node:assert/strict';
import { journeyApi } from '../../src/access/journey-api.mjs';

// Records the call and answers 200 {} .
function recorder(status = 200, body = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, options: { fetchImpl } };
}

test('employee routes match the contract', async () => {
  const { calls, options } = recorder();
  await journeyApi.onboarding(options);
  await journeyApi.completeStep('documentation.id', options);
  await journeyApi.reopenStep('documentation.id', options);
  await journeyApi.check('policies.x', options);
  await journeyApi.answerCheck('policies.x', 'b', options);
  await journeyApi.quickQuestions(options);
  await journeyApi.firstDay(options);
  await journeyApi.previewSupportRequest({ conversationId: 'c', messageId: 'm' }, options);
  await journeyApi.createSupportRequest(
    { conversationId: 'c', messageId: 'm', note: 'hi' },
    options,
  );
  await journeyApi.mySupportRequests(options);
  await journeyApi.decideAction('act1', 'approve', options);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ['GET', '/api/me/onboarding', undefined],
      ['POST', '/api/me/onboarding/steps/documentation.id/complete', undefined],
      ['POST', '/api/me/onboarding/steps/documentation.id/reopen', undefined],
      ['GET', '/api/me/onboarding/steps/policies.x/check', undefined],
      ['POST', '/api/me/onboarding/steps/policies.x/check', { optionId: 'b' }],
      ['GET', '/api/me/quick-questions', undefined],
      ['GET', '/api/me/first-day', undefined],
      ['POST', '/api/me/support-requests/preview', { conversationId: 'c', messageId: 'm' }],
      ['POST', '/api/me/support-requests', { conversationId: 'c', messageId: 'm', note: 'hi' }],
      ['GET', '/api/me/support-requests', undefined],
      ['POST', '/api/me/agent-actions/act1', { decision: 'approve' }],
    ],
  );
});
test('HR routes match the contract', async () => {
  const { calls, options } = recorder();
  await journeyApi.hrSupportRequests(options);
  await journeyApi.updateSupportRequest('r1', { status: 'resolved' }, options);
  await journeyApi.hrKnowledgeGaps(options);
  await journeyApi.hrTeamInsights(options);
  await journeyApi.employeeOnboarding('e1', options);
  await journeyApi.setEmployeeStep('e1', 'policies.sign', 'done', options);
  await journeyApi.employeeFirstDay('e1', options);
  await journeyApi.saveFirstDay('e1', { location: 'L' }, options);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ['GET', '/api/hr/support-requests', undefined],
      ['PATCH', '/api/hr/support-requests/r1', { status: 'resolved' }],
      ['GET', '/api/hr/knowledge-gaps', undefined],
      ['GET', '/api/hr/team-insights', undefined],
      ['GET', '/api/hr/employees/e1/onboarding', undefined],
      ['PATCH', '/api/hr/employees/e1/onboarding/steps/policies.sign', { status: 'done' }],
      ['GET', '/api/hr/employees/e1/first-day', undefined],
      ['PUT', '/api/hr/employees/e1/first-day', { location: 'L' }],
    ],
  );
});
test('the removed support-summaries route is never called', async () => {
  const { calls, options } = recorder();
  for (const fn of Object.values(journeyApi)) {
    try {
      await fn('a', 'b', options);
    } catch {}
  }
  assert.ok(calls.every((c) => !c.url.includes('support-summaries')));
});
test('409 errors keep their code for inline messages', async () => {
  const { options } = recorder(409, { code: 'CHECK_REQUIRED', error: 'Take the check first.' });
  await assert.rejects(journeyApi.completeStep('policies.x', { ...options, report: false }), {
    status: 409,
    code: 'CHECK_REQUIRED',
  });
});

test('v1.4 written checks and v1.5 briefings use the contract routes and bodies', async () => {
  const { calls, options } = recorder();
  await journeyApi.answerCheck('policies.handbook', 'q7x', options);
  await journeyApi.answerWrittenCheck('policies.pdpa', 'I would not share it.', options);
  await journeyApi.recordBriefing('documentation.tax-id-documents', 'listened', options);
  await journeyApi.recordBriefing('documentation.tax-id-documents', 'read', options);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ['POST', '/api/me/onboarding/steps/policies.handbook/check', { optionId: 'q7x' }],
      ['POST', '/api/me/onboarding/steps/policies.pdpa/check', { answer: 'I would not share it.' }],
      [
        'POST',
        '/api/me/onboarding/steps/documentation.tax-id-documents/briefing',
        { completion: 'listened' },
      ],
      [
        'POST',
        '/api/me/onboarding/steps/documentation.tax-id-documents/briefing',
        { completion: 'read' },
      ],
    ],
  );
});
