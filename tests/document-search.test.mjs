import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  CompanySearchError,
  createVertexSearch,
  fileNameOf,
  passagesFromSearch,
  searchFailure,
  servingConfigName,
  vertexSearchConfig,
  vertexSearchUrl,
} from '../server/vertex-ai-search.mjs';
import {
  createCompanyRetriever,
  describeKnowledgeSource,
  knowledgeMode,
  sampleSourceTitle,
} from '../server/company-document-retriever.mjs';
import { createApp } from '../server/api-routes.mjs';
import { randomUUID } from 'node:crypto';
import { signedInFetch, stubAccounts } from './server/signed-in.mjs';
import { summary, syntheticLibrary } from './server/active-documents-fixtures.mjs';

// Synthetic Vertex AI Search configuration and chunk-mode responses. No test
// calls Google: every request goes to an injected fetch and token provider.
const searchEnv = {
  GOOGLE_CLOUD_PROJECT: 'test-project',
  VERTEX_SEARCH_LOCATION: 'global',
  VERTEX_SEARCH_ENGINE_ID: 'test-engine',
};
const token = async () => 'test-access-token';
const quiet = () => {};
// Both documents are active entries of the synthetic company library below
// (the retrieval allowlist admits only those, issue #79).
const handbookId = '0a1b2c3d-0000-4000-8000-000000000001';
const hoursId = '0a1b2c3d-0000-4000-8000-000000000002';
const library = () =>
  syntheticLibrary([
    summary({ id: handbookId, fileName: 'Employee Handbook.pdf' }),
    summary({ id: hoursId, fileName: 'Working Hours.docx', connectedAt: null }),
  ]);
const searchResponse = {
  totalSize: 2,
  results: [
    {
      id: 'doc-handbook',
      chunk: {
        name: 'projects/123/locations/global/collections/default_collection/dataStores/test-store/branches/0/documents/doc-handbook/chunks/c5',
        id: 'c5',
        content:
          '# Test Handbook\n## Dress Code\nBusiness casual clothing is required. Plain T-shirts are permitted on Fridays only.',
        documentMetadata: {
          uri: `gs://test-bucket/${handbookId}/Employee%20Handbook.pdf`,
          title: `gs://test-bucket/${handbookId}/Employee%20Handbook.pdf`,
        },
        pageSpan: { pageStart: 4, pageEnd: 4 },
        chunkMetadata: {
          previousChunks: [{ id: 'c4', content: 'Workspace\nKeep your desk tidy.' }],
          nextChunks: [{ id: 'c6', content: 'Client meetings require formal attire.' }],
        },
      },
    },
    {
      id: 'doc-hours',
      chunk: {
        id: 'c1',
        content: 'Office hours are 10 AM to 6 PM Monday to Friday.',
        documentMetadata: {
          uri: `gs://test-bucket/${hoursId}/Working%20Hours.docx`,
          title: 'Working Hours',
        },
        pageSpan: { pageStart: 1, pageEnd: 2 },
      },
    },
  ],
};
function fakeSearch(respond = () => Response.json(searchResponse)) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return respond(url, options);
    },
  };
}
const hang = (url, { signal }) =>
  new Promise((resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

test('the engine ID switches on Vertex AI Search and the serving config follows the env', () => {
  assert.equal(vertexSearchConfig({ GOOGLE_CLOUD_PROJECT: 'test-project' }), null);
  assert.equal(knowledgeMode({ GOOGLE_CLOUD_PROJECT: 'test-project' }), 'sample-tasks');
  assert.equal(knowledgeMode(searchEnv), 'vertex-ai-search');
  const config = vertexSearchConfig(searchEnv);
  assert.deepEqual(config, { project: 'test-project', location: 'global', engine: 'test-engine' });
  assert.equal(
    vertexSearchConfig({ GOOGLE_CLOUD_PROJECT: 'p', VERTEX_SEARCH_ENGINE_ID: 'e' }).location,
    'global',
  );
  assert.equal(
    servingConfigName({ project: '48074397808', location: 'global', engine: 'onboardai-search' }),
    'projects/48074397808/locations/global/collections/default_collection/engines/onboardai-search/servingConfigs/default_search',
  );
  assert.equal(
    vertexSearchUrl(config),
    'https://discoveryengine.googleapis.com/v1/projects/test-project/locations/global' +
      '/collections/default_collection/engines/test-engine/servingConfigs/default_search:search',
  );
  for (const location of ['us', 'eu'])
    assert.equal(
      vertexSearchUrl({ ...config, location }),
      `https://${location}-discoveryengine.googleapis.com/v1/projects/test-project/locations/${location}` +
        '/collections/default_collection/engines/test-engine/servingConfigs/default_search:search',
    );
  assert.match(describeKnowledgeSource(searchEnv), /test-engine \(global\)/);
  assert.match(describeKnowledgeSource({}), /sample onboarding guide/);
  assert.match(
    describeKnowledgeSource({ VERTEX_SEARCH_ENGINE_ID: 'test-engine' }),
    /incomplete: GOOGLE_CLOUD_PROJECT is not set/,
  );
  assert.match(
    describeKnowledgeSource({ ...searchEnv, VERTEX_SEARCH_LOCATION: 'bad/x' }),
    /incomplete: VERTEX_SEARCH_LOCATION is invalid/,
  );
  assert.ok(!describeKnowledgeSource(searchEnv).includes('incomplete'));
});

test('a search posts the query to the serving config in chunk mode with a bearer token', async () => {
  const { calls, fetchImpl } = fakeSearch();
  const retrieve = createCompanyRetriever({
    env: searchEnv,
    fetchImpl,
    getAccessToken: token,
    log: quiet,
  });
  await retrieve('  T-shirt clothing dress code  ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, vertexSearchUrl(vertexSearchConfig(searchEnv)));
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-access-token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['x-goog-api-key'], undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].body, {
    query: 'T-shirt clothing dress code',
    pageSize: 5,
    contentSearchSpec: {
      searchResultMode: 'CHUNKS',
      chunkSpec: { numPreviousChunks: 1, numNextChunks: 1 },
    },
    filter: 'companyId: ANY("univrse")',
  });
});

test('chunk results become passages with file names, sections and neighbouring context', () => {
  const passages = passagesFromSearch(searchResponse);
  assert.deepEqual(passages, [
    {
      title: 'Employee Handbook.pdf',
      heading: 'Dress Code · page 4',
      text:
        'Workspace\nKeep your desk tidy.\n\n' +
        searchResponse.results[0].chunk.content +
        '\n\nClient meetings require formal attire.',
      excerpt: searchResponse.results[0].chunk.content,
      // Internal, for the retrieval allowlist only: never sent to the browser.
      uri: `gs://test-bucket/${handbookId}/Employee%20Handbook.pdf`,
      vertexId: 'doc-handbook',
    },
    {
      title: 'Working Hours.docx',
      heading: 'Pages 1–2',
      text: 'Office hours are 10 AM to 6 PM Monday to Friday.',
      excerpt: 'Office hours are 10 AM to 6 PM Monday to Friday.',
      uri: `gs://test-bucket/${hoursId}/Working%20Hours.docx`,
      vertexId: null,
    },
  ]);
  // The same response always yields the same passages in the same order.
  assert.deepEqual(passagesFromSearch(structuredClone(searchResponse)), passages);
});

test('overlapping neighbours and repeated chunks are included only once, in rank order', () => {
  const guide = { uri: 'gs://test-bucket/Guide.pdf' };
  const passages = passagesFromSearch({
    results: [
      {
        id: 'guide',
        chunk: {
          id: 'c2',
          content: 'Two',
          documentMetadata: guide,
          chunkMetadata: {
            previousChunks: [{ id: 'c1', content: 'One' }],
            nextChunks: [{ id: 'c3', content: 'Three' }],
          },
        },
      },
      {
        id: 'guide',
        chunk: {
          id: 'c3',
          content: 'Three',
          documentMetadata: guide,
          chunkMetadata: { nextChunks: [{ id: 'c4', content: 'Four' }] },
        },
      },
      {
        id: 'guide',
        chunk: {
          id: 'c5',
          content: 'Five',
          documentMetadata: guide,
          chunkMetadata: { previousChunks: [{ id: 'c4', content: 'Four' }] },
        },
      },
      {
        id: 'other',
        chunk: { id: 'c1', content: 'Other one', documentMetadata: { title: 'Other guide' } },
      },
      {
        id: 'guide',
        chunk: {
          name: 'projects/123/locations/global/collections/default_collection/dataStores/test-store/branches/0/documents/guide/chunks/c4',
          content: 'Four',
          documentMetadata: guide,
        },
      },
    ],
  });
  assert.deepEqual(
    passages.map((passage) => [passage.title, passage.text]),
    [
      ['Guide.pdf', 'One\n\nTwo\n\nThree'],
      ['Guide.pdf', 'Four\n\nFive'],
      ['Other guide', 'Other one'],
    ],
  );
});

test('file names come from the document URI or title, and sources never show gs:// URIs', () => {
  assert.equal(
    fileNameOf({ uri: 'gs://project-onboardai-docs/policies/Leave%20Policy.pdf' }),
    'Leave Policy.pdf',
  );
  assert.equal(
    fileNameOf({ uri: 'gs://test-bucket/Leave Policy.pdf?generation=1#x', title: 'Other' }),
    'Leave Policy.pdf',
  );
  assert.equal(
    fileNameOf({ uri: 'gs://bucket-only', title: 'Code of Conduct' }),
    'Code of Conduct',
  );
  assert.equal(fileNameOf({ title: 'gs://test-bucket/folder/Benefits.docx' }), 'Benefits.docx');
  assert.equal(fileNameOf({ uri: 'gs://test-bucket/bad%E0%A4%A.pdf' }), 'bad%E0%A4%A.pdf');
  assert.equal(
    fileNameOf({ uri: 'gs://test-bucket/', title: 'gs://test-bucket' }),
    'Company document',
  );
  assert.equal(fileNameOf(), 'Company document');
  const visible = JSON.stringify(
    passagesFromSearch(searchResponse).map(({ title, heading }) => ({ title, heading })),
  );
  assert.ok(!visible.includes('gs://'));
  assert.ok(!visible.includes('test-bucket'));
});

test('empty results, blank chunks and blank queries return no passages', async () => {
  assert.deepEqual(passagesFromSearch(null), []);
  assert.deepEqual(passagesFromSearch({}), []);
  assert.deepEqual(
    passagesFromSearch({ results: [{ id: 'x', chunk: { content: '   ' } }, { id: 'y' }, null] }),
    [],
  );
  const { calls, fetchImpl } = fakeSearch(() => Response.json({ totalSize: 0 }));
  const retrieve = createCompanyRetriever({
    env: searchEnv,
    fetchImpl,
    getAccessToken: token,
    log: quiet,
  });
  assert.deepEqual(await retrieve('quantum banana teleporter'), []);
  assert.deepEqual(await retrieve('   '), []);
  assert.equal(calls.length, 1);
});

test('HTTP 401, 403, 404, 400, 429 and 5xx map to safe errors without provider details', async () => {
  const logged = [];
  for (const [status, code, publicStatus] of [
    [401, 'SEARCH_AUTH_REQUIRED', 503],
    [403, 'SEARCH_ACCESS_DENIED', 503],
    [404, 'SEARCH_NOT_FOUND', 503],
    [400, 'SEARCH_REQUEST_REJECTED', 503],
    [429, 'SEARCH_RATE_LIMIT', 429],
    [500, 'SEARCH_UNAVAILABLE', 503],
    [503, 'SEARCH_UNAVAILABLE', 503],
  ]) {
    const search = createVertexSearch({
      config: vertexSearchConfig(searchEnv),
      getAccessToken: token,
      log: (message) => logged.push(message),
      fetchImpl: async () =>
        Response.json(
          { error: { code: status, status: 'TEST_REASON', message: 'private provider details' } },
          { status },
        ),
    });
    await assert.rejects(search('dress code'), (error) => {
      assert.ok(error instanceof CompanySearchError);
      assert.equal(error.code, code);
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.reason, 'TEST_REASON');
      const failure = searchFailure(error);
      assert.deepEqual(failure, { status: publicStatus, code, error: error.message });
      assert.ok(!JSON.stringify(failure).includes('private provider'));
      assert.ok(!JSON.stringify(failure).includes('test-access-token'));
      return true;
    });
  }
  assert.match(
    searchFailure(new CompanySearchError('SEARCH_ACCESS_DENIED')).error,
    /Discovery Engine Viewer/,
  );
  // The server log names the status and Google's reason, not the query or message.
  assert.match(logged[1], /"status":403,"reason":"TEST_REASON"/);
  assert.ok(!logged.join('\n').includes('private provider'));
  assert.ok(!logged.join('\n').includes('dress code'));
});

test('a slow search times out as SEARCH_TIMEOUT, and a cancelled chat stays a cancellation', async () => {
  const config = vertexSearchConfig(searchEnv);
  const slow = createVertexSearch({
    config,
    getAccessToken: token,
    fetchImpl: hang,
    timeoutMs: 20,
    log: quiet,
  });
  await assert.rejects(
    slow('dress code'),
    (error) => error.code === 'SEARCH_TIMEOUT' && searchFailure(error).status === 504,
  );
  const slowCredentials = createVertexSearch({
    config,
    getAccessToken: () => new Promise(() => {}),
    fetchImpl: async () => assert.fail('no request without a token'),
    timeoutMs: 20,
    log: quiet,
  });
  await assert.rejects(slowCredentials('dress code'), { code: 'SEARCH_TIMEOUT' });
  const cancel = new AbortController();
  const patient = createVertexSearch({
    config,
    getAccessToken: token,
    fetchImpl: hang,
    log: quiet,
  });
  const pending = patient('dress code', { signal: cancel.signal });
  cancel.abort();
  await assert.rejects(
    pending,
    (error) => error.name === 'AbortError' && !(error instanceof CompanySearchError),
  );
});

test('credential, network and malformed-response failures never expose raw error text', async () => {
  const config = vertexSearchConfig(searchEnv);
  const noCredentials = createVertexSearch({
    config,
    log: quiet,
    getAccessToken: async () => {
      throw new Error('secret ADC failure detail');
    },
    fetchImpl: async () => assert.fail('no request without a token'),
  });
  await assert.rejects(
    noCredentials('dress code'),
    (error) => error.code === 'SEARCH_AUTH_REQUIRED' && !error.message.includes('secret'),
  );
  const offline = createVertexSearch({
    config,
    log: quiet,
    getAccessToken: token,
    fetchImpl: async () => {
      throw new TypeError('fetch failed: private socket detail');
    },
  });
  await assert.rejects(
    offline('dress code'),
    (error) => error.code === 'SEARCH_UNAVAILABLE' && !error.message.includes('private'),
  );
  const garbled = createVertexSearch({
    config,
    log: quiet,
    getAccessToken: token,
    fetchImpl: async () => new Response('<html>private page</html>', { status: 200 }),
  });
  await assert.rejects(garbled('dress code'), { code: 'SEARCH_UNAVAILABLE' });
  const failure = searchFailure(new Error('private-key-data'));
  assert.equal(failure.code, 'SEARCH_UNAVAILABLE');
  assert.ok(!JSON.stringify(failure).includes('private'));
});

test('an engine ID without a project, or with an invalid location, makes no request', async () => {
  for (const env of [
    { VERTEX_SEARCH_ENGINE_ID: 'test-engine' },
    { ...searchEnv, VERTEX_SEARCH_LOCATION: 'evil.example/x' },
  ]) {
    const retrieve = createCompanyRetriever({
      env,
      getAccessToken: token,
      fetchImpl: async () => assert.fail('no request'),
      log: quiet,
    });
    await assert.rejects(
      retrieve('dress code'),
      (error) => error.code === 'SEARCH_NOT_CONFIGURED' && searchFailure(error).status === 503,
    );
  }
});

test('without VERTEX_SEARCH_ENGINE_ID, retrieval uses the labelled sample guide and calls nothing', async () => {
  const retrieve = createCompanyRetriever({
    env: { GOOGLE_CLOUD_PROJECT: 'test-project' },
    fetchImpl: async () => assert.fail('no Google request'),
    getAccessToken: async () => assert.fail('no token'),
  });
  const found = await retrieve('How do I finish the onboarding quiz?');
  assert.equal(found.length, 1);
  assert.equal(found[0].title, sampleSourceTitle);
  assert.equal(found[0].heading, 'Complete onboarding quiz — Part 1');
  assert.match(found[0].text, /^Unapproved sample guidance/);
  assert.deepEqual(await retrieve('What is the dress code?'), []);
  // The "unapproved sample guidance" label is not searchable text.
  assert.deepEqual(await retrieve('Is this guidance unapproved?'), []);
});

// Chat needs a signed-in account (issue #55): the server below has a
// synthetic employee, and each question is a turn of a new in-memory chat.
const signedIn = signedInFetch();
async function withServer(options, check) {
  const app = createApp({
    getAccessToken: token,
    accountService: stubAccounts(),
    ...options,
    env: { CHAT_DATABASE_PATH: ':memory:', ...options.env },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await check(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.closeChat();
  }
}
const ask = async (url, question = 'What are the working hours?') => {
  const chat = await (await signedIn(url + '/api/conversations', { method: 'POST' })).json();
  return signedIn(url + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      taskId: 'quiz-part-1',
      conversationId: chat.id,
      requestId: randomUUID(),
    }),
  });
};

test('document-search mode quotes Vertex AI Search passages by file name and never calls Gemini', async () => {
  const { calls, fetchImpl } = fakeSearch();
  await withServer(
    {
      env: { AI_MODE: 'document-search', ...searchEnv, DOCS_BUCKET: 'test-bucket' },
      companyDocuments: library(),
      fetchImpl,
    },
    async (url) => {
      const config = await (await fetch(url + '/api/config')).json();
      assert.equal(config.aiMode, 'document-search');
      assert.equal(config.knowledgeMode, 'vertex-ai-search');
      const response = await ask(url, 'What should I wear on Friday?'),
        result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.mode, 'document-search');
      assert.equal(result.matched, true);
      assert.equal(result.passages.length, 2);
      assert.equal(result.passages[0].title, 'Employee Handbook.pdf');
      assert.equal(result.passages[0].heading, 'Dress Code · page 4');
      assert.match(result.passages[0].preview, /Fridays only/);
      assert.ok(!result.passages[0].preview.includes('desk tidy'));
      assert.match(result.passages[0].text, /formal attire/);
      assert.match(result.answer, /Source: Employee Handbook\.pdf — Dress Code · page 4/);
      assert.equal(result.source, 'Company documents: Employee Handbook.pdf, Working Hours.docx');
      assert.ok(!JSON.stringify(result).includes('gs://'));
      assert.ok(!JSON.stringify(result).includes('test-access-token'));
      assert.ok(!JSON.stringify(result).includes('test-bucket'));
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /^https:\/\/discoveryengine\.googleapis\.com\//);
      assert.equal(calls[0].body.query, 'What should I wear on Friday?');
      // The allowlisted search asks for 10 results and keeps 5 admitted.
      assert.equal(calls[0].body.pageSize, 10);
    },
  );
});

test('document-search mode declines without a match and returns safe search errors', async (t) => {
  t.mock.method(console, 'warn', quiet);
  await withServer(
    {
      env: { AI_MODE: 'document-search', ...searchEnv, DOCS_BUCKET: 'test-bucket' },
      companyDocuments: library(),
      fetchImpl: async () => Response.json({ totalSize: 0 }),
    },
    async (url) => {
      const result = await (await ask(url, 'quantum banana teleporter')).json();
      assert.equal(result.matched, false);
      assert.deepEqual(result.passages, []);
      assert.match(result.answer, /couldn't find/);
    },
  );
  await withServer(
    {
      env: { AI_MODE: 'document-search', ...searchEnv, DOCS_BUCKET: 'test-bucket' },
      companyDocuments: library(),
      fetchImpl: async () => new Response('private provider details', { status: 403 }),
    },
    async (url) => {
      const response = await ask(url),
        body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.code, 'SEARCH_ACCESS_DENIED');
      assert.match(body.error, /Discovery Engine Viewer/);
      assert.equal(body.answer, undefined);
      assert.ok(!JSON.stringify(body).includes('private provider'));
    },
  );
});

test('without a search engine, document-search quotes the labelled sample guide and calls nothing', async () => {
  await withServer(
    {
      env: { AI_MODE: 'document-search' },
      fetchImpl: async () => assert.fail('no Google request'),
    },
    async (url) => {
      const config = await (await fetch(url + '/api/config')).json();
      assert.equal(config.knowledgeMode, 'sample-tasks');
      const result = await (await ask(url, 'How do I finish the onboarding quiz?')).json();
      assert.equal(result.matched, true);
      assert.equal(result.passages[0].title, sampleSourceTitle);
      assert.match(result.answer, /Unapproved sample guidance/);
    },
  );
});

test('Gemini billing errors explain credit depletion without leaking raw provider data or substituting local results', async () => {
  await withServer(
    {
      env: { GOOGLE_CLOUD_PROJECT: 'test-project' },
      getAccessToken: async () => 'test-secret',
      fetchImpl: async () => new Response('private provider details', { status: 402 }),
    },
    async (url) => {
      const response = await ask(url),
        result = await response.json();
      assert.equal(response.status, 402);
      assert.equal(result.code, 'GEMINI_CREDIT_REQUIRED');
      assert.match(result.error, /prepaid credit/);
      assert.equal(result.answer, undefined);
      assert.ok(!JSON.stringify(result).includes('private provider'));
    },
  );
});
