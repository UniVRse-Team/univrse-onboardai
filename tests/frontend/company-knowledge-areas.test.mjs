import test from 'node:test';
import assert from 'node:assert/strict';
import {
  additionalArea,
  areaIdFor,
  areaListView,
  areaTitle,
  areaTopics,
  areasConnectedText,
  documentLabel,
  moveOptions,
} from '../../src/access/onboarding-document-status.mjs';
import {
  errorNeedsRefresh,
  knowledgeErrorMessage,
  rateLimitMessage,
} from '../../src/access/company-knowledge-upload.mjs';

// The shape GET /api/hr/company-knowledge returns (issue #68).
const topics = [
  { id: 'alignment', title: 'Company Purpose & Alignment', description: 'a', icon: 'planet' },
  { id: 'documentation', title: 'Documentation', description: 'b', icon: 'checklist' },
  { id: 'team-support', title: 'People & Workplace Support', description: 'c', icon: 'people' },
  { id: 'role-tools', title: 'Role, Tools & AI Readiness', description: 'd', icon: 'laptop' },
  { id: 'policies', title: 'Policies & Safe Practices', description: 'e', icon: 'shield' },
];
const doc = (id, category, extra = {}) => ({
  id,
  title: 'Doc ' + id,
  fileName: id + '.pdf',
  category,
  characters: 100,
  bytes: 200,
  created: '2026-10-01T00:00:00.000Z',
  ...extra,
});
const snapshot = (documents, more = {}) => ({
  topics,
  documents,
  limits: { files: 40, bytes: 5242880, characters: 250000, totalCharacters: 1500000 },
  ...more,
});

test('five areas in the API order, each listing all of its documents oldest first', () => {
  const view = areaListView(
    snapshot([
      doc('1', 'policies'),
      doc('2', 'documentation'),
      doc('3', 'policies'),
      doc('4', 'additional'),
    ]),
  );
  assert.deepEqual(
    view.areas.map((area) => area.id),
    ['alignment', 'documentation', 'team-support', 'role-tools', 'policies'],
  );
  assert.deepEqual(
    view.areas.map((area) => area.number),
    [1, 2, 3, 4, 5],
  );
  const policies = view.areas.find((area) => area.id === 'policies');
  assert.deepEqual(
    policies.documents.map((d) => d.id),
    ['1', '3'],
  );
  assert.equal(policies.empty, false);
  assert.equal(policies.icon, 'shield');
  assert.equal(view.areas[0].empty, true);
  assert.deepEqual(view.areas[0].documents, []);
  assert.equal(view.additional.id, 'additional');
  assert.equal(view.additional.title, 'Other useful guidance');
  assert.deepEqual(
    view.additional.documents.map((d) => d.id),
    ['4'],
  );
  assert.equal(view.documentCount, 4);
  assert.equal(view.fileLimit, 40);
  assert.equal(view.full, false);
});

test('connected count: areas with at least one document, out of the areas sent', () => {
  const view = areaListView(
    snapshot([doc('1', 'policies'), doc('2', 'policies'), doc('3', 'additional')]),
  );
  assert.equal(view.connected, 1);
  assert.equal(view.total, 5);
  assert.equal(view.countText, '1/5 areas connected');
  assert.equal(areaListView(snapshot([])).countText, '0/5 areas connected');
  const all = areaListView(snapshot(topics.map((topic, i) => doc(String(i), topic.id))));
  assert.equal(all.countText, '5/5 areas connected');
  assert.equal(areasConnectedText(2, 5), '2/5 areas connected');
});

test('removing one document leaves the others in its area', () => {
  const before = snapshot([doc('1', 'role-tools'), doc('2', 'role-tools')]);
  const after = { ...before, documents: before.documents.filter((d) => d.id !== '1') };
  const area = areaListView(after).areas.find((a) => a.id === 'role-tools');
  assert.deepEqual(
    area.documents.map((d) => d.id),
    ['2'],
  );
  assert.equal(areaListView(after).connected, 1);
});

test('the snapshot topics win; the shared list is only a fallback', () => {
  const renamed = [{ id: 'alignment', title: 'Purpose', description: '', icon: '' }];
  assert.deepEqual(areaTopics({ topics: renamed }), [
    { id: 'alignment', title: 'Purpose', description: '', icon: 'book' },
  ]);
  const fallback = areaTopics({ documents: [] });
  assert.deepEqual(
    fallback.map((topic) => topic.id),
    ['documentation', 'policies', 'alignment', 'role-tools', 'team-support'],
  );
  assert.deepEqual(areaTopics({ topics: [] }), fallback);
  assert.deepEqual(areaTopics({ topics: [null, { id: '' }] }), fallback);
  assert.deepEqual(areaTopics(null), fallback);
  // 'additional' is its own card, never an area.
  assert.deepEqual(
    areaTopics({ topics: [{ id: 'additional', title: 'x' }, topics[0]] }).map((t) => t.id),
    ['alignment'],
  );
});

test('retired topic ids show in their mapped area; unknown ones under Other useful guidance', () => {
  const ids = topics.map((topic) => topic.id);
  assert.equal(areaIdFor('policies', ids), 'policies');
  assert.equal(areaIdFor('handbook', ids), 'policies');
  assert.equal(areaIdFor('it', ids), 'role-tools');
  assert.equal(areaIdFor('company', ids), 'alignment');
  assert.equal(areaIdFor('mystery', ids), 'additional');
  assert.equal(areaIdFor(undefined, ids), 'additional');
  const view = areaListView(
    snapshot([doc('1', 'handbook'), doc('2', 'mystery'), doc('3', 'communication')]),
  );
  assert.deepEqual(
    view.areas.find((a) => a.id === 'policies').documents.map((d) => d.id),
    ['1'],
  );
  assert.deepEqual(
    view.areas.find((a) => a.id === 'team-support').documents.map((d) => d.id),
    ['3'],
  );
  assert.deepEqual(
    view.additional.documents.map((d) => d.id),
    ['2'],
  );
});

test('the library is full at the file limit', () => {
  const documents = Array.from({ length: 3 }, (_, i) => doc(String(i), 'alignment'));
  assert.equal(areaListView(snapshot(documents, { limits: { files: 3 } })).full, true);
  assert.equal(areaListView(snapshot(documents, { limits: { files: 4 } })).full, false);
  assert.equal(areaListView({ topics, documents }).fileLimit, 40);
});

test('move options: every other area, then Other useful guidance', () => {
  const { areas } = areaListView(snapshot([]));
  const fromPolicies = moveOptions(areas, 'policies');
  assert.deepEqual(
    fromPolicies.map((option) => option.value),
    ['alignment', 'documentation', 'team-support', 'role-tools', 'additional'],
  );
  assert.deepEqual(fromPolicies[0], { value: 'alignment', label: 'Company Purpose & Alignment' });
  assert.deepEqual(fromPolicies.at(-1), { value: 'additional', label: 'Other useful guidance' });
  const fromOther = moveOptions(areas, 'additional');
  assert.deepEqual(
    fromOther.map((option) => option.value),
    ['alignment', 'documentation', 'team-support', 'role-tools', 'policies'],
  );
  for (const area of areas)
    assert.ok(!moveOptions(areas, area.id).some((option) => option.value === area.id));
});

test('area titles and document labels', () => {
  const view = areaListView(snapshot([]));
  assert.equal(areaTitle(view, 'role-tools'), 'Role, Tools & AI Readiness');
  assert.equal(areaTitle(view, 'additional'), additionalArea.title);
  assert.equal(areaTitle(view, 'gone'), additionalArea.title);
  assert.equal(documentLabel({ title: 'Leave policy', fileName: 'leave.pdf' }), 'Leave policy');
  // Legacy documents connected before #35 have no file name.
  assert.equal(documentLabel({ title: 'Old IT', fileName: '' }), 'Old IT');
  assert.equal(documentLabel({ title: '', fileName: 'x.md' }), 'x.md');
  assert.equal(documentLabel({ fileName: '', title: '' }), 'Uploaded document');
});

test('error mapping for upload, move and remove', () => {
  const error = (status, code, message = 'server text') => ({ status, code, message });
  assert.match(
    knowledgeErrorMessage(error(409, 'COMPANY_DOCUMENT_DUPLICATE'), 'upload'),
    /already in another area.*Move to…/,
  );
  assert.match(
    knowledgeErrorMessage(error(409, 'COMPANY_DOCUMENT_DUPLICATE'), 'move'),
    /same text is already in that area/,
  );
  assert.match(
    knowledgeErrorMessage(error(400, 'DOCUMENT_NAME_INVALID'), 'upload'),
    /one line and up to 80 characters/,
  );
  for (const action of ['upload', 'move'])
    assert.match(
      knowledgeErrorMessage(error(400, 'DOCUMENT_TOPIC_REQUIRED'), action),
      /no longer available\. Refresh/,
    );
  for (const action of ['move', 'remove'])
    assert.match(
      knowledgeErrorMessage(error(404, 'WORKSPACE_DOCUMENT_NOT_FOUND'), action),
      /already removed/,
    );
  // Any 429 (the 30-per-minute limit sends no code) asks HR to wait.
  assert.equal(knowledgeErrorMessage(error(429, ''), 'move'), rateLimitMessage);
  assert.equal(knowledgeErrorMessage(error(429, undefined, undefined), 'upload'), rateLimitMessage);
  // Codes the page does not know keep the server's message (limits, file errors).
  assert.equal(
    knowledgeErrorMessage(error(409, 'WORKSPACE_DOCUMENT_LIMIT', 'Remove one first.'), 'upload'),
    'Remove one first.',
  );
  assert.equal(
    knowledgeErrorMessage(error(500, '', ''), 'move'),
    'The document could not be moved. Please try again.',
  );
  assert.equal(
    knowledgeErrorMessage({}, 'remove'),
    'The document could not be removed. Please try again.',
  );
  assert.equal(
    knowledgeErrorMessage(undefined),
    'The document could not be uploaded. Please try again.',
  );
});

test('errors that mean the list is stale ask for a refresh', () => {
  assert.equal(errorNeedsRefresh({ code: 'WORKSPACE_DOCUMENT_NOT_FOUND' }), true);
  assert.equal(errorNeedsRefresh({ code: 'DOCUMENT_TOPIC_REQUIRED' }), true);
  assert.equal(errorNeedsRefresh({ code: 'COMPANY_DOCUMENT_DUPLICATE' }), false);
  assert.equal(errorNeedsRefresh(undefined), false);
});
