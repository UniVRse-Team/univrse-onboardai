// Issue #115: a search that returns zero results is repeated once with
// relevanceThreshold LOWEST (same query, page size and company filter).
// Fake fetch and synthetic chunks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanySearchError,
  createVertexSearch,
  searchRequestBody,
} from '../../server/vertex-ai-search.mjs';

const config = { project: 'demo-p', location: 'global', engine: 'demo-e' };
const chunk = (text) => ({
  results: [
    {
      id: 'r1',
      chunk: {
        name: 'projects/p/documents/d1/chunks/c1',
        content: text,
        documentMetadata: {
          uri: 'gs://b/companies/rimba/d1/Guide.pdf',
          structData: { companyId: 'rimba' },
        },
      },
    },
  ],
});
function searchWith(responses) {
  const bodies = [];
  const queue = [...responses];
  const search = createVertexSearch({
    config,
    getAccessToken: async () => 'synthetic-token',
    log: () => {},
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const next = queue.shift();
      return typeof next === 'function' ? next() : Response.json(next);
    },
  });
  return { search, bodies };
}

test('searchRequestBody adds relevanceThreshold only for LOWEST', () => {
  assert.equal('relevanceThreshold' in searchRequestBody('q'), false);
  assert.equal('relevanceThreshold' in searchRequestBody('q', { companyId: 'rimba' }), false);
  assert.equal(
    'relevanceThreshold' in searchRequestBody('q', { relevanceThreshold: 'LOW' }),
    false,
  );
  assert.deepEqual(searchRequestBody('q', { companyId: 'rimba', relevanceThreshold: 'LOWEST' }), {
    ...searchRequestBody('q', { companyId: 'rimba' }),
    relevanceThreshold: 'LOWEST',
  });
});

test('zero results: one more request with LOWEST and the same filter; its passages are returned', async () => {
  const { search, bodies } = searchWith([{ totalSize: 0 }, chunk('Hours are 9 to 6.')]);
  const passages = await search('working hours', { companyId: 'rimba', pageSize: 10 });
  assert.equal(passages.length, 1);
  assert.match(passages[0].text, /Hours are 9 to 6/);
  assert.equal(bodies.length, 2);
  assert.equal('relevanceThreshold' in bodies[0], false);
  assert.equal(bodies[1].relevanceThreshold, 'LOWEST');
  for (const body of bodies) {
    assert.equal(body.filter, 'companyId: ANY("rimba")');
    assert.equal(body.query, 'working hours');
    assert.equal(body.pageSize, 10);
  }
  const { relevanceThreshold: _t, ...retry } = bodies[1];
  assert.deepEqual(retry, bodies[0]);
});

test('one or more results: exactly one request', async () => {
  const { search, bodies } = searchWith([chunk('Hours are 9 to 6.')]);
  assert.equal((await search('working hours', { companyId: 'rimba' })).length, 1);
  assert.equal(bodies.length, 1);
});

test('empty on both requests returns no passages', async () => {
  const { search, bodies } = searchWith([{}, { totalSize: 0 }]);
  assert.deepEqual(await search('working hours', { companyId: 'rimba' }), []);
  assert.equal(bodies.length, 2);
});

test('without a company the retry is the same but carries no filter', async () => {
  const { search, bodies } = searchWith([{}, chunk('Hours.')]);
  assert.equal((await search('working hours')).length, 1);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => !('filter' in body)));
});

test('a failing retry maps like a failing first request', async () => {
  const { search, bodies } = searchWith([
    {},
    () => Response.json({ error: { status: 'DENIED', message: 'private' } }, { status: 403 }),
  ]);
  await assert.rejects(search('working hours', { companyId: 'rimba' }), (error) => {
    assert.ok(error instanceof CompanySearchError);
    assert.equal(error.code, 'SEARCH_ACCESS_DENIED');
    assert.equal(error.upstreamStatus, 403);
    return true;
  });
  assert.equal(bodies.length, 2);
  const network = searchWith([
    {},
    () => {
      throw new TypeError('network');
    },
  ]);
  await assert.rejects(network.search('working hours'), { code: 'SEARCH_UNAVAILABLE' });
});

test('a failing first request is not retried', async () => {
  const { search, bodies } = searchWith([() => Response.json({}, { status: 500 })]);
  await assert.rejects(search('working hours'), { code: 'SEARCH_UNAVAILABLE' });
  assert.equal(bodies.length, 1);
});
