import { randomUUID } from 'node:crypto';
import { DEFAULT_COMPANY_ID, templateDocId } from './companies.mjs';

// The one place that calls the onboarding checklist agent (#51; Python, Google
// ADK, agent-platform/onboarding-checklist). The api only knows
//   start({ accountId, track, text, signal })  -> { sessionId, text, confirmation }
//   resume({ accountId, sessionId, callId, confirmed, signal }) -> { text, confirmation }
//   remove({ accountId, sessionId })           -> never throws
//   removeUser({ accountId })                  -> deletes every session of the
//        account (employee deletion); throws ChecklistAgentError when the
//        sessions cannot be listed
// where confirmation is { callId, stepId } when the agent asks the employee to
// approve mark_step (ADK tool confirmation, adk_request_confirmation), else null.
// The employee's account id and track go ONLY into the session state
// (onboardai_account_id, onboardai_track); the agent's tools read them from
// there, never from the model.
//
// Two runners share that interface; createChecklistAgent picks one:
//
// 1. Local: the ADK API server (npm run checklist-agent; CHECKLIST_AGENT_URL):
//      POST   {url}/apps/{app}/users/{user}/sessions        { sessionId, state }
//      POST   {url}/run   { appName, userId, sessionId, newMessage, streaming: false }
//      DELETE {url}/apps/{app}/users/{user}/sessions/{sessionId}
//      GET    {url}/apps/{app}/users/{user}/sessions        (employee deletion)
//
// 2. Cloud: the agent on Vertex AI Agent Engine (CHECKLIST_AGENT_ENGINE),
//    through the REST API of a deployed ADK app with an Application Default
//    Credentials access token:
//      POST .../v1/{engine}:query  { class_method: "async_create_session",
//                                    input: { user_id, session_id, state, ttl } }
//      POST .../v1/{engine}:streamQuery?alt=sse
//                                  { class_method: "async_stream_query",
//                                    input: { user_id, session_id, message, run_config } }
//      POST .../v1/{engine}:query  { class_method: "async_delete_session", input: {...} }
//      POST .../v1/{engine}:query  { class_method: "async_list_sessions",
//                                    input: { user_id } }    (employee deletion)
//
// A resume sends the confirmation as a FunctionResponse named
// adk_request_confirmation with the call's id and { confirmed }. Response
// bodies are parsed for the reply and the confirmation request only; they are
// never logged.
export const CHECKLIST_AGENT_APP = 'onboarding_checklist';
export const CONFIRMATION_CALL = 'adk_request_confirmation';
export const MARK_STEP = 'mark_step';
export const MAX_LLM_CALLS = 8;
// The shortest TTL the Agent Engine Sessions API allows, in case a delete fails.
export const AGENT_ENGINE_SESSION_TTL = '86400s';
const RUN_TIMEOUT_MS = 45000;
const CLEANUP_TIMEOUT_MS = 5000;
const ENGINE_CLEANUP_TIMEOUT_MS = 10000;

const enginePattern =
  /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})\/locations\/([a-z]+(?:-[a-z]+[0-9]+)?)\/reasoningEngines\/([0-9]{1,30})$/;
export function parseAgentEngine(value) {
  const name = String(value ?? '').trim();
  const match = enginePattern.exec(name);
  return match ? { name, location: match[2] } : null;
}
export const agentEngineEndpoint = ({ name, location }) =>
  `https://${location === 'global' ? '' : `${location}-`}aiplatform.googleapis.com/v1/${name}`;

// { engine } or { url } from the environment, or null when the feature is off.
// The engine wins when both are set (Cloud Run sets only the engine).
export function checklistAgentSettings(env = process.env) {
  const engine = (env.CHECKLIST_AGENT_ENGINE || '').trim();
  if (engine) {
    if (!parseAgentEngine(engine))
      throw new Error('CHECKLIST_AGENT_ENGINE is not a reasoning engine resource name.');
    return { engine };
  }
  const url = (env.CHECKLIST_AGENT_URL || '').trim();
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'CHECKLIST_AGENT_URL must be an http(s) URL, for example http://127.0.0.1:8093.',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('CHECKLIST_AGENT_URL must be an http(s) URL.');
  return { url: parsed.origin + parsed.pathname.replace(/\/+$/, '') };
}

export class ChecklistAgentError extends Error {
  constructor(code) {
    super(`The checklist agent request failed (${code}).`);
    this.name = 'ChecklistAgentError';
    this.code = code;
  }
}

export const agentUserId = (accountId) => `employee-${accountId}`;
const newSessionId = () => `checklist-${randomUUID()}`;
export const sessionState = (accountId, track, companyId = DEFAULT_COMPANY_ID) => ({
  onboardai_account_id: accountId,
  onboardai_track: track,
  onboardai_template_id: templateDocId(companyId, track),
});

// Agent events arrive camelCase from the ADK API server and snake_case from
// Agent Engine; both are read here.
const pick = (object, camel, snake) => object?.[camel] ?? object?.[snake];
export function outcomeOf(events, appName = CHECKLIST_AGENT_APP) {
  let text = '';
  let confirmation = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || event.partial) continue;
    if (pick(event, 'errorCode', 'error_code')) throw new ChecklistAgentError('AGENT_ERROR');
    const content = event.content;
    if (!content || !Array.isArray(content.parts)) continue;
    let eventText = '';
    for (const part of content.parts) {
      const call = pick(part, 'functionCall', 'function_call');
      if (call?.name === CONFIRMATION_CALL) {
        const original = pick(call.args, 'originalFunctionCall', 'original_function_call');
        const stepId = original?.args?.step_id;
        if (
          original?.name === MARK_STEP &&
          typeof stepId === 'string' &&
          typeof call.id === 'string'
        )
          confirmation = { callId: call.id, stepId };
      }
      if (typeof part.text === 'string' && !part.thought) eventText += part.text;
    }
    if (eventText.trim() && event.author === appName && content.role !== 'user')
      text = eventText.trim();
  }
  return { text, confirmation };
}

// Newline-delimited JSON, optionally framed as Server-Sent Events.
export function parseStreamedEvents(body) {
  const events = [];
  for (const raw of String(body || '').split('\n')) {
    let line = raw.replace(/\r$/, '');
    if (line.startsWith('data:')) line = line.slice(5).replace(/^ /, '');
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Not an event.
    }
  }
  return events;
}

async function send(fetchImpl, url, init, step) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted && error?.name !== 'TimeoutError') throw error;
    throw new ChecklistAgentError(`${step}_UNREACHABLE`);
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new ChecklistAgentError(`${step}_HTTP_${response.status}`);
  return body;
}
const withDeadline = (signal, ms = RUN_TIMEOUT_MS) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
const cleanupFailure = (log) => (error) =>
  log(
    'Checklist agent: ' +
      JSON.stringify({
        operation: 'delete agent session',
        outcome: error?.code || error?.name || 'UNKNOWN',
      }),
  );
const userText = (text) => ({ role: 'user', parts: [{ text }] });
const confirmationMessage = (callId, confirmed, snake) => ({
  role: 'user',
  parts: [
    snake
      ? { function_response: { id: callId, name: CONFIRMATION_CALL, response: { confirmed } } }
      : { functionResponse: { id: callId, name: CONFIRMATION_CALL, response: { confirmed } } },
  ],
});

export function createAdkChecklistAgent({
  url,
  appName = CHECKLIST_AGENT_APP,
  fetchImpl = fetch,
  log = (line) => console.warn(line),
}) {
  const base = String(url).replace(/\/+$/, '');
  const json = { 'Content-Type': 'application/json' };
  const sessions = (userId) =>
    `${base}/apps/${encodeURIComponent(appName)}/users/${encodeURIComponent(userId)}/sessions`;
  const run = async (userId, sessionId, newMessage, signal) =>
    outcomeOf(
      JSON.parse(
        (await send(
          fetchImpl,
          `${base}/run`,
          {
            method: 'POST',
            headers: json,
            signal: withDeadline(signal),
            body: JSON.stringify({ appName, userId, sessionId, newMessage, streaming: false }),
          },
          'RUN',
        )) || '[]',
      ),
      appName,
    );
  async function remove({ accountId, sessionId }) {
    await send(
      fetchImpl,
      `${sessions(agentUserId(accountId))}/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
      'SESSION_DELETE',
    ).catch(cleanupFailure(log));
  }
  // Every session of the account (the employee is being deleted).
  async function removeUser({ accountId }) {
    const listed = JSON.parse(
      (await send(
        fetchImpl,
        sessions(agentUserId(accountId)),
        { method: 'GET', signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        'SESSION_LIST',
      )) || '[]',
    );
    const ids = (Array.isArray(listed) ? listed : listed?.sessions || [])
      .map((session) => session?.id)
      .filter((id) => typeof id === 'string');
    for (const sessionId of ids) await remove({ accountId, sessionId });
    return ids.length;
  }
  return {
    kind: 'adk',
    async start({ accountId, track, text, signal, companyId = DEFAULT_COMPANY_ID }) {
      const userId = agentUserId(accountId),
        sessionId = newSessionId();
      await send(
        fetchImpl,
        sessions(userId),
        {
          method: 'POST',
          headers: json,
          signal: withDeadline(signal),
          body: JSON.stringify({ sessionId, state: sessionState(accountId, track, companyId) }),
        },
        'SESSION',
      );
      try {
        return { sessionId, ...(await run(userId, sessionId, userText(text), signal)) };
      } catch (error) {
        await remove({ accountId, sessionId });
        throw error;
      }
    },
    async resume({ accountId, sessionId, callId, confirmed, signal }) {
      return run(
        agentUserId(accountId),
        sessionId,
        confirmationMessage(callId, confirmed, false),
        signal,
      );
    },
    remove,
    removeUser,
  };
}

export function createAgentEngineChecklistAgent({
  engine,
  getAccessToken,
  fetchImpl = fetch,
  log = (line) => console.warn(line),
}) {
  const parsed = parseAgentEngine(engine);
  if (!parsed) throw new Error('CHECKLIST_AGENT_ENGINE is not a reasoning engine resource name.');
  const endpoint = agentEngineEndpoint(parsed);
  const headers = async () => {
    let token;
    try {
      token = await getAccessToken();
    } catch {
      token = null;
    }
    if (!token) throw new ChecklistAgentError('CREDENTIALS_UNAVAILABLE');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  const call = async (path, classMethod, input, step, signal) =>
    send(
      fetchImpl,
      endpoint + path,
      {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ class_method: classMethod, input }),
        signal,
      },
      step,
    );
  const stream = async (userId, sessionId, message, signal) =>
    outcomeOf(
      parseStreamedEvents(
        await call(
          ':streamQuery?alt=sse',
          'async_stream_query',
          {
            user_id: userId,
            session_id: sessionId,
            message,
            run_config: { max_llm_calls: MAX_LLM_CALLS },
          },
          'RUN',
          withDeadline(signal),
        ),
      ),
    );
  async function remove({ accountId, sessionId }) {
    await call(
      ':query',
      'async_delete_session',
      { user_id: agentUserId(accountId), session_id: sessionId },
      'SESSION_DELETE',
      AbortSignal.timeout(ENGINE_CLEANUP_TIMEOUT_MS),
    ).catch(cleanupFailure(log));
  }
  async function removeUser({ accountId }) {
    const body = await call(
      ':query',
      'async_list_sessions',
      { user_id: agentUserId(accountId) },
      'SESSION_LIST',
      AbortSignal.timeout(ENGINE_CLEANUP_TIMEOUT_MS),
    );
    let ids = [];
    try {
      const output = JSON.parse(body)?.output;
      ids = (Array.isArray(output) ? output : output?.sessions || [])
        .map((session) => session?.id)
        .filter((id) => typeof id === 'string');
    } catch {
      throw new ChecklistAgentError('SESSION_LIST_UNREADABLE');
    }
    for (const sessionId of ids) await remove({ accountId, sessionId });
    return ids.length;
  }
  return {
    kind: 'agent-engine',
    async start({ accountId, track, text, signal, companyId = DEFAULT_COMPANY_ID }) {
      const userId = agentUserId(accountId);
      let sessionId = newSessionId();
      try {
        const created = await call(
          ':query',
          'async_create_session',
          {
            user_id: userId,
            session_id: sessionId,
            state: sessionState(accountId, track, companyId),
            ttl: AGENT_ENGINE_SESSION_TTL,
          },
          'SESSION',
          withDeadline(signal),
        );
        // Should the service ever name the session itself, use that one.
        try {
          const id = JSON.parse(created)?.output?.id;
          if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) sessionId = id;
        } catch {
          // Not JSON: keep the ID sent.
        }
        return {
          sessionId,
          ...(await stream(userId, sessionId, userText(text), signal)),
        };
      } catch (error) {
        await remove({ accountId, sessionId });
        throw error;
      }
    },
    async resume({ accountId, sessionId, callId, confirmed, signal }) {
      return stream(
        agentUserId(accountId),
        sessionId,
        confirmationMessage(callId, confirmed, true),
        signal,
      );
    },
    remove,
    removeUser,
  };
}

// The agent for checklistAgentSettings(env), or null when it is off.
export function createChecklistAgent(settings, { fetchImpl = fetch, getAccessToken, log } = {}) {
  if (!settings) return null;
  return settings.engine
    ? createAgentEngineChecklistAgent({
        engine: settings.engine,
        getAccessToken,
        fetchImpl,
        ...(log ? { log } : {}),
      })
    : createAdkChecklistAgent({ url: settings.url, fetchImpl, ...(log ? { log } : {}) });
}
