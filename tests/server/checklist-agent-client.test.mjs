// The checklist agent client (#51): the ADK API server and Agent Engine
// request shapes, the confirmation parsing and session clean-up. A fake fetch
// only; no Python, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checklistAgentSettings,
  createAdkChecklistAgent,
  createAgentEngineChecklistAgent,
  outcomeOf,
  parseStreamedEvents,
} from '../../server/checklist-agent-client.mjs';

const ACCOUNT = '0d6f1c2e-1111-4222-8333-444455556666';
const ENGINE = 'projects/123456789/locations/asia-southeast1/reasoningEngines/987654321';

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = {
      url: String(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers,
    };
    calls.push(call);
    const { status = 200, body = '' } = (await respond(call)) || {};
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

// What the ADK API server's /run returns for a proposal (camelCase).
const proposalEvents = [
  {
    author: 'onboarding_checklist',
    content: {
      role: 'model',
      parts: [{ functionCall: { id: 'fc-1', name: 'get_onboarding_progress', args: {} } }],
    },
  },
  {
    author: 'onboarding_checklist',
    content: {
      role: 'model',
      parts: [
        { text: 'Shall I mark Meet your buddy as done?' },
        {
          functionCall: {
            id: 'fc-2',
            name: 'mark_step',
            args: { step_id: 'team-support.meet-buddy' },
          },
        },
      ],
    },
  },
  {
    author: 'onboarding_checklist',
    content: {
      role: 'user',
      parts: [
        {
          functionCall: {
            id: 'adk-confirm-1',
            name: 'adk_request_confirmation',
            args: {
              originalFunctionCall: {
                id: 'fc-2',
                name: 'mark_step',
                args: { step_id: 'team-support.meet-buddy' },
              },
              toolConfirmation: { hint: 'Please approve', confirmed: false },
            },
          },
        },
      ],
    },
  },
];

test('settings: the engine wins, a local URL otherwise, neither is off; bad values stop the server', () => {
  assert.equal(checklistAgentSettings({}), null);
  assert.deepEqual(checklistAgentSettings({ CHECKLIST_AGENT_URL: 'http://127.0.0.1:8093/' }), {
    url: 'http://127.0.0.1:8093',
  });
  assert.deepEqual(
    checklistAgentSettings({
      CHECKLIST_AGENT_URL: 'http://127.0.0.1:8093',
      CHECKLIST_AGENT_ENGINE: ENGINE,
    }),
    { engine: ENGINE },
  );
  assert.throws(
    () => checklistAgentSettings({ CHECKLIST_AGENT_ENGINE: 'reasoningEngines/1' }),
    /CHECKLIST_AGENT_ENGINE/,
  );
  assert.throws(
    () => checklistAgentSettings({ CHECKLIST_AGENT_URL: 'ftp://x' }),
    /CHECKLIST_AGENT_URL/,
  );
});

test('events: the confirmation request and the last model text, camelCase and snake_case', () => {
  assert.deepEqual(outcomeOf(proposalEvents), {
    text: 'Shall I mark Meet your buddy as done?',
    confirmation: { callId: 'adk-confirm-1', stepId: 'team-support.meet-buddy' },
  });
  const snake = [
    {
      author: 'onboarding_checklist',
      content: {
        role: 'user',
        parts: [
          {
            function_call: {
              id: 'adk-2',
              name: 'adk_request_confirmation',
              args: {
                originalFunctionCall: {
                  id: 'x',
                  name: 'mark_step',
                  args: { step_id: 'documentation.tax-id-documents' },
                },
              },
            },
          },
        ],
      },
    },
  ];
  assert.deepEqual(outcomeOf(snake).confirmation, {
    callId: 'adk-2',
    stepId: 'documentation.tax-id-documents',
  });
  // Another tool's confirmation, thoughts and partial chunks are ignored.
  const other = [
    {
      author: 'onboarding_checklist',
      partial: true,
      content: { role: 'model', parts: [{ text: 'Sha' }] },
    },
    {
      author: 'onboarding_checklist',
      content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'Done.' }] },
    },
    {
      author: 'onboarding_checklist',
      content: {
        parts: [
          {
            functionCall: {
              id: 'a',
              name: 'adk_request_confirmation',
              args: { originalFunctionCall: { name: 'other', args: {} } },
            },
          },
        ],
      },
    },
  ];
  assert.deepEqual(outcomeOf(other), { text: 'Done.', confirmation: null });
  assert.throws(() => outcomeOf([{ errorCode: 'MALFORMED_FUNCTION_CALL' }]), /AGENT_ERROR/);
  assert.deepEqual(parseStreamedEvents('data: {"a":1}\r\n\r\ndata:{"b":2}\n{"c":3}\nnot json\n'), [
    { a: 1 },
    { b: 2 },
    { c: 3 },
  ]);
});

test('ADK API server: session with the account in its state, /run, resume with the confirmation, delete', async () => {
  const { calls, fetchImpl } = recorder((call) =>
    call.url.endsWith('/run')
      ? {
          body: call.body.newMessage.parts[0].functionResponse
            ? [
                {
                  author: 'onboarding_checklist',
                  content: { role: 'model', parts: [{ text: 'Done! Next: your contract.' }] },
                },
              ]
            : proposalEvents,
        }
      : { body: {} },
  );
  const agent = createAdkChecklistAgent({ url: 'http://127.0.0.1:8093', fetchImpl, log: () => {} });
  const started = await agent.start({
    accountId: ACCOUNT,
    track: 'intern',
    text: 'I have met my buddy',
  });
  assert.match(started.sessionId, /^checklist-[0-9a-f-]{36}$/);
  assert.deepEqual(started.confirmation, {
    callId: 'adk-confirm-1',
    stepId: 'team-support.meet-buddy',
  });
  const user = `employee-${ACCOUNT}`;
  assert.deepEqual(calls[0], {
    url: `http://127.0.0.1:8093/apps/onboarding_checklist/users/${user}/sessions`,
    method: 'POST',
    body: {
      sessionId: started.sessionId,
      state: {
        onboardai_account_id: ACCOUNT,
        onboardai_track: 'intern',
        onboardai_template_id: 'intern',
      },
    },
    headers: { 'Content-Type': 'application/json' },
  });
  assert.deepEqual(calls[1].body, {
    appName: 'onboarding_checklist',
    userId: user,
    sessionId: started.sessionId,
    newMessage: { role: 'user', parts: [{ text: 'I have met my buddy' }] },
    streaming: false,
  });
  // The account id never travels in a message.
  assert.ok(!JSON.stringify(calls[1].body.newMessage).includes(ACCOUNT));
  const resumed = await agent.resume({
    accountId: ACCOUNT,
    sessionId: started.sessionId,
    callId: 'adk-confirm-1',
    confirmed: true,
  });
  assert.deepEqual(resumed, { text: 'Done! Next: your contract.', confirmation: null });
  assert.deepEqual(calls[2].body.newMessage, {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'adk-confirm-1',
          name: 'adk_request_confirmation',
          response: { confirmed: true },
        },
      },
    ],
  });
  await agent.remove({ accountId: ACCOUNT, sessionId: started.sessionId });
  assert.deepEqual(
    [calls[3].method, calls[3].url],
    [
      'DELETE',
      `http://127.0.0.1:8093/apps/onboarding_checklist/users/${user}/sessions/${started.sessionId}`,
    ],
  );
});

test('ADK API server: a failed run deletes its session; a failed delete is only logged', async () => {
  const logs = [];
  const { calls, fetchImpl } = recorder((call) =>
    call.url.endsWith('/run')
      ? { status: 500 }
      : call.method === 'DELETE'
        ? { status: 503 }
        : { body: {} },
  );
  const agent = createAdkChecklistAgent({
    url: 'http://127.0.0.1:8093',
    fetchImpl,
    log: (l) => logs.push(l),
  });
  await assert.rejects(
    agent.start({ accountId: ACCOUNT, track: 'employee', text: 'x' }),
    (e) => e.code === 'RUN_HTTP_500',
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ['POST', 'POST', 'DELETE'],
  );
  assert.deepEqual(logs, [
    'Checklist agent: {"operation":"delete agent session","outcome":"SESSION_DELETE_HTTP_503"}',
  ]);
  const down = createAdkChecklistAgent({
    url: 'http://127.0.0.1:8093',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    log: () => {},
  });
  await assert.rejects(
    down.start({ accountId: ACCOUNT, track: 'employee', text: 'x' }),
    (e) => e.code === 'SESSION_UNREACHABLE',
  );
});

test('Agent Engine: create_session with state and TTL, streamQuery with snake_case confirmation, delete', async () => {
  const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const { calls, fetchImpl } = recorder((call) =>
    call.url.endsWith(':streamQuery?alt=sse')
      ? {
          body: call.body.input.message.parts[0].function_response
            ? sse([
                {
                  author: 'onboarding_checklist',
                  content: { role: 'model', parts: [{ text: 'Sent to HR.' }] },
                },
              ])
            : sse(proposalEvents),
        }
      : { body: { output: {} } },
  );
  const agent = createAgentEngineChecklistAgent({
    engine: ENGINE,
    getAccessToken: async () => 'synthetic-token',
    fetchImpl,
    log: () => {},
  });
  const started = await agent.start({
    accountId: ACCOUNT,
    track: 'employee',
    text: 'I signed my contract',
  });
  const endpoint = `https://asia-southeast1-aiplatform.googleapis.com/v1/${ENGINE}`;
  assert.equal(calls[0].url, `${endpoint}:query`);
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-token');
  assert.deepEqual(calls[0].body, {
    class_method: 'async_create_session',
    input: {
      session_id: started.sessionId,
      state: {
        onboardai_account_id: ACCOUNT,
        onboardai_track: 'employee',
        onboardai_template_id: 'employee',
      },
      ttl: '86400s',
      user_id: `employee-${ACCOUNT}`,
    },
  });
  assert.equal(calls[1].url, `${endpoint}:streamQuery?alt=sse`);
  assert.deepEqual(calls[1].body.input.message, {
    role: 'user',
    parts: [{ text: 'I signed my contract' }],
  });
  assert.deepEqual(calls[1].body.input.run_config, { max_llm_calls: 8 });
  assert.equal(started.confirmation.callId, 'adk-confirm-1');
  const resumed = await agent.resume({
    accountId: ACCOUNT,
    sessionId: started.sessionId,
    callId: 'adk-confirm-1',
    confirmed: false,
  });
  assert.equal(resumed.text, 'Sent to HR.');
  assert.deepEqual(calls[2].body.input.message, {
    role: 'user',
    parts: [
      {
        function_response: {
          id: 'adk-confirm-1',
          name: 'adk_request_confirmation',
          response: { confirmed: false },
        },
      },
    ],
  });
  await agent.remove({ accountId: ACCOUNT, sessionId: started.sessionId });
  assert.deepEqual(calls[3].body, {
    class_method: 'async_delete_session',
    input: { user_id: `employee-${ACCOUNT}`, session_id: started.sessionId },
  });
  // Without credentials nothing is sent.
  const anonymous = createAgentEngineChecklistAgent({
    engine: ENGINE,
    getAccessToken: async () => {
      throw new Error('no ADC');
    },
    fetchImpl: async () => assert.fail('no request without a token'),
    log: () => {},
  });
  await assert.rejects(
    anonymous.start({ accountId: ACCOUNT, track: 'employee', text: 'x' }),
    (e) => e.code === 'CREDENTIALS_UNAVAILABLE',
  );
});

test('removeUser lists the account’s sessions and deletes each, on both runners', async () => {
  // ADK API server: GET the user's sessions, then DELETE each.
  const adk = recorder((call) =>
    call.method === 'GET' ? { body: [{ id: 'checklist-a' }, { id: 'checklist-b' }] } : { body: '' },
  );
  const local = createAdkChecklistAgent({
    url: 'http://127.0.0.1:8093',
    fetchImpl: adk.fetchImpl,
    log: () => {},
  });
  assert.equal(await local.removeUser({ accountId: ACCOUNT }), 2);
  const base = `http://127.0.0.1:8093/apps/onboarding_checklist/users/employee-${ACCOUNT}/sessions`;
  assert.deepEqual(
    adk.calls.map((c) => [c.method, c.url]),
    [
      ['GET', base],
      ['DELETE', `${base}/checklist-a`],
      ['DELETE', `${base}/checklist-b`],
    ],
  );
  // Agent Engine: async_list_sessions, then async_delete_session for each.
  const engine = recorder((call) =>
    call.body.class_method === 'async_list_sessions'
      ? { body: { output: { sessions: [{ id: 'checklist-c', userId: `employee-${ACCOUNT}` }] } } }
      : { body: { output: null } },
  );
  const cloud = createAgentEngineChecklistAgent({
    engine: ENGINE,
    getAccessToken: async () => 'synthetic-token',
    fetchImpl: engine.fetchImpl,
    log: () => {},
  });
  assert.equal(await cloud.removeUser({ accountId: ACCOUNT }), 1);
  assert.deepEqual(
    engine.calls.map((c) => c.body),
    [
      { class_method: 'async_list_sessions', input: { user_id: `employee-${ACCOUNT}` } },
      {
        class_method: 'async_delete_session',
        input: { user_id: `employee-${ACCOUNT}`, session_id: 'checklist-c' },
      },
    ],
  );
  // An unreachable agent: the list fails with a code (the caller logs it).
  const down = createAdkChecklistAgent({
    url: 'http://127.0.0.1:8093',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    log: () => {},
  });
  await assert.rejects(
    down.removeUser({ accountId: ACCOUNT }),
    (e) => e.code === 'SESSION_LIST_UNREACHABLE',
  );
});
