// Issue #68: the five onboarding-area folders. Migration 004 re-files the old
// six-topic documents; two documents in one area are both retrievable under
// their own titles. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { areaOrder } from '../../server/onboarding-content.mjs';
import { randomUUID } from 'node:crypto';
import { FakeFirestore } from './fake-firestore.mjs';
import { startAccountsApp } from './account-harness.mjs';
import { firestoreMigrationFiles, migrateFirestore } from '../../server/firestore-migrations.mjs';
import { up } from '../../server/migrations/firestore/004_company_documents_areas.mjs';
import {
  documentCategories,
  onboardingDocumentTopics,
} from '../../server/onboarding-document-topics.mjs';

const stored = (category, title) => ({
  category,
  title,
  fileName: `${title}.txt`,
  text: `Synthetic text of ${title}.`,
  characters: 10,
  bytes: 10,
  fingerprint: title,
  connectedBy: 'someone',
  connectedAt: '2026-10-01T00:00:00.000Z',
});

test('the five areas, in My Onboarding order, with the exact titles and descriptions', () => {
  assert.deepEqual(
    onboardingDocumentTopics.map((topic) => topic.id),
    ['documentation', 'policies', 'alignment', 'role-tools', 'team-support'],
  );
  // One source of truth: same order as the My Onboarding areas (issue #128).
  assert.deepEqual(
    onboardingDocumentTopics.map((topic) => topic.id),
    [...areaOrder],
  );
  assert.deepEqual(documentCategories, [...areaOrder, 'additional']);
  assert.deepEqual(onboardingDocumentTopics, [
    {
      id: 'documentation',
      title: 'Documentation',
      description: 'Complete required forms and submit documents.',
      icon: 'checklist',
    },
    {
      id: 'policies',
      title: 'Policies & Safe Practices',
      description: 'Understand company rules, privacy and responsible AI use.',
      icon: 'shield',
    },
    {
      id: 'alignment',
      title: 'Company Purpose & Alignment',
      description: 'Understand what the company does, its goals and how your role contributes.',
      icon: 'planet',
    },
    {
      id: 'role-tools',
      title: 'Role, Tools & AI Readiness',
      description:
        'Set up work tools, understand your responsibilities and identify suitable AI training.',
      icon: 'laptop',
    },
    {
      id: 'team-support',
      title: 'People & Workplace Support',
      description:
        'Know your teammates, who to ask for help and optionally share working preferences or support needs.',
      icon: 'people',
    },
  ]);
  assert.deepEqual(documentCategories.at(-1), 'additional');
});

test('migration 004 re-files the six old topics, keeps titles, and is idempotent', async () => {
  assert.ok(firestoreMigrationFiles().includes('004_company_documents_areas.mjs'));
  const firestore = new FakeFirestore();
  const old = [
    ['company', 'alignment'],
    ['handbook', 'policies'],
    ['first-week', 'documentation'],
    ['role', 'role-tools'],
    ['it', 'role-tools'],
    ['communication', 'team-support'],
    ['payroll', 'additional'],
    ['', 'additional'],
    ['additional', 'additional'],
    ['alignment', 'alignment'],
  ];
  const ids = old.map(([category], i) => {
    const id = randomUUID();
    firestore.write(`companyDocuments/${id}`, stored(category, `Guide ${i}`));
    return id;
  });
  const lines = [];
  await up({ firestore, log: (line) => lines.push(line) });
  const after = () =>
    ids.map((id) => {
      const doc = firestore.read(`companyDocuments/${id}`);
      return [doc.category, doc.title];
    });
  assert.deepEqual(
    after(),
    old.map(([, area], i) => [area, `Guide ${i}`]),
  );
  // Nothing else about a document changes.
  assert.deepEqual(
    { ...firestore.read(`companyDocuments/${ids[1]}`), category: 'handbook' },
    stored('handbook', 'Guide 1'),
  );
  // Log lines hold counts only.
  assert.deepEqual(lines, [
    'company documents: 6 re-filed into areas, 2 set to additional, 2 already current',
  ]);
  const snapshot = after();
  await up({ firestore, log: () => {} });
  assert.deepEqual(after(), snapshot);

  // The runner applies it once, and a fresh database with no documents is fine.
  const empty = new FakeFirestore();
  const run = await migrateFirestore(empty, { log: () => {} });
  assert.ok(run.applied.includes('004_company_documents_areas.mjs'));
  assert.deepEqual((await migrateFirestore(empty, { log: () => {} })).applied, []);
});

test('two documents in one area are both listed under their own titles while runtime chat queries Vertex AI Search', async () => {
  const app = await startAccountsApp({
    mode: 'document-search',
    companyRetrieve: async (query) =>
      /annual leave/i.test(query)
        ? [
            {
              id: 1,
              title: 'Leave Policy',
              heading: 'Annual Leave',
              text: 'Staff request annual leave through the synthetic portal two weeks ahead.',
              score: 1,
            },
          ]
        : [
            {
              id: 1,
              title: 'Privacy Guide',
              heading: 'Customer Privacy',
              text: 'Staff never copy customer records to personal synthetic drives.',
              score: 1,
            },
          ],
  });
  try {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const upload = (name, text) =>
      hr.upload('/api/hr/company-knowledge/documents?category=policies', Buffer.from(text), name);
    const leave = await upload(
      'Leave Policy.txt',
      'Annual Leave\nStaff request annual leave through the synthetic portal two weeks ahead.',
    );
    const privacy = await upload(
      'Privacy Guide.txt',
      'Customer Privacy\nStaff never copy customer records to personal synthetic drives.',
    );
    assert.deepEqual([leave.status, privacy.status], [201, 201]);
    const chat = (await browser.post('/api/conversations')).body;
    const ask = async (question) =>
      (
        await browser.post('/api/chat', {
          question,
          taskId: 'quiz-part-1',
          conversationId: chat.id,
          requestId: randomUUID(),
        })
      ).body;
    const leaveAnswer = await ask('How do I request annual leave?');
    assert.equal(leaveAnswer.passages[0].title, 'Leave Policy');
    const privacyAnswer = await ask('Can I copy customer records to a personal drive?');
    assert.equal(privacyAnswer.passages[0].title, 'Privacy Guide');
    // Both stay in one area, and neither title is the area's.
    const listed = (await hr.get('/api/hr/company-knowledge')).body.documents;
    assert.deepEqual(
      listed.map((d) => [d.title, d.category]),
      [
        ['Leave Policy', 'policies'],
        ['Privacy Guide', 'policies'],
      ],
    );
    // Moving one updates its area while keeping its title.
    const moved = await hr.patch(`/api/hr/company-knowledge/documents/${leave.body.id}`, {
      category: 'additional',
    });
    assert.equal(moved.status, 200);
    const again = await ask('How do I request annual leave?');
    assert.equal(again.passages[0].title, 'Leave Policy');
  } finally {
    await app.close();
  }
});

test('two documents in one area both sync to Vertex AI Search and are retrieved under their own titles', async () => {
  const indexed = new Map();
  const app = await startAccountsApp({
    mode: 'document-search',
    companyDocumentSync: {
      uploadDocument: async ({ id, title, text }) => {
        indexed.set(id, { title, text });
      },
      deleteDocument: async ({ id }) => {
        indexed.delete(id);
      },
    },
    companyRetrieve: async (query) => {
      const q = query.toLowerCase();
      return [...indexed.values()]
        .filter((doc) =>
          q.includes('leave') ? doc.title.includes('Leave') : doc.title.includes('Privacy'),
        )
        .map((doc) => ({ title: doc.title, heading: '', text: doc.text }));
    },
  });
  try {
    const hr = await app.hrBrowser();
    const { browser } = await app.readyEmployee(hr);
    const upload = (name, text) =>
      hr.upload('/api/hr/company-knowledge/documents?category=policies', Buffer.from(text), name);
    const leave = await upload(
      'Leave Policy.txt',
      'Annual Leave\nStaff request annual leave through the synthetic portal two weeks ahead.',
    );
    const privacy = await upload(
      'Privacy Guide.txt',
      'Customer Privacy\nStaff never copy customer records to personal synthetic drives.',
    );
    assert.deepEqual([leave.status, privacy.status], [201, 201]);
    const chat = (await browser.post('/api/conversations')).body;
    const ask = async (question) =>
      (
        await browser.post('/api/chat', {
          question,
          taskId: 'quiz-part-1',
          conversationId: chat.id,
          requestId: randomUUID(),
        })
      ).body;
    const leaveAnswer = await ask('How do I request annual leave?');
    assert.equal(leaveAnswer.passages[0].title, 'Leave Policy');
    const privacyAnswer = await ask('Can I copy customer records to a personal drive?');
    assert.equal(privacyAnswer.passages[0].title, 'Privacy Guide');
    // Both stay in one area, and neither title is the area's.
    const listed = (await hr.get('/api/hr/company-knowledge')).body.documents;
    assert.deepEqual(
      listed.map((d) => [d.title, d.category]),
      [
        ['Leave Policy', 'policies'],
        ['Privacy Guide', 'policies'],
      ],
    );
    // Moving one keeps it searchable in Vertex AI Search.
    const moved = await hr.patch(`/api/hr/company-knowledge/documents/${leave.body.id}`, {
      category: 'additional',
    });
    assert.equal(moved.status, 200);
    const again = await ask('How do I request annual leave?');
    assert.equal(again.passages[0].title, 'Leave Policy');
  } finally {
    await app.close();
  }
});
