// Issue #115: the search query never carries the company name the planner
// added (the search is already limited to the company's documents), while the
// answer step keeps the company name and the planner's standalone question.
// Fake Gemini models, an in-memory chat store and synthetic passages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { createConversationService, searchQueryFor } from '../../server/gemini-chat-workflow.mjs';
import { createChatStore } from '../../server/chat-store.mjs';

test('searchQueryFor removes the planner-added company name, keeps the rest', () => {
  const seri = 'Seri Bayu Digital';
  const luna = 'Luna Digital';
  assert.equal(
    searchQueryFor(
      'What are the official working hours from Monday to Thursday at Seri Bayu Digital?',
      seri,
    ),
    'What are the official working hours from Monday to Thursday?',
  );
  assert.equal(
    searchQueryFor(
      'What is the employee dress code for weekdays at the office at Seri Bayu Digital?',
      seri,
    ),
    'What is the employee dress code for weekdays at the office?',
  );
  assert.equal(
    searchQueryFor('When is the regular internal meeting at Luna Digital?', luna),
    'When is the regular internal meeting?',
  );
  assert.equal(searchQueryFor("Seri Bayu Digital's dress code", seri), 'dress code');
  assert.equal(searchQueryFor('Seri Bayu Digital’s dress code policy', seri), 'dress code policy');
  assert.equal(
    searchQueryFor('parental leave policy for Luna Digital employees', luna),
    'parental leave policy employees',
  );
  assert.equal(
    searchQueryFor('annual leave days in the LUNA  digital handbook', luna),
    'annual leave days handbook',
  );
  assert.equal(
    searchQueryFor('Luna Digital annual leave entitlement', luna),
    'annual leave entitlement',
  );
  // Another company's name or a partial name is left alone.
  assert.equal(
    searchQueryFor('leave days at Luna Digitalis Group', luna),
    'leave days at Luna Digitalis Group',
  );
  assert.equal(searchQueryFor('leave days at Seri Bayu', seri), 'leave days at Seri Bayu');
});

test('searchQueryFor escapes regex characters in the company name', () => {
  const name = 'A.B (Pte+) [Ltd]?';
  assert.equal(
    searchQueryFor('annual leave days for A.B (Pte+) [Ltd]? staff', name),
    'annual leave days staff',
  );
  // "." is literal: AxB does not match A.B.
  assert.equal(
    searchQueryFor('annual leave days for AxB (Pte+) [Ltd]? staff', name),
    'annual leave days for AxB (Pte+) [Ltd]? staff',
  );
});

test('searchQueryFor never returns an empty or one-word query', () => {
  assert.equal(searchQueryFor('Luna Digital', 'Luna Digital'), 'Luna Digital');
  assert.equal(searchQueryFor('Luna Digital?', 'Luna Digital'), 'Luna Digital?');
  assert.equal(searchQueryFor('policy at Luna Digital', 'Luna Digital'), 'policy at Luna Digital');
  assert.equal(searchQueryFor('', 'Luna Digital'), '');
  assert.equal(searchQueryFor('working hours at the office', ''), 'working hours at the office');
  assert.equal(searchQueryFor(undefined, 'Luna Digital'), '');
});

test('searchQueryFor keeps the name when the question is about the company itself', () => {
  for (const [query, name] of [
    ['When was Seri Bayu Digital established?', 'Seri Bayu Digital'],
    ['What is the name of Luna Digital company?', 'Luna Digital'],
    ['What is the name of our company?', 'Luna Digital'],
    ['Who founded Seri Bayu Digital?', 'Seri Bayu Digital'],
    ['History of Luna Digital', 'Luna Digital'],
    ['What is the mission of Luna Digital?', 'Luna Digital'],
    ['Where is Luna Digital headquartered?', 'Luna Digital'],
    ['Who is Luna Digital?', 'Luna Digital'],
    ['What is Luna Digital called?', 'Luna Digital'],
  ])
    assert.equal(searchQueryFor(query, name), query, query);
});

function serviceWith(plannedQuery, retrieveCalls, prompts) {
  const models = {
    plan: {
      invoke: async (messages) => {
        prompts.understand = messages[0].content;
        return {
          kind: 'company',
          query: plannedQuery,
          clarification: '',
          category: 'onboarding',
          topic: 'working hours',
        };
      },
    },
    answer: {
      invoke: async (messages) => {
        prompts.answer = messages.map((message) => String(message.content)).join('\n');
        return { answer: 'Work starts at 9:00 a.m.', citations: [1], coverage: 'full' };
      },
    },
    summarize: { invoke: async () => new AIMessage('Earlier.') },
  };
  return createConversationService({
    env: { ONBOARDAI_ENVIRONMENT: 'production' },
    models,
    memory: createChatStore({ CHAT_DATABASE_PATH: ':memory:' }),
    retrieve: async (query) => {
      retrieveCalls.push(query);
      return [{ title: 'Handbook.docx', heading: 'Hours', text: 'Work starts at 9:00 a.m.' }];
    },
  });
}

test('the retrieval node searches without the company name; the answer step keeps it', async () => {
  const planned = 'What are the working hours from Monday to Thursday at Seri Bayu Digital?';
  const retrieveCalls = [];
  const prompts = {};
  const service = serviceWith(planned, retrieveCalls, prompts);
  try {
    const chat = await service.memory.create('employee-1');
    await service.ask(
      'employee-1',
      chat.id,
      'What are the working hours?',
      randomUUID(),
      undefined,
      null,
      null,
      { companyId: 'seri-bayu-digital', companyName: 'Seri Bayu Digital' },
    );
    assert.deepEqual(retrieveCalls, ['What are the working hours from Monday to Thursday?']);
    // The answer prompt still names the company and carries the planner's question.
    assert.match(prompts.answer, /Seri Bayu Digital/);
    assert.ok(prompts.answer.includes(`Standalone question: ${planned}`), prompts.answer);
  } finally {
    await service.close();
  }
});

test('the retrieval node keeps the name for a question about the company itself', async () => {
  const planned = 'When was Seri Bayu Digital established?';
  const retrieveCalls = [];
  const service = serviceWith(planned, retrieveCalls, {});
  try {
    const chat = await service.memory.create('employee-1');
    await service.ask(
      'employee-1',
      chat.id,
      'When was Seri Bayu Digital established?',
      randomUUID(),
      undefined,
      null,
      null,
      { companyId: 'seri-bayu-digital', companyName: 'Seri Bayu Digital' },
    );
    assert.deepEqual(retrieveCalls, [planned]);
  } finally {
    await service.close();
  }
});

test('the interpretation prompt tells the planner not to add the company name to the query', async () => {
  const prompts = {};
  const service = serviceWith('annual leave days', [], prompts);
  try {
    const chat = await service.memory.create('employee-1');
    await service.ask(
      'employee-1',
      chat.id,
      'How much leave do I get?',
      randomUUID(),
      undefined,
      null,
      null,
      {
        companyId: 'seri-bayu-digital',
        companyName: 'Seri Bayu Digital',
      },
    );
    assert.ok(
      prompts.understand.includes(
        "The search is already limited to Seri Bayu Digital's own documents, so do not add the company name (or \"the company\") to the search query unless the user's question is about the company's name or identity itself.",
      ),
    );
  } finally {
    await service.close();
  }
});

test('searchQueryFor: ordinary questions with who/located/based still lose the name', () => {
  for (const [query, name, expected] of [
    ['Who is my onboarding buddy at RIMBA?', 'RIMBA', 'Who is my onboarding buddy?'],
    ['Who is the HR contact at Luna Digital?', 'Luna Digital', 'Who is the HR contact?'],
    [
      'Where is the first-aid kit located at Seri Bayu Digital?',
      'Seri Bayu Digital',
      'Where is the first-aid kit located?',
    ],
    [
      'What is the performance-based bonus at Luna Digital?',
      'Luna Digital',
      'What is the performance-based bonus?',
    ],
    ["What is Luna Digital's leave policy?", 'Luna Digital', 'What is leave policy?'],
  ])
    assert.equal(searchQueryFor(query, name), expected, query);
});

test('searchQueryFor: a wh-word + auxiliary + the name as subject keeps the name', () => {
  for (const [query, name] of [
    ['Where is Luna Digital located?', 'Luna Digital'],
    ['What does Luna Digital do?', 'Luna Digital'],
    ['Who is Luna Digital?', 'Luna Digital'],
    ['Where is Luna Digital based?', 'Luna Digital'],
    ['When was Seri Bayu Digital established?', 'Seri Bayu Digital'],
    ['What is the history of Luna Digital?', 'Luna Digital'],
  ])
    assert.equal(searchQueryFor(query, name), query, query);
});
