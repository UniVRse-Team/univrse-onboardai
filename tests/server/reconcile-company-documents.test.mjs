// npm run docs:reconcile (scripts/reconcile-company-documents.mjs, contract
// C-RECONCILE): the pure plan, the safety stops, the read-only report mode,
// the apply executor, exit codes 0-4 and the JSON lines. A stateful fake of
// Firestore REST, the GCS JSON API and Discovery Engine; synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { companyDocumentSummaryFields } from '../../server/company-documents.mjs';
import {
  DEFAULT_OPTIONS,
  ReadOnlyViolation,
  SUMMARY_COUNTS,
  USAGE,
  UsageError,
  executePlan,
  parseArgs,
  planReconciliation,
  readConfig,
  readOnlyFetch,
  run,
} from '../../scripts/reconcile-company-documents.mjs';

const NOW = Date.parse('2026-10-17T08:00:00.000Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const sha32 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const uuid = (n) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;

const stagingEnv = {
  ONBOARDAI_ENVIRONMENT: 'staging',
  GOOGLE_CLOUD_PROJECT: 'demo-project',
  FIRESTORE_DATABASE_ID: 'demo-db-staging',
  DOCS_BUCKET: 'demo-docs-staging',
  VERTEX_SEARCH_DATA_STORE_ID: 'demo-store-staging',
};
const productionEnv = {
  ONBOARDAI_ENVIRONMENT: 'production',
  GOOGLE_CLOUD_PROJECT: 'demo-project',
  FIRESTORE_DATABASE_ID: '(default)',
  DOCS_BUCKET: 'demo-docs',
  VERTEX_SEARCH_DATA_STORE_ID: 'demo-store',
};
const uriIn = (bucket, name) => `gs://${bucket}/${name}`;
const summaryKeys = [
  'severity',
  'event',
  'environment',
  'mode',
  'exitCode',
  'reason',
  ...SUMMARY_COUNTS,
  'durationMs',
];
const itemKeys = [
  'severity',
  'event',
  'environment',
  'mode',
  'kind',
  'action',
  'result',
  'firestoreId',
  'vertexId',
  'status',
];

// The three Google APIs over in-memory state. route(method, url, call) may
// answer first (a Response, or throw); pageSize keeps every list paginated.
function fakeCloud({ bucket, entries = [], objects = [], docs = [], pageSize = 2, route }) {
  const state = {
    entries: new Map(entries.map((entry) => [entry.id, { ...entry }])),
    objects: new Map(objects.map((object) => [object.name, { ...object }])),
    docs: new Map(docs.map((doc) => [doc.id, { ...doc }])),
    operations: new Map(),
  };
  const calls = [];
  const field = (value) =>
    value === null
      ? { nullValue: null }
      : Number.isInteger(value)
        ? { integerValue: String(value) }
        : { stringValue: String(value) };
  const fieldsOf = (entry, names) =>
    Object.fromEntries(
      names.filter((name) => name in entry).map((name) => [name, field(entry[name])]),
    );
  const page = (list, token) => {
    const start = Number(token || 0);
    const next = start + pageSize < list.length ? String(start + pageSize) : undefined;
    return { items: list.slice(start, start + pageSize), next };
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const target = new URL(url);
    const call = {
      method,
      url: String(url),
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const routed = route ? await route(method, String(url), call, state) : undefined;
    if (routed) return routed;
    const json = (body, status = 200) => Response.json(body, { status });
    if (target.host === 'discoveryengine.googleapis.com') {
      if (method === 'GET' && target.pathname.endsWith('/documents')) {
        const { items, next } = page(
          [...state.docs.values()],
          target.searchParams.get('pageToken'),
        );
        return json({
          documents: items.map((doc) => ({
            name: `${target.pathname.slice(4)}/${doc.id}`,
            id: doc.id,
            content: { uri: doc.uri, mimeType: 'application/pdf' },
            ...(doc.indexTime ? { indexTime: doc.indexTime } : {}),
            ...(doc.companyId ? { structData: { companyId: doc.companyId } } : {}),
          })),
          ...(next ? { nextPageToken: next } : {}),
        });
      }
      if (method === 'DELETE' && /\/documents\/[^/]+$/.test(target.pathname)) {
        const id = decodeURIComponent(target.pathname.split('/').pop());
        if (!state.docs.delete(id)) return json({ error: { code: 404 } }, 404);
        return json({});
      }
      if (method === 'POST' && target.pathname.endsWith('/documents:import')) {
        const name = `projects/demo-project/locations/global/operations/import-${state.operations.size + 1}`;
        let success = 0;
        // The app and the job import inline, with the companyId tag; a
        // gcsSource import would leave the tag out and is not expected.
        for (const document of call.body.inlineSource?.documents ?? []) {
          const objectName = document.content.uri.slice(`gs://${bucket}/`.length);
          if (!state.objects.has(objectName)) continue;
          state.docs.set(document.id, {
            id: document.id,
            uri: document.content.uri,
            indexTime: new Date(NOW).toISOString(),
            companyId: document.structData.companyId,
          });
          success++;
        }
        for (const uri of call.body.gcsSource?.inputUris ?? []) {
          const objectName = uri.slice(`gs://${bucket}/`.length);
          if (!state.objects.has(objectName)) continue;
          state.docs.set(sha32(uri), {
            id: sha32(uri),
            uri,
            indexTime: new Date(NOW).toISOString(),
          });
          success++;
        }
        state.operations.set(name, {
          name,
          done: true,
          metadata: { successCount: String(success) },
        });
        return json({ name, done: false });
      }
      if (method === 'GET' && target.pathname.includes('/operations/'))
        return json(state.operations.get(target.pathname.slice(4)) ?? { done: false });
    }
    if (target.host === 'storage.googleapis.com') {
      const prefix = `/storage/v1/b/${encodeURIComponent(bucket)}/o`;
      if (method === 'GET' && target.pathname === prefix) {
        const { items, next } = page(
          [...state.objects.values()],
          target.searchParams.get('pageToken'),
        );
        return json({
          ...(items.length ? { items } : {}),
          ...(next ? { nextPageToken: next } : {}),
        });
      }
      if (method === 'DELETE' && target.pathname.startsWith(`${prefix}/`)) {
        const name = decodeURIComponent(target.pathname.slice(prefix.length + 1));
        if (!state.objects.delete(name)) return new Response('', { status: 404 });
        return new Response(null, { status: 204 });
      }
    }
    if (target.host === 'firestore.googleapis.com') {
      if (method === 'POST' && target.pathname.endsWith('/documents:runQuery')) {
        const names = call.body.structuredQuery.select.fields.map((f) => f.fieldPath);
        const rows = [...state.entries.values()].map((entry) => ({
          document: {
            name: `projects/demo/databases/demo/documents/companyDocuments/${entry.id}`,
            fields: fieldsOf(entry, names),
          },
          readTime: 'now',
        }));
        return json(rows.length ? rows : [{ readTime: 'now' }]);
      }
      const match = target.pathname.match(/\/documents\/companyDocuments\/([^/]+)$/);
      if (method === 'GET' && match) {
        const entry = state.entries.get(decodeURIComponent(match[1]));
        if (!entry) return json({ error: { code: 404 } }, 404);
        return json({
          name: target.pathname,
          fields: fieldsOf(entry, target.searchParams.getAll('mask.fieldPaths')),
        });
      }
    }
    return json({ error: 'unexpected request in the fake' }, 418);
  };
  return { state, calls, fetchImpl };
}

// 8 HR entries with their objects and documents; `extra` adds more.
function library(bucket, count = 8) {
  const entries = [];
  const objects = [];
  const docs = [];
  for (let i = 1; i <= count; i++) {
    const id = uuid(i);
    const fileName = `0${i} Synthetic Guide ${i}.docx`;
    const name = `${id}/${fileName}`;
    entries.push({
      id,
      fileName,
      title: `Synthetic Guide ${i}`,
      category: 'policies',
      connectedAt: ago(120),
      text: 'Secret legacy synthetic text',
    });
    objects.push({ name, timeCreated: ago(120) });
    docs.push({
      id: sha32(uriIn(bucket, name)),
      uri: uriIn(bucket, name),
      indexTime: ago(119),
      companyId: 'luna-digital',
    });
  }
  return { entries, objects, docs };
}

// Staging on 2026-10-17: 4 root PDFs indexed with no live object, plus one
// <uuid>/ document live in GCS and Vertex with no Firestore entry.
const orphanId = 'deadbeef-02a1-454c-a174-00f04d41e4ec';
function stagingDrift() {
  const bucket = stagingEnv.DOCS_BUCKET;
  const base = library(bucket);
  const orphanName = `${orphanId}/03 Synthetic Conduct Policy.docx`;
  base.objects.push({ name: orphanName, timeCreated: ago(180) });
  base.docs.push({
    id: sha32(uriIn(bucket, orphanName)),
    uri: uriIn(bucket, orphanName),
    indexTime: ago(179),
  });
  for (let k = 1; k <= 4; k++) {
    const uri = uriIn(bucket, `Synthetic - Root Guide ${k}.pdf`);
    base.docs.push({ id: sha32(uri), uri, indexTime: ago(2 * 24 * 60) });
  }
  return { bucket, ...base };
}
// Production: 8 entries plus 4 live onboarding/*.pdf objects that are indexed.
function productionFixture() {
  const bucket = productionEnv.DOCS_BUCKET;
  const base = library(bucket);
  for (let k = 1; k <= 4; k++) {
    const name = `onboarding/Synthetic Onboarding ${k}.pdf`;
    base.objects.push({ name, timeCreated: ago(3 * 24 * 60) });
    base.docs.push({
      id: sha32(uriIn(bucket, name)),
      uri: uriIn(bucket, name),
      indexTime: ago(3 * 24 * 60),
    });
  }
  return { bucket, ...base };
}

const authHeaders = async () => ({ Authorization: 'Bearer synthetic-token' });
async function reconcile(
  cloud,
  { argv = [], env = stagingEnv, now = () => NOW, getAuthHeaders = authHeaders } = {},
) {
  const lines = [];
  const errors = [];
  const exitCode = await run({
    argv,
    env,
    fetchImpl: cloud?.fetchImpl ?? (async () => assert.fail('no request expected')),
    getAuthHeaders,
    now,
    write: (line) => lines.push(line),
    writeError: (text) => errors.push(text),
    sleep: async () => {},
  });
  const parsed = lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { exitCode, lines, errors, items: parsed.slice(0, -1), summary: parsed.at(-1) };
}
const countsOf = (summary) => Object.fromEntries(SUMMARY_COUNTS.map((key) => [key, summary[key]]));
const zeros = Object.fromEntries(SUMMARY_COUNTS.map((key) => [key, 0]));
const plan = (fixture, options = {}, now = NOW) =>
  planReconciliation({
    firestore: fixture.entries.map(({ text: _text, ...entry }) => ({
      status: 'active',
      version: 1,
      retiredAt: null,
      ...entry,
    })),
    gcs: fixture.objects,
    vertex: fixture.docs,
    options: { ...DEFAULT_OPTIONS, bucket: fixture.bucket, ...options },
    now,
  });

test('parseArgs: the defaults, every flag, and usage errors', () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    maxDeletes: 10,
    allowEmptyLibrary: false,
    graceMinutes: 15,
    skipGcs: false,
    showNames: false,
    timeoutMinutes: 10,
    help: false,
  });
  assert.deepEqual(
    parseArgs([
      '--apply',
      '--max-deletes',
      '3',
      '--allow-empty-library',
      '--grace-minutes=0',
      '--skip-gcs',
      '--show-names',
      '--timeout-minutes',
      '20',
    ]),
    {
      apply: true,
      maxDeletes: 3,
      allowEmptyLibrary: true,
      graceMinutes: 0,
      skipGcs: true,
      showNames: true,
      timeoutMinutes: 20,
      help: false,
    },
  );
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  for (const argv of [
    ['--nope'],
    ['--unmanaged-prefix', 'onboarding/'],
    ['--full'],
    ['report'],
    ['--max-deletes'],
    ['--max-deletes', '-1'],
    ['--max-deletes', '1.5'],
    ['--max-deletes', 'ten'],
    ['--grace-minutes', '--apply'],
    ['--timeout-minutes', '0'],
    ['--apply=yes'],
  ])
    assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
});

test('parseArgs: a bad numeric value gets a specific bad-value message, not "Unknown option"', () => {
  for (const [argv, pattern] of [
    [['--max-deletes', 'abc'], /Bad value for --max-deletes: "abc" is not a whole number/],
    [['--max-deletes=abc'], /Bad value for --max-deletes: "abc"/],
    [['--max-deletes', '-1'], /Bad value for --max-deletes: "-1" is not a whole number/],
    [
      ['--max-deletes', '10001'],
      /Bad value for --max-deletes: 10001 is out of range \(0 to 10000\)/,
    ],
    [['--grace-minutes', '1.5'], /Bad value for --grace-minutes: "1.5"/],
    [['--grace-minutes', '10081'], /Bad value for --grace-minutes: 10081 is out of range/],
    [
      ['--timeout-minutes', '0'],
      /Bad value for --timeout-minutes: 0 is out of range \(1 to 1440\)/,
    ],
    [['--timeout-minutes', 'soon'], /Bad value for --timeout-minutes: "soon"/],
    [
      ['--timeout-minutes'],
      /Bad value for --timeout-minutes: it needs a whole number from 1 to 1440/,
    ],
  ])
    assert.throws(
      () => parseArgs(argv),
      (error) =>
        error instanceof UsageError &&
        error.reason === 'usage' &&
        pattern.test(error.message) &&
        !/Unknown option/.test(error.message),
      argv.join(' '),
    );
});

test('exit 2: a bad numeric value prints the bad-value message and exactly one summary line', async () => {
  for (const flag of ['--max-deletes', '--grace-minutes', '--timeout-minutes']) {
    for (const value of ['abc', '-5', '999999999']) {
      const result = await reconcile(null, { argv: [flag, value], env: stagingEnv });
      assert.equal(result.exitCode, 2, `${flag} ${value}`);
      assert.equal(result.lines.length, 1);
      assert.equal(result.summary.reason, 'usage');
      assert.match(result.errors[0], new RegExp(`^Bad value for ${flag}: `));
      assert.doesNotMatch(result.errors[0], /Unknown option/);
    }
  }
});

test('readConfig: required settings and the environment guard (names only in messages)', () => {
  assert.deepEqual(readConfig(stagingEnv), {
    environment: 'staging',
    project: 'demo-project',
    firestoreProject: 'demo-project',
    database: 'demo-db-staging',
    bucket: 'demo-docs-staging',
    dataStore: 'demo-store-staging',
    location: 'global',
  });
  assert.equal(
    readConfig({ ...productionEnv, FIRESTORE_PROJECT_ID: 'demo-other' }).firestoreProject,
    'demo-other',
  );
  assert.equal(readConfig({ ...productionEnv, VERTEX_SEARCH_LOCATION: 'eu' }).location, 'eu');
  const refused = (env, reason) =>
    assert.throws(
      () => readConfig(env),
      (error) => {
        assert.ok(error instanceof UsageError);
        assert.equal(error.reason, reason);
        for (const [name, value] of Object.entries(env))
          if (name !== 'ONBOARDAI_ENVIRONMENT' && value && value.length > 8)
            assert.ok(!error.message.includes(value), error.message);
        return true;
      },
    );
  refused({ ...stagingEnv, ONBOARDAI_ENVIRONMENT: '' }, 'usage');
  refused({ ...stagingEnv, ONBOARDAI_ENVIRONMENT: 'local' }, 'usage');
  for (const name of [
    'GOOGLE_CLOUD_PROJECT',
    'FIRESTORE_DATABASE_ID',
    'DOCS_BUCKET',
    'VERTEX_SEARCH_DATA_STORE_ID',
  ])
    refused({ ...stagingEnv, [name]: '' }, 'usage');
  refused({ ...stagingEnv, DOCS_BUCKET: 'Bad Bucket-staging' }, 'usage');
  // Staging: each of the three ends in -staging. Production: none does.
  for (const name of ['FIRESTORE_DATABASE_ID', 'DOCS_BUCKET', 'VERTEX_SEARCH_DATA_STORE_ID']) {
    refused({ ...stagingEnv, [name]: productionEnv[name] }, 'env_mismatch');
    refused({ ...productionEnv, [name]: stagingEnv[name] }, 'env_mismatch');
  }
  refused({ ...stagingEnv, ONBOARDAI_ENVIRONMENT: 'production' }, 'env_mismatch');
});

test('exit 2: a usage error or an environment mismatch reads nothing and still ends with the summary', async () => {
  for (const [argv, env, reason, mode] of [
    [['--nope'], stagingEnv, 'usage', 'report'],
    [['--apply', '--max-deletes', 'x'], stagingEnv, 'usage', 'report'],
    [['--apply'], { ...stagingEnv, DOCS_BUCKET: 'demo-docs' }, 'env_mismatch', 'apply'],
    [[], { ...productionEnv, ONBOARDAI_ENVIRONMENT: undefined }, 'usage', 'report'],
  ]) {
    const result = await reconcile(null, { argv, env });
    assert.equal(result.exitCode, 2);
    assert.equal(result.lines.length, 1);
    assert.deepEqual(Object.keys(result.summary), summaryKeys);
    assert.deepEqual(
      [
        result.summary.exitCode,
        result.summary.reason,
        result.summary.severity,
        result.summary.mode,
      ],
      [2, reason, 'ERROR', mode],
    );
    assert.deepEqual(countsOf(result.summary), zeros);
    assert.match(result.errors[0], /Usage: npm run docs:reconcile/);
  }
  // --help: the usage text, exit 0, no summary line.
  const help = await reconcile(null, { argv: ['--help'] });
  assert.deepEqual([help.exitCode, help.lines], [0, [USAGE]]);
});

test('the staging drift fixture: 5 Vertex orphans and 1 GCS orphan, exit 0, ids only', async () => {
  const fixture = stagingDrift();
  const pure = plan(fixture);
  assert.equal(pure.stop, null);
  assert.equal(pure.plannedDeletes, 6);
  assert.deepEqual(pure.counts, {
    vertexOrphans: 5,
    vertexDuplicates: 0,
    gcsOrphans: 1,
    missingIndex: 0,
    untaggedIndex: 0,
    missingObject: 0,
    retiredEntries: 0,
    pending: 0,
    unmanaged: 0,
  });

  const cloud = fakeCloud(fixture);
  const result = await reconcile(cloud);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(countsOf(result.summary), {
    ...zeros,
    firestore: 8,
    gcsLive: 9,
    vertex: 13,
    vertexOrphans: 5,
    gcsOrphans: 1,
    unrepaired: 6,
  });
  assert.deepEqual(
    [
      result.summary.severity,
      result.summary.mode,
      result.summary.reason,
      result.summary.environment,
    ],
    ['WARNING', 'report', null, 'staging'],
  );
  const orphans = result.items.filter((item) => item.kind === 'vertex_orphan');
  assert.deepEqual(
    orphans.map((item) => item.firestoreId).sort(),
    [null, null, null, null, orphanId].sort(),
  );
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item), itemKeys);
    assert.deepEqual(
      [item.severity, item.event, item.mode, item.result, item.status],
      ['WARNING', 'onboardai_docs_reconcile_item', 'report', 'planned', null],
    );
    if (item.kind === 'vertex_orphan') assert.match(item.vertexId, /^[0-9a-f]{32}$/);
  }
  assert.deepEqual(
    result.items
      .filter((item) => item.kind === 'gcs_orphan')
      .map((i) => [i.action, i.firestoreId, i.vertexId]),
    [['delete_gcs', orphanId, null]],
  );
  // Nothing but ids: no names, URIs or bucket in any line.
  const output = result.lines.join('\n');
  for (const secret of ['Synthetic', 'gs://', fixture.bucket, '.docx', '.pdf', 'Secret'])
    assert.ok(!output.includes(secret), secret);
});

test('report mode is read only: GET and the Firestore runQuery POST, nothing else', async () => {
  const cloud = fakeCloud(stagingDrift());
  await reconcile(cloud);
  const kinds = new Set(
    cloud.calls.map(
      ({ method, url }) =>
        `${method} ${new URL(url).host}${method === 'POST' ? new URL(url).pathname.replace(/.*\//, '/') : ''}`,
    ),
  );
  assert.deepEqual([...kinds].sort(), [
    'GET discoveryengine.googleapis.com',
    'GET storage.googleapis.com',
    'POST firestore.googleapis.com/documents:runQuery',
  ]);
  // The query is select-only: the summary fields, never the legacy text.
  const query = cloud.calls.find((call) => call.method === 'POST').body;
  assert.deepEqual(query, {
    structuredQuery: {
      from: [{ collectionId: 'companyDocuments' }],
      select: { fields: companyDocumentSummaryFields.map((fieldPath) => ({ fieldPath })) },
    },
  });
  // Every list was followed past its first page.
  assert.ok(cloud.calls.filter((c) => c.url.includes('pageToken=')).length >= 2);
});

test('the read-only transport refuses every write before anything is sent', async () => {
  const sent = [];
  const guarded = readOnlyFetch(async (url, init) => {
    sent.push([init?.method ?? 'GET', url]);
    return new Response('{}');
  });
  const documents =
    'https://discoveryengine.googleapis.com/v1/projects/p/locations/global/collections/default_collection/dataStores/d-staging/branches/default_branch/documents';
  const firestore = 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents';
  for (const [method, url] of [
    ['DELETE', `${documents}/abc`],
    ['POST', `${documents}:import`],
    ['PATCH', `${documents}/abc`],
    ['PUT', `${documents}/abc`],
    ['DELETE', 'https://storage.googleapis.com/storage/v1/b/b/o/x'],
    ['POST', 'https://storage.googleapis.com/upload/storage/v1/b/b/o?name=x'],
    ['POST', `${firestore}:commit`],
    ['POST', `${firestore}:runQuery?x=1`],
    ['POST', `${firestore}/companyDocuments`],
    ['GET', 'https://example.com/anything'],
    ['HEAD', `${documents}`],
  ])
    await assert.rejects(guarded(url, { method }), ReadOnlyViolation, `${method} ${url}`);
  assert.deepEqual(sent, []);
  await guarded(`${documents}?pageSize=1000`);
  await guarded(`${firestore}:runQuery`, { method: 'POST', body: '{}' });
  await guarded('https://storage.googleapis.com/storage/v1/b/b/o');
  assert.equal(sent.length, 3);

  // The executor over the report transport cannot delete: it throws first.
  const plain = [];
  const http = (method, url) => readOnlyFetch(async () => plain.push(url))(url, { method });
  const items = [
    {
      kind: 'vertex_orphan',
      action: 'delete_vertex',
      firestoreId: null,
      vertexId: 'abc',
      result: null,
    },
    { kind: 'gcs_orphan', action: 'delete_gcs', firestoreId: null, name: 'x', result: null },
  ];
  await executePlan({
    items,
    http,
    config: { project: 'p', location: 'global', dataStore: 'd', bucket: 'b' },
    options: DEFAULT_OPTIONS,
    deadlineAt: Infinity,
  });
  assert.deepEqual(
    items.map((item) => item.result),
    ['failed', 'failed'],
  );
  assert.deepEqual(plain, []);
});

test('the production fixture: 4 unmanaged onboarding/ files, 0 planned actions, exit 0, INFO', async () => {
  const fixture = productionFixture();
  const pure = plan(fixture);
  assert.equal(pure.plannedDeletes, 0);
  assert.equal(pure.items.length, 4);
  assert.ok(pure.items.every((item) => item.kind === 'unmanaged' && item.action === 'none'));

  const cloud = fakeCloud(fixture);
  const result = await reconcile(cloud, { env: productionEnv });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(countsOf(result.summary), {
    ...zeros,
    firestore: 8,
    gcsLive: 12,
    vertex: 12,
    unmanaged: 4,
  });
  assert.deepEqual(
    [result.summary.severity, result.summary.environment, result.summary.reason],
    ['INFO', 'production', null],
  );
  assert.deepEqual(
    result.items.map((item) => [
      item.kind,
      item.action,
      item.result,
      item.severity,
      item.firestoreId,
    ]),
    Array(4).fill(['unmanaged', 'none', 'reported', 'INFO', null]),
  );
  assert.ok(result.items.every((item) => /^[0-9a-f]{32}$/.test(item.vertexId)));
  // Even in apply mode nothing is touched and the exit code stays 0.
  const applied = await reconcile(cloud, { env: productionEnv, argv: ['--apply'] });
  assert.equal(applied.exitCode, 0);
  assert.ok(cloud.calls.every((call) => call.method === 'GET' || call.url.endsWith(':runQuery')));
  assert.equal(cloud.state.objects.size, 12);
  assert.equal(cloud.state.docs.size, 12);
  // Unmanaged never counts toward the empty-library stop either.
  const empty = productionFixture();
  empty.entries = [];
  empty.objects = empty.objects.filter((o) => o.name.startsWith('onboarding/'));
  empty.docs = empty.docs.filter((d) => d.uri.includes('/onboarding/'));
  assert.deepEqual([plan(empty).stop, plan(empty).counts.unmanaged], [null, 4]);
});

test('grace and pending: young entries, objects and documents, and documents without indexTime', () => {
  const bucket = stagingEnv.DOCS_BUCKET;
  const young = uuid(21);
  const unindexed = uuid(22);
  const fixture = {
    bucket,
    entries: [
      // Uploaded 5 minutes ago: its object is not there yet.
      { id: young, fileName: 'New.pdf', connectedAt: ago(5) },
      { id: unindexed, fileName: 'Indexing.pdf', connectedAt: ago(60) },
    ],
    objects: [
      { name: `${unindexed}/Indexing.pdf`, timeCreated: ago(60) },
      // An orphan object 3 minutes old.
      { name: `${uuid(23)}/Fresh.pdf`, timeCreated: ago(3) },
    ],
    docs: [
      {
        id: sha32(uriIn(bucket, `${unindexed}/Indexing.pdf`)),
        uri: uriIn(bucket, `${unindexed}/Indexing.pdf`),
      },
      // An orphan document indexed 2 minutes ago, and one never indexed.
      { id: 'd-young', uri: uriIn(bucket, 'Root Young.pdf'), indexTime: ago(2) },
      { id: 'd-none', uri: uriIn(bucket, 'Root None.pdf') },
    ],
  };
  const result = plan(fixture);
  assert.deepEqual(
    result.items.map((item) => [item.kind, item.firestoreId ?? item.vertexId]).sort(),
    [
      ['pending', unindexed],
      ['pending', 'd-young'],
      ['pending', 'd-none'],
      ['pending', uuid(23)],
      ['pending', young],
    ].sort(),
  );
  assert.equal(result.plannedDeletes, 0);
  // With no grace the same orphans are actionable (the unindexed ones stay pending).
  const noGrace = plan(fixture, { graceMinutes: 0 });
  assert.deepEqual(
    [
      noGrace.counts.vertexOrphans,
      noGrace.counts.gcsOrphans,
      noGrace.counts.missingObject,
      noGrace.counts.pending,
    ],
    [1, 1, 1, 2],
  );
});

test('duplicates, missing index, missing object, retired entries and entries without a file name', () => {
  const bucket = stagingEnv.DOCS_BUCKET;
  const [a, b, c, d, e, f] = [31, 32, 33, 34, 35, 36].map(uuid);
  const uriA = uriIn(bucket, `${a}/A.pdf`);
  const uriB = uriIn(bucket, `${b}/B.pdf`);
  const fixture = {
    bucket,
    entries: [
      { id: a, fileName: 'A.pdf', connectedAt: ago(600) },
      { id: b, fileName: 'B.pdf', connectedAt: ago(600) },
      { id: c, fileName: 'C.pdf', connectedAt: ago(600) },
      { id: d, fileName: 'D.pdf', connectedAt: ago(600) },
      // Replaced an hour ago and never cleaned up: retired, with its object and document.
      { id: e, fileName: 'E.pdf', connectedAt: ago(6000), status: 'retired', retiredAt: ago(60) },
      // A Google Docs entry from before #35: counted, no item.
      { id: f, fileName: '', connectedAt: ago(9000) },
    ],
    objects: ['A.pdf', 'B.pdf', 'C.pdf', 'E.pdf'].map((name, i) => ({
      name: `${[a, b, c, e][i]}/${name}`,
      timeCreated: ago(600),
    })),
    docs: [
      // A: the canonical document and a stray second one for the same URI.
      { id: sha32(uriA), uri: uriA, indexTime: ago(500) },
      { id: 'stray-a', uri: uriA, indexTime: ago(500) },
      // B: two non-canonical documents; the lowest ID is kept.
      { id: 'b-1', uri: uriB, indexTime: ago(500) },
      { id: 'b-2', uri: uriB, indexTime: ago(500) },
      { id: 'e-doc', uri: uriIn(bucket, `${e}/E.pdf`), indexTime: ago(5000) },
    ],
  };
  const result = plan(fixture);
  const by = (kind) => result.items.filter((item) => item.kind === kind);
  assert.deepEqual(
    by('vertex_duplicate').map((item) => [item.firestoreId, item.vertexId]),
    [
      [a, 'stray-a'],
      [b, 'b-2'],
    ],
  );
  assert.deepEqual(
    by('missing_index').map((item) => [item.firestoreId, item.action, item.uri]),
    [[c, 'reimport', uriIn(bucket, `${c}/C.pdf`)]],
  );
  assert.deepEqual(
    by('missing_object').map((item) => [item.firestoreId, item.action]),
    [[d, 'none']],
  );
  assert.deepEqual(
    by('retired_entry').map((item) => item.firestoreId),
    [e],
  );
  assert.deepEqual(
    [by('vertex_orphan').map((i) => i.vertexId), by('gcs_orphan').map((i) => i.firestoreId)],
    [['e-doc'], [e]],
  );
  assert.ok(!result.items.some((item) => item.firestoreId === f));
  // Retired a minute ago (a replace in flight): everything about it is pending.
  fixture.entries[4].retiredAt = ago(1);
  const inFlight = plan(fixture);
  assert.deepEqual(
    inFlight.items
      .filter((item) => item.firestoreId === e || item.vertexId === 'e-doc')
      .map((i) => i.kind),
    ['pending', 'pending', 'pending'],
  );
});

test('safety stops: the empty library and --max-deletes, in both modes; --skip-gcs deletes no object', async () => {
  const bucket = stagingEnv.DOCS_BUCKET;
  const orphans = (count) =>
    Array.from({ length: count }, (_, i) => {
      const uri = uriIn(bucket, `Root ${i}.pdf`);
      return { id: sha32(uri), uri, indexTime: ago(600) };
    });
  // 0 entries and >= 1 planned delete: a wrong database or an empty read.
  const empty = fakeCloud({ bucket, docs: orphans(1) });
  const report = await reconcile(empty);
  assert.deepEqual(
    [report.exitCode, report.summary.reason, report.summary.severity, report.items[0].result],
    [3, 'empty_library', 'ERROR', 'planned'],
  );
  const apply = await reconcile(empty, { argv: ['--apply'] });
  assert.deepEqual(
    [apply.exitCode, apply.items[0].result, apply.items[0].severity],
    [3, 'skipped', 'WARNING'],
  );
  assert.equal(empty.state.docs.size, 1);
  const allowed = await reconcile(empty, { argv: ['--allow-empty-library'] });
  assert.equal(allowed.exitCode, 0);

  // More planned deletes than --max-deletes (default 10).
  const lib = library(bucket, 1);
  const eleven = fakeCloud({
    bucket,
    entries: lib.entries,
    objects: lib.objects,
    docs: [...lib.docs, ...orphans(11)],
  });
  const over = await reconcile(eleven, { argv: ['--apply'] });
  assert.deepEqual(
    [over.exitCode, over.summary.reason, over.summary.deletedVertex],
    [3, 'max_deletes', 0],
  );
  assert.ok(over.items.every((item) => item.result === 'skipped'));
  assert.ok(eleven.calls.every((call) => call.method === 'GET' || call.url.endsWith(':runQuery')));
  assert.equal((await reconcile(eleven, { argv: ['--max-deletes', '11'] })).exitCode, 0);
  assert.equal(plan({ bucket, ...lib, docs: [...lib.docs, ...orphans(10)] }).stop, null);
  assert.equal(
    plan({ bucket, ...lib, docs: [...lib.docs, ...orphans(1)] }, { maxDeletes: 0 }).stop,
    'max_deletes',
  );

  // --skip-gcs: GCS orphans are reported "skipped" and do not count toward the stop.
  const gcsOnly = fakeCloud({
    bucket,
    ...lib,
    objects: [...lib.objects, { name: `${uuid(99)}/Gone.pdf`, timeCreated: ago(600) }],
  });
  const skipped = await reconcile(gcsOnly, {
    argv: ['--apply', '--skip-gcs', '--max-deletes', '0'],
  });
  assert.equal(skipped.exitCode, 0);
  assert.deepEqual(
    skipped.items.map((item) => [item.kind, item.action, item.result]),
    [['gcs_orphan', 'delete_gcs', 'skipped']],
  );
  assert.deepEqual([skipped.summary.gcsOrphans, skipped.summary.unrepaired], [1, 1]);
  assert.equal(gcsOnly.state.objects.size, 2);
});

test('apply on the staging fixture deletes the 6 orphans; a second run plans nothing (idempotent)', async () => {
  const fixture = stagingDrift();
  const cloud = fakeCloud(fixture);
  const applied = await reconcile(cloud, { argv: ['--apply'] });
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.summary));
  assert.deepEqual(countsOf(applied.summary), {
    ...zeros,
    firestore: 8,
    gcsLive: 9,
    vertex: 13,
    vertexOrphans: 5,
    gcsOrphans: 1,
    deletedVertex: 5,
    deletedGcs: 1,
  });
  assert.equal(applied.summary.severity, 'INFO');
  assert.ok(applied.items.every((item) => item.result === 'done' && item.severity === 'INFO'));
  const writes = cloud.calls.filter(
    (call) => call.method !== 'GET' && !call.url.endsWith(':runQuery'),
  );
  const expectedDeletes = fixture.docs
    .filter(
      (doc) =>
        !fixture.objects.some((o) => doc.uri.endsWith(`/${o.name}`)) || doc.uri.includes(orphanId),
    )
    .map((doc) => `DELETE ${doc.id}`);
  assert.deepEqual(
    writes.map((call) => `${call.method} ${call.url.split('/').pop()}`).sort(),
    [
      ...expectedDeletes,
      `DELETE ${encodeURIComponent(`${orphanId}/03 Synthetic Conduct Policy.docx`)}`,
    ].sort(),
  );
  // The <uuid>/ orphans were re-checked in Firestore first (both answered 404).
  assert.equal(
    cloud.calls.filter(
      (call) => call.method === 'GET' && call.url.includes(`/companyDocuments/${orphanId}?`),
    ).length,
    2,
  );
  assert.deepEqual([cloud.state.docs.size, cloud.state.objects.size], [8, 8]);

  for (const argv of [[], ['--apply']]) {
    const again = await reconcile(cloud, { argv });
    assert.equal(again.exitCode, 0);
    assert.deepEqual(again.items, []);
    assert.deepEqual(countsOf(again.summary), { ...zeros, firestore: 8, gcsLive: 8, vertex: 8 });
    assert.equal(again.summary.severity, 'INFO');
  }
});

test('apply re-imports missing documents with explicit URIs, at most 100 per INCREMENTAL import', async () => {
  const bucket = stagingEnv.DOCS_BUCKET;
  const lib = library(bucket, 101);
  const cloud = fakeCloud({
    bucket,
    entries: lib.entries,
    objects: lib.objects,
    docs: [],
    pageSize: 50,
  });
  const result = await reconcile(cloud, { argv: ['--apply'] });
  assert.equal(result.exitCode, 0, JSON.stringify(result.summary));
  assert.deepEqual(
    [result.summary.missingIndex, result.summary.reimported, result.summary.unrepaired],
    [101, 101, 0],
  );
  const imports = cloud.calls.filter((call) => call.url.endsWith(':import'));
  assert.deepEqual(
    imports.map((call) => call.body.inlineSource.documents.length),
    [100, 1],
  );
  for (const { body } of imports) {
    assert.deepEqual(Object.keys(body).sort(), ['inlineSource', 'reconciliationMode']);
    assert.equal(body.reconciliationMode, 'INCREMENTAL');
    for (const document of body.inlineSource.documents) {
      const { uri } = document.content;
      assert.ok(uri.startsWith(`gs://${bucket}/`) && !uri.includes('*') && !uri.endsWith('/'));
      assert.ok(lib.objects.some((o) => uri === uriIn(bucket, o.name)));
      // The entry id is the document id and the tag is always sent.
      assert.ok(lib.entries.some((entry) => entry.id === document.id));
      assert.deepEqual(document.structData, { companyId: 'luna-digital' });
    }
  }
  // The operations were polled to completion.
  assert.equal(cloud.calls.filter((call) => call.url.includes('/operations/import-')).length, 2);
  // The deletes cap does not apply to re-imports, and a second run finds nothing.
  const again = await reconcile(cloud, { argv: ['--apply'] });
  assert.deepEqual([again.exitCode, again.items.length, again.summary.vertex], [0, 0, 101]);
});

test('apply: a failed action is exit 1 and an ERROR line; a 404 is done; a re-check can skip', async () => {
  const fixture = stagingDrift();
  const [firstRoot, secondRoot] = fixture.docs.filter((doc) => doc.uri.includes('Root Guide'));
  const cloud = fakeCloud({
    ...fixture,
    route: (method, url, call, state) => {
      if (method === 'DELETE' && url.endsWith(`/documents/${firstRoot.id}`))
        return new Response('{}', { status: 500 });
      if (method === 'DELETE' && url.endsWith(`/documents/${secondRoot.id}`)) {
        state.docs.delete(secondRoot.id);
        return new Response('{}', { status: 404 });
      }
      // Firestore now has an active entry that expects the <uuid>/ orphan.
      if (method === 'GET' && url.includes(`/companyDocuments/${orphanId}?`))
        return Response.json({
          name: 'x',
          fields: {
            fileName: { stringValue: '03 Synthetic Conduct Policy.docx' },
            status: { stringValue: 'active' },
          },
        });
    },
  });
  const result = await reconcile(cloud, { argv: ['--apply'] });
  assert.deepEqual(
    [result.exitCode, result.summary.reason, result.summary.severity],
    [1, 'actions_failed', 'ERROR'],
  );
  const byVertex = (id) => result.items.find((item) => item.vertexId === id);
  assert.deepEqual(
    [byVertex(firstRoot.id).result, byVertex(firstRoot.id).status, byVertex(firstRoot.id).severity],
    ['failed', 500, 'ERROR'],
  );
  assert.equal(byVertex(secondRoot.id).result, 'done');
  const skipped = result.items.filter((item) => item.firestoreId === orphanId);
  assert.deepEqual(skipped.map((item) => [item.kind, item.result, item.severity]).sort(), [
    ['gcs_orphan', 'skipped', 'WARNING'],
    ['vertex_orphan', 'skipped', 'WARNING'],
  ]);
  assert.deepEqual(
    [
      result.summary.deletedVertex,
      result.summary.deletedGcs,
      result.summary.failed,
      result.summary.unrepaired,
    ],
    [3, 0, 1, 3],
  );
});

test('exit 4: a source that cannot be read changes nothing; the summary has zeros for what was not read', async () => {
  for (const [source, status, read] of [
    ['discoveryengine', 403, {}],
    ['storage', 404, { vertex: 13 }],
    ['firestore', 401, { vertex: 13, gcsLive: 9 }],
    ['storage', 'network', { vertex: 13 }],
  ]) {
    const cloud = fakeCloud({
      ...stagingDrift(),
      route: (method, url) => {
        if (new URL(url).host === `${source}.googleapis.com`) {
          if (status === 'network') throw new TypeError('fetch failed');
          return new Response('{}', { status });
        }
      },
    });
    const result = await reconcile(cloud, { argv: ['--apply'] });
    assert.deepEqual([result.exitCode, result.summary.reason], [4, 'source_unreadable'], source);
    assert.equal(result.lines.length, 1);
    assert.deepEqual(countsOf(result.summary), { ...zeros, ...read }, source);
    assert.equal(result.summary.mode, 'apply');
    assert.ok(cloud.calls.every((call) => call.method === 'GET' || call.url.endsWith(':runQuery')));
  }
});

test('the overall deadline: an unfinished apply is exit 1 "timeout"; a read past it is exit 4 "timeout"', async () => {
  let clock = NOW;
  const cloud = fakeCloud({
    ...stagingDrift(),
    route: (method, url) => {
      // Reading Firestore takes 11 minutes (the default deadline is 10).
      if (url.endsWith(':runQuery')) clock = NOW + 11 * 60_000;
    },
  });
  const late = await reconcile(cloud, { argv: ['--apply'], now: () => clock });
  assert.deepEqual([late.exitCode, late.summary.reason, late.summary.failed], [1, 'timeout', 6]);
  assert.ok(late.items.every((item) => item.result === 'failed'));
  assert.equal(late.summary.durationMs, 11 * 60_000);
  assert.ok(cloud.calls.every((call) => call.method === 'GET' || call.url.endsWith(':runQuery')));

  clock = NOW;
  const slowRead = fakeCloud({
    ...stagingDrift(),
    route: (method, url) => {
      if (new URL(url).host === 'storage.googleapis.com') {
        clock = NOW + 11 * 60_000;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }
    },
  });
  const readFailed = await reconcile(slowRead, { now: () => clock });
  assert.deepEqual([readFailed.exitCode, readFailed.summary.reason], [4, 'timeout']);
});

test('--show-names adds the object name to item lines only; credentials headers are passed through', async () => {
  const cloud = fakeCloud(stagingDrift());
  const result = await reconcile(cloud, {
    argv: ['--show-names'],
    getAuthHeaders: async () => ({
      Authorization: 'Bearer synthetic-token',
      'x-goog-user-project': 'demo-quota',
    }),
  });
  assert.equal(result.exitCode, 0);
  for (const item of result.items) assert.deepEqual(Object.keys(item), [...itemKeys, 'name']);
  assert.deepEqual(
    result.items.filter((item) => item.kind === 'gcs_orphan').map((item) => item.name),
    [`${orphanId}/03 Synthetic Conduct Policy.docx`],
  );
  assert.ok(result.items.some((item) => item.name === 'Synthetic - Root Guide 1.pdf'));
  assert.deepEqual(Object.keys(result.summary), summaryKeys);
  assert.ok(!JSON.stringify(result.summary).includes('Synthetic'));
  for (const call of cloud.calls) {
    assert.equal(call.headers.get('authorization'), 'Bearer synthetic-token');
    assert.equal(call.headers.get('x-goog-user-project'), 'demo-quota');
  }
  // Without a quota project from the credentials, Discovery Engine calls name the project.
  const plain = fakeCloud(stagingDrift());
  await reconcile(plain);
  for (const call of plain.calls)
    assert.equal(
      call.headers.get('x-goog-user-project'),
      call.url.includes('discoveryengine') ? 'demo-project' : null,
    );
});

test('multi-tenant company library: tenant documents reconcile with zero drift and handle tenant drift/apply', async () => {
  const bucket = productionEnv.DOCS_BUCKET;
  const companyId = 'demo-seri-bayu';
  const docId1 = uuid(10);
  const docId2 = uuid(20);
  const orphanDocId = uuid(30);

  const file1 = '01 Handbook.docx';
  const file2 = '02 Guidelines.pdf';
  const orphanFile = '03 Old.docx';

  const name1 = `companies/${companyId}/${docId1}/${file1}`;
  const name2 = `companies/${companyId}/${docId2}/${file2}`;
  const orphanName = `companies/${companyId}/${orphanDocId}/${orphanFile}`;

  const uri1 = uriIn(bucket, name1);
  const uri2 = uriIn(bucket, name2);
  const orphanUri = uriIn(bucket, orphanName);

  // 1. Clean multi-tenant library with 2 tenant entries: 0 drift
  const cleanCloud = fakeCloud({
    bucket,
    entries: [
      {
        id: docId1,
        fileName: file1,
        title: 'Handbook',
        category: 'policies',
        companyId,
        connectedAt: ago(60),
      },
      {
        id: docId2,
        fileName: file2,
        title: 'Guidelines',
        category: 'policies',
        companyId,
        connectedAt: ago(60),
      },
    ],
    objects: [
      { name: name1, timeCreated: ago(60) },
      { name: name2, timeCreated: ago(60) },
    ],
    docs: [
      { id: sha32(uri1), uri: uri1, indexTime: ago(59), companyId },
      { id: sha32(uri2), uri: uri2, indexTime: ago(59), companyId },
    ],
  });

  const cleanResult = await reconcile(cleanCloud, { env: productionEnv });
  assert.equal(cleanResult.exitCode, 0);
  assert.deepEqual(cleanResult.items, []);
  assert.deepEqual(countsOf(cleanResult.summary), {
    ...zeros,
    firestore: 2,
    gcsLive: 2,
    vertex: 2,
  });

  // 2. Multi-tenant drift:
  // - orphanDocId exists in GCS & Vertex, but not in Firestore -> gcs_orphan & vertex_orphan
  // - docId1 has missing Vertex doc -> missing_index
  const driftCloud = fakeCloud({
    bucket,
    entries: [
      {
        id: docId1,
        fileName: file1,
        title: 'Handbook',
        category: 'policies',
        companyId,
        connectedAt: ago(60),
      },
      {
        id: docId2,
        fileName: file2,
        title: 'Guidelines',
        category: 'policies',
        companyId,
        connectedAt: ago(60),
      },
    ],
    objects: [
      { name: name1, timeCreated: ago(60) },
      { name: name2, timeCreated: ago(60) },
      { name: orphanName, timeCreated: ago(60) },
    ],
    docs: [
      { id: sha32(uri2), uri: uri2, indexTime: ago(59), companyId },
      { id: sha32(orphanUri), uri: orphanUri, indexTime: ago(59) },
    ],
  });

  const report = await reconcile(driftCloud, { env: productionEnv });
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.gcsOrphans, 1);
  assert.equal(report.summary.vertexOrphans, 1);
  assert.equal(report.summary.missingIndex, 1);
  assert.equal(report.summary.unrepaired, 3);

  // 3. Apply resolves the drift
  const applied = await reconcile(driftCloud, { argv: ['--apply'], env: productionEnv });
  assert.equal(applied.exitCode, 0);
  assert.deepEqual(
    [
      applied.summary.deletedGcs,
      applied.summary.deletedVertex,
      applied.summary.reimported,
      applied.summary.unrepaired,
    ],
    [1, 1, 1, 0],
  );

  // Verify re-check in stillOrphan requested companyId mask
  const rechecks = driftCloud.calls.filter(
    (c) => c.method === 'GET' && c.url.includes(`/companyDocuments/${orphanDocId}?`),
  );
  assert.ok(rechecks.length > 0);
  assert.ok(rechecks[0].url.includes('mask.fieldPaths=companyId'));
});

// --- #115: the companyId tag on the Vertex documents -------------------------------

function taggedFixture(bucket, companyDocs) {
  const entries = [];
  const objects = [];
  const docs = [];
  companyDocs.forEach(({ n, companyId, tag, indexTime = ago(119), entryCompany }, i) => {
    const id = uuid(40 + n);
    const fileName = `0${i} Guide.docx`;
    const name =
      companyId && companyId !== 'luna-digital'
        ? `companies/${companyId}/${id}/${fileName}`
        : `${id}/${fileName}`;
    entries.push({
      id,
      fileName,
      title: 'Guide',
      category: 'policies',
      connectedAt: ago(120),
      ...(entryCompany === null ? {} : { companyId: entryCompany ?? companyId }),
    });
    objects.push({ name, timeCreated: ago(120) });
    docs.push({
      id: sha32(uriIn(bucket, name)),
      uri: uriIn(bucket, name),
      indexTime,
      ...(tag ? { companyId: tag } : {}),
    });
  });
  return { bucket, entries, objects, docs };
}

test('untagged_index: a missing or wrong companyId tag plans a retag; a correct tag plans nothing', () => {
  const fixture = taggedFixture(stagingEnv.DOCS_BUCKET, [
    { n: 1, companyId: 'luna-digital', tag: 'luna-digital' },
    { n: 2, companyId: 'luna-digital', tag: null },
    { n: 3, companyId: 'seri-bayu-digital', tag: 'luna-digital' },
    { n: 4, companyId: 'seri-bayu-digital', tag: 'seri-bayu-digital' },
    // an entry without a company reads as the default company
    { n: 5, companyId: 'luna-digital', tag: 'luna-digital', entryCompany: null },
    { n: 6, companyId: 'luna-digital', tag: null, entryCompany: null },
    // no indexTime yet: pending, not untagged
    { n: 7, companyId: 'luna-digital', tag: null, indexTime: null },
  ]);
  const result = plan(fixture);
  const untagged = result.items.filter((item) => item.kind === 'untagged_index');
  assert.deepEqual(
    untagged.map((item) => [item.action, item.firestoreId, item.companyId]),
    [
      ['retag', uuid(42), 'luna-digital'],
      ['retag', uuid(43), 'seri-bayu-digital'],
      ['retag', uuid(46), 'luna-digital'],
    ],
  );
  assert.equal(untagged[0].vertexId, fixture.docs[1].id);
  assert.equal(result.counts.untaggedIndex, 3);
  assert.equal(result.counts.pending, 1);
  // A retag is not a delete.
  assert.equal(result.plannedDeletes, 0);
  assert.equal(result.stop, null);
  assert.equal(plan(fixture, { maxDeletes: 0 }).stop, null);
});

test('untagged_index: a duplicate is still a duplicate; only the kept document is tag-checked', () => {
  const bucket = stagingEnv.DOCS_BUCKET;
  const id = uuid(60);
  const uri = uriIn(bucket, `${id}/A.pdf`);
  const fixture = {
    bucket,
    entries: [{ id, fileName: 'A.pdf', title: 'A', category: 'p', connectedAt: ago(300) }],
    objects: [{ name: `${id}/A.pdf`, timeCreated: ago(300) }],
    docs: [
      { id: sha32(uri), uri, indexTime: ago(200), companyId: 'luna-digital' },
      { id: 'zz-extra', uri, indexTime: ago(200) },
    ],
  };
  const result = plan(fixture);
  assert.deepEqual(
    result.items.map((item) => [item.kind, item.vertexId]),
    [['vertex_duplicate', 'zz-extra']],
  );
  assert.equal(result.plannedDeletes, 1);
});

test('apply retags in place with an inline import and tags missing_index imports; the exact bodies', async () => {
  const bucket = stagingEnv.DOCS_BUCKET;
  const fixture = taggedFixture(bucket, [
    { n: 1, companyId: 'luna-digital', tag: null },
    { n: 2, companyId: 'seri-bayu-digital', tag: 'luna-digital' },
    { n: 3, companyId: 'seri-bayu-digital', tag: 'seri-bayu-digital' },
    { n: 4, companyId: 'seri-bayu-digital', tag: null },
  ]);
  // entry 4 has no Vertex document at all (missing_index)
  const missingUri = fixture.docs[3].uri;
  fixture.docs.pop();
  const cloud = fakeCloud({ ...fixture, pageSize: 50 });
  const result = await reconcile(cloud, { argv: ['--apply'] });
  assert.equal(result.exitCode, 0, JSON.stringify(result.summary));
  assert.deepEqual(
    [
      result.summary.untaggedIndex,
      result.summary.retagged,
      result.summary.missingIndex,
      result.summary.reimported,
      result.summary.unrepaired,
    ],
    [2, 2, 1, 1, 0],
  );
  const bodies = cloud.calls.filter((call) => call.url.endsWith(':import')).map((c) => c.body);
  const doc = (id, uri, companyId) => ({
    id,
    structData: { companyId },
    content: {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      uri,
    },
  });
  assert.deepEqual(bodies, [
    {
      inlineSource: {
        documents: [
          doc(fixture.docs[0].id, fixture.docs[0].uri, 'luna-digital'),
          doc(fixture.docs[1].id, fixture.docs[1].uri, 'seri-bayu-digital'),
          doc(uuid(44), missingUri, 'seri-bayu-digital'),
        ],
      },
      reconciliationMode: 'INCREMENTAL',
    },
  ]);
  // No import ever uses an untagged gcsSource, and a second run plans nothing.
  assert.ok(bodies.every((body) => !('gcsSource' in body)));
  const again = await reconcile(cloud, { argv: ['--apply'] });
  assert.deepEqual([again.exitCode, again.items.length], [0, 0]);
});

test('report mode lists the retag as planned and refuses to write', async () => {
  const fixture = taggedFixture(stagingEnv.DOCS_BUCKET, [
    { n: 1, companyId: 'luna-digital', tag: null },
  ]);
  const cloud = fakeCloud({ ...fixture });
  const result = await reconcile(cloud);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.items.map((item) => [item.kind, item.action, item.result]),
    [['untagged_index', 'retag', 'planned']],
  );
  assert.equal(result.summary.untaggedIndex, 1);
  assert.equal(result.summary.unrepaired, 1);
  assert.deepEqual(
    cloud.calls.filter((call) => call.method !== 'GET' && !call.url.endsWith(':runQuery')),
    [],
  );
  const refused = readOnlyFetch(async () => assert.fail('must not send'));
  await assert.rejects(
    refused('https://discoveryengine.googleapis.com/v1/x/documents:import', { method: 'POST' }),
    ReadOnlyViolation,
  );
});
