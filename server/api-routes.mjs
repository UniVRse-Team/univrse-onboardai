import express from 'express';
import { createDocumentSubmissions } from './document-submissions.mjs';
import { createSubmissionFiles } from './submission-files.mjs';
import { GoogleAuth } from 'google-auth-library';

import { tasks, demoAnswer, systemPrompt } from './sample-onboarding-content.mjs';

import { createCompanyRetriever, knowledgeMode } from './company-document-retriever.mjs';
import { searchFailure } from './vertex-ai-search.mjs';
import { quoteSearchResults } from './document-search.mjs';
import { createSharedVoice, sharedVoiceName } from './kokoro-voice.mjs';
import { createRemoteVoice } from './remote-voice.mjs';
import {
  logIdTokenFailure,
  serverlessAuthorization,
  serverlessAuthorizationHeader,
  serviceIdTokenProvider,
} from './service-auth.mjs';
import { parseVoiceRequest, voiceRequestError, voiceFailure } from './voice-request.mjs';
import {
  createConversationService,
  conversationFailure,
  journeyFieldsOf,
  journeyMessageFields,
} from './gemini-chat-workflow.mjs';
import { vertexConfig, vertexGenerateContentUrl, createAccessTokenProvider } from './vertex-ai.mjs';
import { createProfileAutofill } from './profile-autofill.mjs';
import { ChatError, answerNotFound } from './chat-errors.mjs';
import { progressNote } from './alya-progress-note.mjs';
import { createOnboardingJourney, personalSource } from './onboarding-journey.mjs';
import { alyaAssessmentReply, parseChatAiAssessment } from './ai-proficiency.mjs';
import { createSupportRequests } from './support-requests.mjs';
import { createKnowledgeGaps } from './knowledge-gaps.mjs';
import { checklistAgentSettings, createChecklistAgent } from './checklist-agent-client.mjs';
import { checklistSource, createAgentActions, reportsCompletion } from './agent-actions.mjs';
import {
  createGeminiVoice,
  createVoiceService,
  geminiVoiceSettings,
  kokoroVoiceHeader,
} from './gemini-voice.mjs';
import { createCheckGrader } from './check-grader.mjs';
import { accountErrors } from './account-errors.mjs';
import { accountSettings } from './account-settings.mjs';
import { createAccountBackends, createAccountService } from './account-service.mjs';
import { createCompanyDocumentStore, deploymentEnvironment } from './company-documents.mjs';
import { createCompanyKnowledge, isAccountOwner } from './company-knowledge.mjs';
import { createActiveDocuments } from './active-company-documents.mjs';
import { guardrailFieldOf } from './answer-freshness.mjs';
import { createFirestoreClient } from './firestore-client.mjs';
import {
  accountCookie,
  accountCookieOptions,
  mountAccountRoutes,
  readCookie,
  sameOrigin,
  sendAccountError,
} from './account-routes.mjs';

// A stateless answer that could not be prepared: the status and JSON body the
// browser receives (unchanged from before accounts existed).
class AnswerFailure extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

export function createApp({
  env = process.env,
  fetchImpl = fetch,
  localVoice = null,
  // Signs the calls to the TTS service (service-auth.mjs). By default it follows
  // SERVICE_AUTH and Cloud Run; pass a provider to force ID tokens on, null for off.
  idTokenProvider = undefined,
  // The provider for api -> tts, shared by the voice client and GET /api/health/tts.
  ttsIdTokenProvider = env.TTS_SERVICE_URL
    ? idTokenProvider !== undefined
      ? idTokenProvider
      : serviceIdTokenProvider({ env, url: env.TTS_SERVICE_URL })
    : null,
  sharedVoice = env.TTS_SERVICE_URL
    ? createRemoteVoice({
        url: env.TTS_SERVICE_URL,
        idTokenProvider: ttsIdTokenProvider,
      })
    : createSharedVoice(),
  trustProxy = false,
  // The saved-chat service (gemini-chat-workflow.mjs), or a function
  // ({ retrieve }) => service that is given the app's company retriever.
  conversationService = null,
  getAccessToken = null,
  // Accounts service (account-service.mjs). By default it is built when
  // DATABASE_URL is set; pass null to turn accounts off.
  accountService = undefined,
  // Profile autofill service (profile-autofill.mjs). By default it uses Vertex
  // AI through fetchImpl and getAccessToken; pass null to turn it off.
  profileAutofill = undefined,
  // The HR company knowledge library metadata store (company-documents.mjs). By
  // default it is stored in Firestore whenever accounts are on, and syncs
  // uploads and deletes to GCS + Vertex AI Search when DOCS_BUCKET and
  // VERTEX_SEARCH_DATA_STORE_ID are set.
  companyDocuments = undefined,
  submissionFiles = undefined,
  // The company search (Vertex AI Search, or the sample guide); tests replace it.
  companyRetrieve = undefined,
  // The onboarding journey's Firestore (issues #47-#50): { firestore, now?,
  // cacheMs?, log? }. By default the accounts' Firestore whenever accounts are
  // on; null turns the journey routes off.
  journeyStorage = undefined,
  // The onboarding checklist agent (#51, checklist-agent-client.mjs). By
  // default from CHECKLIST_AGENT_ENGINE or CHECKLIST_AGENT_URL; null is off.
  checklistAgent = undefined,
  // Gemini text to speech (#52, gemini-voice.mjs). By default with
  // VOICE_PROVIDER=gemini; null keeps Kokoro only.
  geminiVoice = undefined,
  // The written-check grader (contract v1.4, check-grader.mjs). By default
  // Gemini whenever Vertex AI is configured (not with document-search); null
  // is off, and written checks then answer 503 CHECK_GRADER_UNAVAILABLE.
  checkGrader = undefined,
} = {}) {
  const app = express();
  const documentSearch = env.AI_MODE === 'document-search';
  const memoryChat = env.AI_MODE === 'gemini-chat';
  // Throws AccountsConfigError when DATABASE_URL is set without the Firestore
  // settings accounts need (see account-settings.mjs).
  const settings = accountSettings(env);
  const accounts =
    accountService !== undefined
      ? accountService
      : settings
        ? createAccountService(createAccountBackends(settings))
        : null;
  const vertexToken = getAccessToken || createAccessTokenProvider();
  const autofill =
    profileAutofill !== undefined
      ? profileAutofill
      : createProfileAutofill({
          env,
          fetchImpl,
          getAccessToken: vertexToken,
          // The active departments, read per request.
          departmentNames: accounts ? () => accounts.activeDepartmentNames() : undefined,
        });
  // Company passages for gemini-chat and document-search: Vertex AI Search, or
  // the sample guide when VERTEX_SEARCH_ENGINE_ID is unset.
  const retrieve =
    companyRetrieve || createCompanyRetriever({ env, fetchImpl, getAccessToken: vertexToken });
  // With accounts on, Firestore companyDocuments is kept strictly for HR UI
  // management (`list`, `add`, `move`, `remove`, `describe`), while runtime
  // retrieval (`retrieve`, `quote`) exclusively queries Vertex AI Search.
  const library = !accounts
    ? null
    : companyDocuments !== undefined
      ? companyDocuments
      : settings
        ? createCompanyDocumentStore({
            firestore: createFirestoreClient(settings.firestore),
            env,
            fetchImpl,
            getAccessToken: vertexToken,
          })
        : null;
  // With Vertex AI Search, chat and document search use only passages of
  // active companyDocuments entries (the retrieval allowlist, issue #79). A
  // change on this instance drops the allowlist's cache at once (onChange);
  // other instances refresh it within 30 seconds.
  const vertexSearch = knowledgeMode(env) === 'vertex-ai-search';
  const active =
    vertexSearch && library
      ? createActiveDocuments({
          documents: library,
          bucket: env.DOCS_BUCKET,
          environment: deploymentEnvironment(env),
        })
      : null;
  // checkKnowledgeConfig stops the api and the local server before this; an
  // app built without the bucket withholds every company passage.
  if ((memoryChat || documentSearch) && vertexSearch && !String(env.DOCS_BUCKET || '').trim())
    console.error(
      'Company knowledge: VERTEX_SEARCH_ENGINE_ID is set without DOCS_BUCKET, so no passage can be matched to an active company document and chat withholds them all.',
    );
  const knowledge = library
    ? createCompanyKnowledge({
        documents: library,
        companyRetrieve: retrieve,
        active,
        onChange: active ? () => active.invalidate() : null,
      })
    : null;
  // retrieve(query, options, owner): runtime retrieval for gemini-chat and
  // document-search always and only queries Vertex AI Search (`retrieve`) or
  // the sample guide. Vertex AI Search passages go through the allowlist;
  // without one (no company library) none is used.
  const withheld = async () => [];
  const chatRetrieve = (query, options, owner) =>
    knowledge && isAccountOwner(owner)
      ? knowledge.retrieve(query, { signal: options?.signal })
      : vertexSearch
        ? withheld()
        : retrieve(query, options);
  const quoteRetrieve = (query, options, owner) =>
    knowledge && isAccountOwner(owner)
      ? knowledge.quote(query, { signal: options?.signal })
      : vertexSearch
        ? withheld()
        : retrieve(query, options);
  let conversations = typeof conversationService === 'function' ? null : conversationService;
  const chatService = () =>
    (conversations ||=
      typeof conversationService === 'function'
        ? conversationService({ retrieve: chatRetrieve })
        : createConversationService({ env, retrieve: chatRetrieve }));

  // The onboarding journey: footprint, chips, first-day details, support
  // requests and knowledge gaps, for signed-in accounts only.
  let journeyClosed = async () => {};
  let journeyStore = null;
  if (accounts && journeyStorage !== undefined) journeyStore = journeyStorage;
  else if (accounts && settings) {
    const client = createFirestoreClient(settings.firestore);
    let opened = false;
    journeyStore = {
      firestore: () => {
        opened = true;
        return client();
      },
    };
    journeyClosed = async () => {
      if (opened) await (await client())?.terminate?.();
    };
  }
  const journey = journeyStore
    ? {
        onboarding: createOnboardingJourney({
          ...journeyStore,
          accounts,
          grader:
            checkGrader !== undefined
              ? checkGrader
              : createCheckGrader({ env, fetchImpl, getAccessToken: vertexToken }),
        }),
        support: createSupportRequests({
          firestore: journeyStore.firestore,
          now: journeyStore.now,
          log: journeyStore.log,
          accounts,
          chatMemory: () => chatService().memory,
        }),
        gaps: createKnowledgeGaps({
          firestore: journeyStore.firestore,
          now: journeyStore.now,
          log: journeyStore.log,
        }),
      }
    : null;
  // The journey's clock (tests move it).
  const journeyNow = journeyStore?.now || (() => new Date());
  // Proposed checklist changes need the journey (accounts) and the agent.
  const agent =
    checklistAgent !== undefined
      ? checklistAgent
      : createChecklistAgent(checklistAgentSettings(env), {
          fetchImpl,
          getAccessToken: vertexToken,
        });
  if (journey && agent)
    journey.actions = createAgentActions({
      firestore: journeyStore.firestore,
      now: journeyStore.now,
      log: journeyStore.log,
      agent,
      journey: journey.onboarding,
      chatMemory: () => chatService().memory,
    });
  // Alya's voice: Gemini text to speech when VOICE_PROVIDER=gemini, with the
  // Kokoro voice (in process or the tts service) as the fallback.
  const geminiTts =
    geminiVoice !== undefined
      ? geminiVoice
      : geminiVoiceSettings(env)
        ? createGeminiVoice({ ...geminiVoiceSettings(env), fetchImpl, getAccessToken: vertexToken })
        : null;
  const voice = createVoiceService({ gemini: geminiTts, kokoro: sharedVoice });
  // The configured shared voice for /api/config (QA F-3): `id` is exactly the
  // X-Alya-Voice value of a clip in that voice, so the browser can tell when
  // the Kokoro fallback spoke instead.
  const configuredVoice = geminiTts
    ? { id: geminiTts.header, label: geminiTts.name || 'Alya (Gemini)', provider: 'gemini' }
    : { id: kokoroVoiceHeader, label: 'Alya · Heart', provider: 'kokoro' };

  app.disable('x-powered-by');
  // With a trusted proxy in front, req.ip and req.host are the browser's IP and host.
  app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '24kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Legacy billed Cloud Text-to-Speech is opt-in; GOOGLE_CLOUD_PROJECT alone only means Vertex AI.
  const cloudTts = env.GOOGLE_CLOUD_TTS === 'enabled' && Boolean(env.GOOGLE_CLOUD_PROJECT);

  const googleVoiceAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  // Small local-prototype request limit.
  const requests = new Map();

  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'PATCH') return next();

    const now = Date.now();

    for (const [key, value] of requests) {
      if (now - value.start > 60000) {
        requests.delete(key);
      }
    }

    const entry = requests.get(req.ip) || {
      start: now,
      count: 0,
    };

    entry.count++;
    requests.set(req.ip, entry);

    if (entry.count > 60) {
      return res.status(429).json({
        error: 'Please wait a moment before asking again.',
      });
    }

    next();
  });

  const documentSubmissions = journeyStore
    ? createDocumentSubmissions({
        firestore: journeyStore.firestore,
        accounts,
        onboarding: journey.onboarding,
        files:
          submissionFiles === undefined
            ? createSubmissionFiles({ env, fetchImpl, getAccessToken: vertexToken })
            : submissionFiles,
      })
    : null;
  // Documentation steps follow the review of their submissions (never a click).
  if (documentSubmissions && journey)
    journey.onboarding.bindDocumentStatuses((accountId) =>
      documentSubmissions.statusesFor(accountId),
    );
  // Guest access was removed (issue #55): /api/guest-workspace/* is not
  // served, and every chat, conversation and voice route needs a signed-in
  // account.
  mountAccountRoutes(app, {
    env,
    accounts,
    profileAutofill: autofill,
    chatMemory: () => chatService().memory,
    companyKnowledge: knowledge,
    journey,
    submissions: documentSubmissions,
  });
  // Both stores close asynchronously (Firestore client or SQLite file), as do
  // the account database pool and the profile and library clients.
  app.locals.closeChat = async () => {
    await Promise.allSettled([
      conversations?.close(),
      accounts?.close(),
      library?.close?.(),
      journeyClosed(),
    ]);
  };

  // A usable account session (no forced password change) for this request, or
  // null. Never throws: /api/config must answer even if the database is down.
  async function signedInAccount(req) {
    const token = accounts ? readCookie(req, accountCookie) : undefined;
    if (token === undefined) return null;
    try {
      const session = await accounts.session(token);
      return session && !session.account.mustChangePassword ? session.account : null;
    } catch {
      return null;
    }
  }

  // Public configuration. Credentials stay on the server. Saved chats need a
  // signed-in account (issue #55), so conversationMemory is true only for a
  // signed-in browser, in every answer mode.
  app.get('/api/config', async (req, res) => {
    const savedChats = Boolean(await signedInAccount(req));
    if (accounts) res.set({ 'Cache-Control': 'no-store', Vary: 'Cookie' });
    res.json({
      aiMode: memoryChat
        ? 'gemini-memory'
        : documentSearch
          ? 'document-search'
          : vertexConfig(env)
            ? 'gemini'
            : 'demo',
      conversationMemory: savedChats,
      memoryRetentionDays: savedChats ? 30 : null,
      adaptiveLearning: memoryChat,
      supportSummary: false,

      speechMode: cloudTts ? 'google' : localVoice ? 'windows-local' : 'browser-demo',

      voiceName: localVoice?.name || null,
      sharedVoiceName,
      // The configured voice: Gemini's with VOICE_PROVIDER=gemini, else Kokoro's.
      voice: configuredVoice,
      tasks,

      model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',

      knowledgeMode: memoryChat || documentSearch ? knowledgeMode(env) : 'sample-tasks',

      // HR and employee sign-in is available (DATABASE_URL is set).
      accounts: Boolean(accounts),
      // HR can pre-fill profile forms from a document: accounts are on and
      // GOOGLE_CLOUD_PROJECT is set (credentials are not probed).
      profileAutofill: Boolean(accounts && autofill?.available),
    });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  // Deploy smoke test for the api -> tts hop (issue #67). No sign-in: it makes one
  // signed request to the tts /health and never renders speech or reads user data.
  app.get('/api/health/tts', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!env.TTS_SERVICE_URL) return res.json({ ok: true, tts: 'local' });
    const unavailable = () => res.status(503).json({ ok: false, tts: 'unavailable' });
    try {
      const endpoint = new URL('/health', env.TTS_SERVICE_URL);
      const headers = {};
      if (ttsIdTokenProvider) {
        try {
          headers[serverlessAuthorizationHeader] = await serverlessAuthorization(
            ttsIdTokenProvider,
            endpoint.origin,
          );
        } catch (error) {
          logIdTokenFailure('api -> tts health', error);
          return unavailable();
        }
      }
      const response = await fetchImpl(endpoint, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return unavailable();
      return res.json({ ok: true, tts: 'ok' });
    } catch {
      return unavailable();
    }
  });

  // Chat, saved conversations, voice and tts need a signed-in account (an
  // employee or HR, issue #55), in every answer mode: no cookie is 401
  // AUTH_REQUIRED, an expired or invalid one 401 SESSION_EXPIRED, a forced
  // password change 403 PASSWORD_CHANGE_REQUIRED. There is no anonymous
  // fallback. Saved chats belong to the account (`account:<uuid>`).
  async function chatOwner(req, res, next) {
    if (!sameOrigin(req))
      return res.status(403).json({ error: 'Open chat on the website itself.' });
    res.set('Cache-Control', 'no-store');
    const token = accounts ? readCookie(req, accountCookie) : undefined;
    if (token === undefined) return sendAccountError(res, accountErrors.authRequired());
    let session;
    try {
      session = await accounts.session(token);
    } catch (error) {
      return chatFailure(res, error);
    }
    if (!session) {
      res.clearCookie(accountCookie, accountCookieOptions(req, env));
      return sendAccountError(res, accountErrors.sessionExpired());
    }
    if (session.account.mustChangePassword)
      return sendAccountError(res, accountErrors.passwordChangeRequired());
    req.chatOwner = `account:${session.account.id}`;
    req.chatAccount = session.account;
    return next();
  }
  function chatFailure(res, error) {
    const failure = conversationFailure(error);
    res.status(failure.status).json({ code: failure.code, error: failure.error });
  }
  // The store is async (Firestore or SQLite); every failure is a ChatError.
  app.get('/api/conversations', chatOwner, async (req, res) => {
    try {
      res.json({ conversations: await chatService().memory.list(req.chatOwner) });
    } catch (error) {
      chatFailure(res, error);
    }
  });
  app.post('/api/conversations', chatOwner, async (req, res) => {
    try {
      res.status(201).json(await chatService().memory.create(req.chatOwner));
    } catch (error) {
      chatFailure(res, error);
    }
  });
  // Assistant messages carry coverage, category, quickQuestionId, reexplainOf
  // and proposedAction at the top level, next to feedback (null when unknown,
  // as for answers saved before them), and `guardrail` when a guardrail
  // decided the turn (issue #79: { verdict: 'stale', askHr: true }; no field
  // otherwise).
  app.get('/api/conversations/:id', chatOwner, async (req, res) => {
    try {
      const chat = await chatService().memory.read(req.chatOwner, req.params.id);
      res.json({
        ...chat,
        messages: chat.messages.map((m) =>
          m.role === 'assistant'
            ? {
                ...m,
                ...Object.fromEntries(
                  journeyMessageFields.map((key) => [key, m[key] ?? m.result?.[key] ?? null]),
                ),
                ...guardrailFieldOf(m),
                ...(m.proposedAction?.status === 'pending' &&
                m.proposedAction.expiresAt <= journeyNow().toISOString()
                  ? { proposedAction: { ...m.proposedAction, status: 'expired' } }
                  : {}),
              }
            : m,
        ),
      });
    } catch (error) {
      chatFailure(res, error);
    }
  });
  app.delete('/api/conversations/:id', chatOwner, async (req, res) => {
    try {
      await chatService().memory.erase(req.chatOwner, req.params.id);
      res.status(204).end();
    } catch (error) {
      chatFailure(res, error);
    }
  });
  app.post('/api/conversations/:id/learning', chatOwner, async (req, res) => {
    try {
      res.json({ learning: await chatService().settings(req.chatOwner, req.params.id, req.body) });
    } catch (error) {
      chatFailure(res, error);
    }
  });
  app.get('/api/employee-support-summary', chatOwner, (req, res) => {
    // Named per-employee reports stay closed for everyone (D1 Option A, issue
    // #48): HR sees team-level insights and consented support requests only.
    res
      .status(403)
      .json({ code: 'HR_ACCESS_REQUIRED', error: 'Reports require verified HR access.' });
  });
  app.post('/api/support-summary/settings', chatOwner, async (req, res) => {
    try {
      const settings = await chatService().memory.supportSettings(req.chatOwner, req.body);
      res.json({ recording: settings.recording });
    } catch (error) {
      chatFailure(res, error);
    }
  });
  app.post('/api/conversations/:id/feedback', chatOwner, async (req, res) => {
    try {
      await chatService().memory.feedback(
        req.chatOwner,
        req.params.id,
        req.body.messageId,
        req.body.rating,
      );
      if (req.body.rating === 'helpful' && journey && req.chatAccount?.role === 'employee') {
        try {
          const chat = await chatService().memory.read(req.chatOwner, req.params.id);
          await journey.onboarding.recordHelpfulAnswer(
            req.chatAccount,
            chat.messages,
            req.body.messageId,
          );
        } catch {
          // Best effort: the feedback itself is already saved.
        }
      }
      res.json({ rating: req.body.rating });
    } catch (error) {
      chatFailure(res, error);
    }
  });
  app.post('/api/conversations/:id/voice-event', chatOwner, async (req, res) => {
    try {
      await chatService().memory.voiceEvent(req.chatOwner, req.params.id, req.body.messageId);
      res.json({ saved: true });
    } catch (error) {
      chatFailure(res, error);
    }
  });
  app.post('/api/conversations/:id/human-help', chatOwner, async (req, res) => {
    try {
      await chatService().memory.humanHelp(req.chatOwner, req.params.id, req.body.messageId);
      res.json({ saved: true });
    } catch (error) {
      chatFailure(res, error);
    }
  });

  // A single server-controlled voice for every visitor. No device voice,
  // cloud TTS billing, client voice override or public audio cache.
  app.post('/api/voice', chatOwner, async (req, res) => {
    const request = parseVoiceRequest(req.body);
    if (!request) return res.status(400).json({ error: voiceRequestError });
    try {
      const { wav, voice: used } = await voice.render(request.text, request.rate);
      if (res.destroyed) return;
      res.set({
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
        // The voice actually used: gemini-<voice>, or kokoro-af-heart.
        'X-Alya-Voice': used,
      });
      res.send(wav);
    } catch (error) {
      if (res.destroyed) return;
      const { status, code, error: message } = voiceFailure(error);
      res.status(status).json({ code, error: message });
    }
  });

  // Text chat and avatar share the explicitly selected answer engine.
  // Every question is a turn of one of the account's saved conversations, in
  // every answer mode (gemini-chat with memory, document search, sample
  // answers, single-turn Gemini). Signed-out calls never reach an engine.
  app.post('/api/chat', chatOwner, async (req, res) => {
    const { question, taskId, style = 'simple', conversationId, requestId } = req.body || {};

    const task = tasks.find((item) => item.id === taskId);

    if (
      typeof question !== 'string' ||
      !question.trim() ||
      question.length > 1600 ||
      !task ||
      !['simple', 'steps'].includes(style)
    ) {
      return res.status(400).json({
        error: 'Choose a task and enter a question ' + 'of up to 1,600 characters.',
      });
    }
    if (
      typeof conversationId !== 'string' ||
      typeof requestId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(requestId)
    )
      return res
        .status(400)
        .json({ error: 'Choose a saved conversation before sending a question.' });

    // Used by both the text chat and the avatar.
    async function deliver(result) {
      if (localVoice && !cloudTts && req.body.speechEnabled === true) {
        const rate = Math.max(0.8, Math.min(1.1, Number(req.body.speechRate) || 0.95));

        try {
          result.speech = await localVoice.render(result.answer, rate);
        } catch {
          result.speechError =
            'The local voice could not prepare this answer. ' +
            'You can still read it. Please try again.';
        }
      }

      res.json(result);
    }

    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 60000);
    const closed = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', closed);
    try {
      const turn = await journeyTurn(req);
      const personal = turn.chip?.kind === 'personal';
      const aiAssessment =
        journey && req.chatAccount?.role === 'employee' && !turn.chip
          ? parseChatAiAssessment(question)
          : null;
      if (aiAssessment) {
        const result = await saveTurn(
          req.chatOwner,
          conversationId,
          question.trim(),
          requestId,
          abort.signal,
          async (row) => {
            const saved = await journey.onboarding.saveAiProficiency(req.chatAccount, aiAssessment);
            return {
              answer: alyaAssessmentReply(saved.aiProficiency),
              mode: memoryChat
                ? 'gemini-memory'
                : documentSearch
                  ? 'document-search'
                  : vertexConfig(env)
                    ? 'gemini'
                    : 'demo',
              ...(documentSearch ? { matched: true } : {}),
              passages: [],
              source: checklistSource,
              card: null,
              ...(memoryChat ? { learning: row.learning } : { taskId }),
              coverage: 'full',
              category: 'onboarding',
              quickQuestionId: null,
              reexplainOf: turn.reexplainOf,
              proposedAction: null,
            };
          },
          turn,
        );
        if (!res.destroyed) {
          if (memoryChat) res.json(result);
          else await deliver(result);
        }
        return;
      }
      if (memoryChat) {
        const result = personal
          ? await saveTurn(
              req.chatOwner,
              conversationId,
              question.trim(),
              requestId,
              abort.signal,
              (row) => personalResult(req.chatAccount, turn, row),
              turn,
            )
          : await chatService().ask(
              req.chatOwner,
              conversationId,
              question.trim(),
              requestId,
              abort.signal,
              req.body.learningAction,
              {
                quickQuestionId: turn.quickQuestionId,
                reexplainOf: turn.reexplainOf,
                checklist: turn.checklist,
              },
            );
        const { supportSummary, journey: found, ...employeeAnswer } = result;
        await recordGap(req.chatAccount, question.trim(), employeeAnswer, turn, found);
        if (!res.destroyed) res.json(employeeAnswer);
        return;
      }
      const result = await saveTurn(
        req.chatOwner,
        conversationId,
        question.trim(),
        requestId,
        abort.signal,
        personal
          ? (row) => personalResult(req.chatAccount, turn, row, taskId)
          : turn.checklist && reportsCompletion(question)
            ? () => checklistResult(turn, question.trim(), abort.signal, taskId)
            : async () =>
                withJourneyFields(
                  await answerOnce({
                    question,
                    task,
                    style,
                    taskId,
                    signal: abort.signal,
                    owner: req.chatOwner,
                  }),
                  turn,
                ),
        turn,
      );
      if (!res.destroyed) await deliver(result);
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof AnswerFailure) res.status(error.status).json(error.body);
      else chatFailure(res, error);
    } finally {
      clearTimeout(timer);
      res.off('close', closed);
    }
  });

  // One answer without conversation history, from the configured engine:
  // document search, the labelled sample answer, or single-turn Gemini. A
  // failure is an AnswerFailure carrying the response the browser receives.
  // `owner` is the account's chat owner.
  async function answerOnce({ question, task, style, taskId, signal, owner }) {
    if (documentSearch) {
      const start = performance.now();
      let passages;
      try {
        passages = await quoteRetrieve(question.trim(), signal ? { signal } : undefined, owner);
      } catch (error) {
        // Company library failures are ChatErrors with fixed codes.
        const failure =
          error instanceof ChatError
            ? { status: error.status, code: error.code, error: error.message }
            : searchFailure(error);
        throw new AnswerFailure(failure.status, { code: failure.code, error: failure.error });
      }
      return {
        ...quoteSearchResults(passages),
        taskId,
        latencyMs: Math.round(performance.now() - start),
      };
    }

    // Without Vertex AI configured, return a labelled sample answer.
    const vertex = vertexConfig(env);
    if (!vertex) {
      return demoAnswer(question, task, style);
    }

    const start = performance.now();

    // Single-turn Gemini mode answers from the sample task only. Company
    // documents are searched in gemini-chat and document-search modes.
    const instruction = systemPrompt(task, style);
    const source = task.sourceStatus;

    try {
      const token = await vertexToken();

      const response = await fetchImpl(vertexGenerateContentUrl(vertex), {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },

        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
          : AbortSignal.timeout(25000),

        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: instruction }],
          },

          contents: [
            {
              role: 'user',
              parts: [{ text: question.trim() }],
            },
          ],

          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1600,
          },
        }),
      });

      if (!response.ok) {
        if (response.status === 402) {
          throw new AnswerFailure(402, {
            code: 'GEMINI_CREDIT_REQUIRED',
            error:
              "Gemini cannot answer because the project's prepaid credit is depleted. The project owner must restore billing for the Google Cloud project, then try again.",
          });
        }
        throw new Error('Google AI request failed.');
      }

      const data = await response.json();

      const answer = data.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text || '')
        .join('')
        .trim();

      if (!answer) {
        throw new Error('No answer returned.');
      }

      return {
        answer,
        mode: 'gemini',
        source,
        taskId,
        latencyMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      if (error instanceof AnswerFailure) throw error;
      throw new AnswerFailure(502, {
        error:
          'Google AI could not answer right now. ' +
          'Check Vertex AI access, model availability and quota, ' +
          'then try again.',
      });
    }
  }

  // The journey context of a saved-chat turn (issues #48-#50):
  //   quickQuestionId  a chip id from GET /api/me/quick-questions; only an
  //                    employee's own chips count, anything else is null
  //   reexplainOf      the assistant message id being re-explained (it must be
  //                    in the same chat: 404 ANSWER_NOT_FOUND otherwise)
  //   chip             the resolved chip; personal chips skip the documents
  async function journeyTurn(req) {
    const { quickQuestionId = null, reexplainOf = null } = req.body;
    if (
      reexplainOf !== null &&
      (typeof reexplainOf !== 'string' || !/^[0-9a-f-]{36}-a$/i.test(reexplainOf))
    )
      throw answerNotFound();
    const chip =
      journey && req.chatAccount?.role === 'employee' && quickQuestionId !== null
        ? await journey.onboarding.resolveChip(req.chatAccount, quickQuestionId)
        : null;
    // An employee's completion report goes to the checklist agent (#51).
    const { conversationId, requestId } = req.body;
    const account = req.chatAccount;
    const checklist =
      journey?.actions && account?.role === 'employee' && !chip
        ? ({ query, question, signal }) =>
            journey.actions.propose({
              account,
              conversationId,
              messageId: `${requestId}-a`,
              text: query || question,
              signal,
            })
        : null;
    // Alya's view of the saved progress; a failed read leaves her without it.
    let note = '';
    if (journey && account?.role === 'employee' && !chip)
      note = progressNote(await journey.onboarding.myOnboarding(account).catch(() => null));
    return {
      quickQuestionId: chip?.id ?? null,
      reexplainOf,
      chip,
      checklist,
      progressNote: note,
    };
  }
  // A completion report in the modes without the Gemini plan step, answered by
  // the checklist agent: its reply, and the proposed change if any.
  async function checklistResult(turn, question, signal, taskId) {
    const proposal = await turn.checklist({ question, signal });
    return {
      answer: proposal.answer,
      mode: documentSearch ? 'document-search' : vertexConfig(env) ? 'gemini' : 'demo',
      passages: [],
      source: checklistSource,
      card: null,
      taskId,
      coverage: null,
      category: 'onboarding',
      quickQuestionId: null,
      reexplainOf: turn.reexplainOf,
      proposedAction: proposal.proposedAction,
    };
  }
  // A personal chip's answer: the employee's first-day details and start date
  // only, never the company documents. Shaped like the mode's normal answers.
  async function personalResult(account, turn, row, taskId) {
    const reply = await journey.onboarding.personalAnswer(account, turn.chip);
    return {
      answer: reply.answer,
      mode: memoryChat
        ? 'gemini-memory'
        : documentSearch
          ? 'document-search'
          : vertexConfig(env)
            ? 'gemini'
            : 'demo',
      ...(documentSearch ? { matched: reply.coverage === 'full' } : {}),
      passages: [],
      source: personalSource,
      card: null,
      ...(memoryChat ? { learning: row.learning } : { taskId }),
      coverage: reply.coverage,
      category: 'onboarding',
      quickQuestionId: turn.quickQuestionId,
      reexplainOf: turn.reexplainOf,
      proposedAction: null,
    };
  }
  // A document-search, sample or single-turn Gemini answer of an account chat
  // with the journey fields: document search covers a question fully when a
  // passage matched and not at all otherwise; the other modes are unknown.
  const withJourneyFields = (result, turn) => ({
    ...result,
    coverage: documentSearch ? (result.matched ? 'full' : 'none') : null,
    category: null,
    quickQuestionId: turn.quickQuestionId,
    reexplainOf: turn.reexplainOf,
    proposedAction: null,
  });
  // Logs an anonymous knowledge gap (issue #49) for a fresh employee turn that
  // the documents could not answer: category onboarding, coverage none, not a
  // personal chip and not a re-explanation of an earlier answer. Best effort:
  // the answer is delivered even if this write fails.
  async function recordGap(account, question, answer, turn, found) {
    if (!journey || !found || account?.role !== 'employee') return;
    if (answer.category !== 'onboarding' || answer.coverage !== 'none') return;
    if (turn.chip?.kind === 'personal' || turn.reexplainOf) return;
    try {
      await journey.gaps.record({
        question,
        topic: found.topic,
        track: await journey.onboarding.trackFor(account),
        nearestSource: found.nearestSource,
      });
    } catch {
      console.warn('A knowledge gap could not be recorded.');
    }
  }

  // Saves one question and its answer in a saved conversation (the turn of a
  // non-memory answer mode). The chat is leased while the
  // answer is prepared; repeating a request ID returns the saved answer.
  // compute(row) makes the answer; `turn` (journeyTurn) adds the journey
  // fields to the saved assistant message.
  async function saveTurn(owner, id, question, requestId, signal, compute, turn = null) {
    const lease = await chatService().memory.acquire(owner, id),
      row = lease.row;
    try {
      const completed = row.messages.find(
        (m) => m.requestId === requestId && m.role === 'assistant',
      );
      if (completed) {
        const original = row.messages.find((m) => m.requestId === requestId && m.role === 'user');
        if (original?.text !== question)
          throw new ChatError(
            409,
            'REQUEST_CONFLICT',
            'Start a new request for a different question.',
          );
        return completed.result;
      }
      if (row.messages.length >= 160)
        throw new ChatError(
          409,
          'CHAT_FULL',
          'This conversation has reached 80 questions. Start a new chat; you can still read this one.',
        );
      if (
        turn?.reexplainOf != null &&
        !row.messages.some((m) => m.id === turn.reexplainOf && m.role === 'assistant')
      )
        throw answerNotFound();
      const result = { ...(await compute(row)), conversationId: id };
      signal?.throwIfAborted();
      await lease.save(
        [
          { id: requestId + '-u', requestId, role: 'user', text: question },
          {
            id: requestId + '-a',
            requestId,
            role: 'assistant',
            text: result.answer,
            result,
            ...(turn ? journeyFieldsOf(result) : {}),
          },
        ],
        row.learning,
      );
      return result;
    } finally {
      await lease.release();
    }
  }

  // LOCAL WINDOWS VOICE
  app.post('/api/tts/local', chatOwner, async (req, res) => {
    if (!localVoice) {
      return res.status(503).json({
        error:
          'A local Windows voice is not available. ' +
          'Configure Google voice or use a browser ' +
          'with speech support.',
      });
    }

    const text = req.body?.text;

    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 5000) {
      return res.status(400).json({
        error: 'Enter speech text of up to 5,000 bytes.',
      });
    }

    const rate = Math.max(0.8, Math.min(1.1, Number(req.body?.rate) || 0.95));

    try {
      const speech = await localVoice.render(text, rate);

      res.json(speech);
    } catch {
      res.status(502).json({
        error: 'The local voice could not prepare this answer. ' + 'Please try again.',
      });
    }
  });

  // GOOGLE TEXT-TO-SPEECH
  app.post('/api/tts', chatOwner, async (req, res) => {
    if (!cloudTts) {
      return res.status(503).json({
        error: 'Google voice is not configured. ' + 'Use the local preview voice.',
      });
    }

    const ssml = req.body?.input?.ssml;

    const invalidSpeech =
      typeof ssml !== 'string' ||
      Buffer.byteLength(ssml, 'utf8') > 5000 ||
      !ssml.startsWith('<speak>') ||
      !ssml.endsWith('</speak>') ||
      /<(?!\/?speak\b|mark\b|break\b)[^>]*>/i.test(ssml);

    if (invalidSpeech) {
      return res.status(400).json({
        error: 'Invalid speech input.',
      });
    }

    try {
      const client = await googleVoiceAuth.getClient();
      const token = await client.getAccessToken();

      const speakingRate = Math.max(
        0.75,
        Math.min(1.15, Number(req.body?.audioConfig?.speakingRate) || 0.95),
      );

      const response = await fetchImpl(
        'https://texttospeech.googleapis.com/v1beta1/text:synthesize',
        {
          method: 'POST',
          signal: AbortSignal.timeout(25000),

          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token.token}`,
            'x-goog-user-project': env.GOOGLE_CLOUD_PROJECT,
          },

          body: JSON.stringify({
            input: { ssml },

            voice: {
              languageCode: 'en-US',
              name: 'en-US-Standard-F',
            },

            audioConfig: {
              audioEncoding: 'MP3',
              speakingRate,
            },

            enableTimePointing: ['SSML_MARK'],
          }),
        },
      );

      if (!response.ok) {
        throw new Error('Voice unavailable.');
      }

      const data = await response.json();

      res.json({
        ...data,
        timepoints: data.timepoints || [],
      });
    } catch {
      res.status(502).json({
        error: 'Google voice could not play. ' + 'You can still read the answer.',
      });
    }
  });

  // Unknown /api paths, including the removed /api/guest-workspace/* (issue
  // #55), are a JSON 404: never the web app's index.html.
  app.use('/api', (req, res) =>
    res.status(404).json({ code: 'NOT_FOUND', error: 'This API route is unavailable.' }),
  );

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.status === 413 ? 'Request is too large.' : 'Invalid request.',
    });
  });

  return app;
}
