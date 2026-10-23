// Shared set-up for the account tests: the app with accounts on, PostgreSQL in
// pg-mem (real migrations), Firestore in the in-memory fake, a movable clock,
// cheaper scrypt parameters, and cookie-jar browsers. Synthetic data only.
import { once } from 'node:events';
import { AIMessage } from '@langchain/core/messages';
import { createApp } from '../../server/api-routes.mjs';
import { createAccountService } from '../../server/account-service.mjs';
import { createAccountStore } from '../../server/account-store.mjs';
import { createCompanyDocumentStore } from '../../server/company-documents.mjs';
import { createProfileStore } from '../../server/employee-profiles.mjs';
import { createProfileAutofill } from '../../server/profile-autofill.mjs';
import { createFirestoreChatMemory } from '../../server/firestore-chat-memory.mjs';
import { createConversationService } from '../../server/gemini-chat-workflow.mjs';
import { hashPassword, verifyPassword } from '../../server/password-hashing.mjs';
import { builtInTemplate, starterTemplate } from '../../server/onboarding-content.mjs';
import { DEFAULT_COMPANY_ID, contentPackOf, templateDocId } from '../../server/companies.mjs';
import { FakeFirestore } from './fake-firestore.mjs';
import { createTestDatabase } from './test-database.mjs';

// Same format and code path as production, with less work per hash.
export const fastScrypt = Object.freeze({ n: 1024, r: 8, p: 1, keyLength: 64 });
export function countingHashing() {
  const counts = { hash: 0, verify: 0 };
  const dummy = hashPassword('synthetic-dummy-password', fastScrypt);
  return {
    counts,
    hash: (password) => {
      counts.hash++;
      return hashPassword(password, fastScrypt);
    },
    verify: (password, stored) => {
      counts.verify++;
      return verifyPassword(password, stored);
    },
    dummy: () => dummy,
  };
}

// The settings accounts require; the fake Firestore is injected, so the
// emulator host is never contacted.
export const accountEnv = Object.freeze({
  DATABASE_URL: 'postgresql://onboardai:synthetic-db-secret@127.0.0.1:1/onboardai',
  FIRESTORE_DATABASE_ID: '(default)',
  FIRESTORE_PROJECT_ID: 'demo-test',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:1',
});

export function testClock(start = '2026-10-15T01:00:00.000Z') {
  let at = Date.parse(start);
  return { now: () => new Date(at), advance: (ms) => (at += ms) };
}

export const fakeModels = () => ({
  plan: { invoke: async () => ({ kind: 'company', query: 'dress code', clarification: '' }) },
  answer: { invoke: async () => ({ answer: 'Business casual clothing.', citations: [1] }) },
  summarize: { invoke: async () => new AIMessage('Earlier questions.') },
});
export const fakeRetrieve = async () => [
  { title: 'Synthetic handbook', heading: 'Dress', text: 'Business casual clothing.' },
];

// People & Culture by default, so employees made with it are PC-0001, PC-0002, ...
export const syntheticProfile = (fullName = 'Avery Example', department = 'People & Culture') => ({
  job: {
    fullName,
    preferredName: 'Avery',
    jobTitle: 'Onboarding Analyst',
    department,
    startDate: '2026-11-02',
    manager: 'Jordan Sample',
  },
  contact: {
    workEmail: 'avery.example@example.com',
    personalEmail: 'avery.home@example.org',
    mobileNumber: '+65 5550 0101',
  },
  emergencyContact: {
    name: 'Riley Example',
    relationship: 'Sibling',
    phoneNumber: '+65 5550 0102',
  },
  homeAddress: {
    line1: '1 Example Street',
    line2: '#01-01',
    city: 'Sample City',
    state: 'Sample State',
    postcode: '000001',
    country: 'Exampleland',
  },
});

// A browser: keeps cookies between requests like a real one (Path=/api only).
export class Browser {
  constructor(url) {
    this.url = url;
    this.cookies = new Map();
  }
  get cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  // A second browser holding a copy of this one's cookies (a stolen or old cookie).
  copy() {
    const other = new Browser(this.url);
    other.cookies = new Map(this.cookies);
    return other;
  }
  remember(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const name = pair.slice(0, pair.indexOf('=')),
        value = pair.slice(pair.indexOf('=') + 1);
      const gone = attributes.some(
        (a) =>
          /^max-age=0$/i.test(a) || (/^expires=/i.test(a) && Date.parse(a.slice(8)) <= Date.now()),
      );
      if (gone || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async request(method, path, body, headers = {}, raw = undefined) {
    const response = await fetch(this.url + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookies.size ? { cookie: this.cookieHeader } : {}),
        ...headers,
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    this.remember(response);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON.
    }
    return { status: response.status, body: json, text, headers: response.headers };
  }
  get = (path, headers) => this.request('GET', path, undefined, headers);
  post = (path, body = {}, headers) => this.request('POST', path, body, headers);
  put = (path, body = {}, headers) => this.request('PUT', path, body, headers);
  patch = (path, body = {}, headers) => this.request('PATCH', path, body, headers);
  // A raw file upload, as the HR Company knowledge page sends it.
  upload = (path, buffer, fileName, headers) =>
    this.request(
      'POST',
      path,
      undefined,
      {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(fileName),
        ...headers,
      },
      buffer,
    );
  delete = (path, headers) => this.request('DELETE', path, undefined, headers);
  signIn = (username, password) => this.post('/api/auth/sign-in', { username, password });
}

// Starts the app with accounts on. mode is the AI_MODE; `accounts: false`
// starts it without the accounts service (DATABASE_URL unset). `autofill`, when
// given, is passed to createProfileAutofill (model, fetchImpl, timeoutMs, ...)
// with its log lines kept in `logs`; without it the app builds its default
// autofill service, whose Vertex AI requests fail. The company search is the
// synthetic handbook (`companyRetrieve`). `models` replaces the fake Gemini
// models of gemini-chat mode; the onboarding journey uses the same fake
// Firestore and clock, with no template cache.
export async function startAccountsApp({
  mode = 'document-search',
  env: extraEnv = {},
  accounts: enabled = true,
  storageTimeoutMs = 300,
  // The saved-chat store's Firestore limit; undefined keeps the 10-second default.
  chatStorageTimeoutMs = undefined,
  autofill = undefined,
  companyRetrieve = fakeRetrieve,
  companyDocumentSync = undefined,
  submissionFiles = undefined,
  // The company document file reader (company-document-files.mjs); createApp's
  // default (DOCS_BUCKET through fetchImpl) when undefined.
  companyDocumentFiles = undefined,
  fetchImpl: customFetch = undefined,
  models = fakeModels,
  // Optional voice stand-ins (POST /api/voice and /api/tts/local).
  sharedVoice = undefined,
  localVoice = null,
  // The checklist agent (#51) and Gemini voice (#52) stand-ins; off by default.
  checklistAgent = null,
  geminiVoice = null,
  // The written-check grader (check-grader.mjs); off by default.
  checkGrader = null,
  // The api -> tts ID token provider (service-auth.mjs); createApp's default when undefined.
  idTokenProvider = undefined,
} = {}) {
  const database = await createTestDatabase();
  const firestore = new FakeFirestore();
  const clock = testClock();
  const hashing = countingHashing();
  const logs = [];
  const log = (line) => logs.push(line);
  // The structured onboardai_docs_sync lines (C-SYNC) of the company document sync.
  const syncEvents = [];
  const store = createAccountStore({ pool: database.pool, log });
  const profiles = createProfileStore({ firestore, log, timeoutMs: storageTimeoutMs });
  const accounts = createAccountService({ store, profiles, now: clock.now, hashing, log });
  const env = { AI_MODE: mode, ...(enabled ? accountEnv : {}), ...extraEnv };
  const memory = createFirestoreChatMemory({
    firestore,
    log,
    timeoutMs: chatStorageTimeoutMs,
    sweepIntervalMs: Infinity,
  });
  // The app passes in its Vertex AI Search retriever.
  const conversationService = ({ retrieve }) =>
    createConversationService({ env, memory, models: models(), retrieve });
  const getAccessToken = async () => 'synthetic-token';
  const fetchImpl =
    customFetch ||
    (async () => {
      throw new Error('No Google request is expected in account tests.');
    });
  // As in createApp: the store syncs uploads and deletes to GCS + Vertex AI
  // Search when env has DOCS_BUCKET and VERTEX_SEARCH_DATA_STORE_ID, through
  // fetchImpl; `companyDocumentSync` replaces that sync. Its log lines are kept
  // in syncEvents (objects) and, as JSON text, in logs.
  const companyDocuments = createCompanyDocumentStore({
    firestore,
    log,
    logEvent: (entry) => {
      syncEvents.push(entry);
      logs.push(JSON.stringify(entry));
    },
    timeoutMs: storageTimeoutMs,
    documentSync: companyDocumentSync,
    env,
    fetchImpl,
    getAccessToken,
  });
  const app = createApp({
    env,
    accountService: enabled ? accounts : null,
    conversationService,
    companyDocuments,
    submissionFiles,
    ...(companyDocumentFiles !== undefined ? { companyDocumentFiles } : {}),
    companyRetrieve,
    getAccessToken,
    fetchImpl,
    journeyStorage: enabled ? { firestore, now: clock.now, cacheMs: 0, log } : null,
    localVoice,
    checklistAgent,
    geminiVoice,
    checkGrader,
    ...(idTokenProvider !== undefined ? { idTokenProvider } : {}),
    ...(sharedVoice ? { sharedVoice } : {}),
    ...(autofill
      ? {
          profileAutofill: createProfileAutofill({
            env,
            log,
            getAccessToken,
            fetchImpl,
            departmentNames: () => accounts.activeDepartmentNames(),
            ...autofill,
          }),
        }
      : {}),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  // An HR account made the way `npm run hr:create` makes it.
  async function createHr(username = 'HR-0001', password = 'synthetic-hr-pass-1') {
    return store.createAccount({
      username,
      passwordHash: await hashing.hash(password),
      role: 'hr',
      mustChangePassword: false,
      action: 'hr_account_created',
      at: clock.now(),
      companyId: DEFAULT_COMPANY_ID,
    });
  }
  // A company (issue #86) with one department (prefix, so its employees get
  // <prefix>-0001, ...) and a signed-in HR browser of it.
  async function companyHrBrowser({
    companyId,
    name = companyId,
    prefix = 'CO',
    username = `${prefix}-HR`,
    password = 'synthetic-company-hr-pass-1',
  }) {
    await store.createCompany(null, { ids: [companyId], name }, clock.now(), [
      { name: 'People & Culture', prefix },
    ]);
    await store.createAccount({
      username,
      passwordHash: await hashing.hash(password),
      role: 'hr',
      mustChangePassword: false,
      action: 'hr_account_created',
      at: clock.now(),
      companyId,
    });
    const hr = new Browser(url);
    const signed = await hr.signIn(username, password);
    if (signed.status !== 200) throw new Error('Company HR sign-in failed in test set-up');
    return hr;
  }
  return {
    url,
    env,
    database,
    firestore,
    clock,
    hashing,
    logs,
    syncEvents,
    store,
    accounts,
    browser: () => new Browser(url),
    createHr,
    companyHrBrowser,
    // An HR browser that is signed in, and helpers creating employees with it.
    async hrBrowser(username = 'HR-0001', password = 'synthetic-hr-pass-1') {
      await createHr(username, password);
      const hr = new Browser(url);
      const signed = await hr.signIn(username, password);
      if (signed.status !== 200) throw new Error('HR sign-in failed in test set-up');
      return hr;
    },
    // The 201 body: { employee, temporaryPassword }. The server assigns the
    // Employee ID from the profile's department (PC-0001 for the first default).
    async createEmployee(hr, profile = syntheticProfile()) {
      const created = await hr.post('/api/hr/employees', { profile });
      if (created.status !== 201) throw new Error(`Employee creation failed: ${created.text}`);
      return created.body;
    },
    // An employee who has signed in and replaced the temporary password.
    async readyEmployee(
      hr,
      { password = 'employee-own-pass-1', profile = syntheticProfile() } = {},
    ) {
      const { employee, temporaryPassword } = await this.createEmployee(hr, profile);
      const browser = new Browser(url);
      await browser.signIn(employee.account.username, temporaryPassword);
      const changed = await browser.post('/api/auth/password', {
        currentPassword: temporaryPassword,
        newPassword: password,
      });
      if (changed.status !== 200) throw new Error(`Password change failed: ${changed.text}`);
      return { employee, browser, temporaryPassword };
    },
    // Records Alya's briefing (contract v1.5) of every required step of the
    // track, straight in the progress document, as POST .../briefing would.
    // For tests about something else; the briefing gate has its own tests.
    briefAll(accountId, { track = 'employee', by = 'read', companyId = DEFAULT_COMPANY_ID } = {}) {
      const path = `onboardingProgress/${accountId}`;
      const current = firestore.read(path) || { accountId, steps: {} };
      const at = clock.now().toISOString();
      const steps = { ...current.steps };
      // The stored template the server uses (the company's pack, issue #126):
      // current-version only; older ones are ignored.
      const fallback = (contentPackOf(companyId) === 'starter' ? starterTemplate : builtInTemplate)(
        track,
      );
      const stored = firestore.read(`onboardingTemplates/${templateDocId(companyId, track)}`);
      const used = stored?.version >= fallback.version ? stored : fallback;
      for (const area of used.areas)
        for (const step of area.steps)
          if (step.required && step.briefing)
            steps[step.id] = { ...(steps[step.id] || {}), briefedAt: at, briefedBy: by };
      firestore.write(path, { accountId, updatedAt: at, steps });
    },
    rows: database.rows,
    memory,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await memory.close();
    },
  };
}
