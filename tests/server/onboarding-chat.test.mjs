// Chat turns of the onboarding journey (issues #48-#50): coverage and category
// from gemini-chat's structured output (fake models) and from document search,
// re-explanations, the fields on saved messages, and anonymous knowledge gaps.
// pg-mem, the in-memory Firestore fake and synthetic content only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { startAccountsApp, syntheticProfile } from './account-harness.mjs';
import {
  answerSchema,
  fictionalExampleOpening,
  planSchema,
  withFictionalOpening,
} from '../../server/gemini-chat-workflow.mjs';
import { supportRequest } from '../../server/answer-style-preferences.mjs';

async function withApp(options, check) {
  const app = await startAccountsApp(options);
  try {
    await check(app);
  } finally {
    await app.close();
  }
}
const ask = (browser, conversationId, question, extra = {}, requestId = randomUUID()) =>
  browser.post('/api/chat', {
    question,
    taskId: 'quiz-part-1',
    conversationId,
    requestId,
    ...extra,
  });
const lastQuestion = (messages) => {
  const last = messages.at(-1);
  return typeof last.content === 'string' ? last.content : '';
};
const passages = [
  { title: 'Synthetic handbook', heading: 'Dress', text: 'Business casual clothing.' },
  { title: 'Synthetic guide', heading: 'Gym', text: 'Nothing about gyms.' },
];
// Questions name their behaviour, so one fake covers every case.
const scriptedModels = () => ({
  plan: {
    invoke: async (messages) => {
      const q = lastQuestion(messages).toLowerCase();
      if (q.includes('hello'))
        return {
          kind: 'conversation',
          query: q,
          clarification: '',
          category: 'onboarding',
          topic: '',
        };
      if (q.includes('that thing'))
        return { kind: 'clarify', query: q, clarification: '?', category: 'onboarding', topic: '' };
      const topic = q.includes('weather')
        ? 'weather'
        : q.includes('park')
          ? 'Parking'
          : q.includes('gym')
            ? 'gym'
            : 'dress code';
      return {
        kind: 'company',
        query: q,
        clarification: '',
        category: q.includes('weather')
          ? 'off_topic'
          : q.includes('nocategory')
            ? 'misc'
            : 'onboarding',
        topic,
      };
    },
  },
  answer: {
    invoke: async (messages) => {
      const system = messages[0].content;
      const q = system.slice(
        system.indexOf('Standalone question: '),
        system.indexOf('\nReference passages: '),
      );
      if (system.includes('Reference passages: []'))
        return { answer: 'Hello! How can I help?', citations: [], coverage: 'full' };
      if (q.includes('gym')) return { answer: 'I am not sure.', citations: [], coverage: 'none' };
      if (q.includes('partial'))
        return { answer: 'Business casual, mostly.', citations: [1], coverage: 'partial' };
      if (q.includes('oddcoverage'))
        return { answer: 'Business casual.', citations: [1], coverage: 'maybe' };
      return { answer: 'Business casual clothing.', citations: [1], coverage: 'full' };
    },
  },
  summarize: { invoke: async () => new AIMessage('Earlier questions.') },
});
const scriptedRetrieve = async (query) =>
  /weather|park/.test(query) ? [] : passages.map((p) => ({ ...p }));

test('the structured-output schemas carry category, topic and coverage', () => {
  assert.deepEqual(planSchema.properties.category.enum, ['onboarding', 'off_topic']);
  assert.equal(planSchema.properties.topic.type, 'string');
  assert.ok(planSchema.required.includes('category') && planSchema.required.includes('topic'));
  assert.deepEqual(answerSchema.properties.coverage.enum, ['full', 'partial', 'none', 'outdated']);
  assert.ok(answerSchema.required.includes('coverage'));
});

test('gemini-chat: coverage and category map from the models, retrieval and withheld answers', async () => {
  await withApp(
    { mode: 'gemini-chat', models: scriptedModels, companyRetrieve: scriptedRetrieve },
    async (app) => {
      const hr = await app.hrBrowser();
      const { browser } = await app.readyEmployee(hr);
      const chat = (await browser.post('/api/conversations')).body;
      const cases = [
        ['What is the dress code?', 'full', 'onboarding'],
        ['What is the partial dress code?', 'partial', 'onboarding'],
        // An invalid coverage with citations is partial.
        ['What is the oddcoverage dress code?', 'partial', 'onboarding'],
        // Nothing retrieved: none.
        ['Where do I park?', 'none', 'onboarding'],
        // An answer without citations is withheld: none.
        ['Is there a gym?', 'none', 'onboarding'],
        ['What is the weather today?', 'none', 'off_topic'],
        // Conversation and clarify turns have no coverage.
        ['hello Alya', null, 'onboarding'],
        ['What about that thing?', null, 'onboarding'],
        // An unknown category is null.
        ['nocategory dress code?', 'full', null],
      ];
      for (const [question, coverage, category] of cases) {
        const answered = await ask(browser, chat.id, question);
        assert.equal(answered.status, 200, answered.text);
        assert.deepEqual(
          [answered.body.coverage, answered.body.category],
          [coverage, category],
          question,
        );
        assert.equal(answered.body.proposedAction, null);
        assert.equal(answered.body.quickQuestionId, null);
        assert.equal(answered.body.reexplainOf, null);
        assert.equal('journey' in answered.body, false);
        assert.equal('supportSummary' in answered.body, false);
      }
      const withheld = (await browser.get(`/api/conversations/${chat.id}`)).body.messages[9];
      assert.match(withheld.text, /does not clearly establish/);
    },
  );
});

test('document-search: a match is full coverage and no match none, with no category', async () => {
  await withApp(
    {
      mode: 'document-search',
      companyRetrieve: async (query) => (query.includes('nothing') ? [] : passages),
    },
    async (app) => {
      const hr = await app.hrBrowser();
      const { browser } = await app.readyEmployee(hr);
      const chat = (await browser.post('/api/conversations')).body;
      const matched = await ask(browser, chat.id, 'What is the dress code?');
      assert.deepEqual(
        [matched.body.matched, matched.body.coverage, matched.body.category],
        [true, 'full', null],
      );
      const missed = await ask(browser, chat.id, 'Tell me nothing');
      assert.deepEqual(
        [missed.body.matched, missed.body.coverage, missed.body.category],
        [false, 'none', null],
      );
      // Never a knowledge gap: the category is unknown.
      assert.deepEqual(app.firestore.paths('knowledgeGaps/'), []);
    },
  );
});

for (const mode of ['gemini-chat', 'document-search'])
  test(`${mode}: re-explanations name an answer of the same chat and every field is on the saved message`, async () => {
    await withApp({ mode }, async (app) => {
      const hr = await app.hrBrowser();
      const { browser } = await app.readyEmployee(hr);
      const chat = (await browser.post('/api/conversations')).body;
      const other = (await browser.post('/api/conversations')).body;
      const requestId = randomUUID();
      await ask(browser, chat.id, 'What should I wear?', {}, requestId);
      const elsewhere = randomUUID();
      await ask(browser, other.id, 'What should I wear?', {}, elsewhere);

      const again = await ask(
        browser,
        chat.id,
        'Please keep the answer brief for this question: What should I wear?',
        {
          reexplainOf: requestId + '-a',
        },
      );
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.reexplainOf, requestId + '-a');
      for (const reexplainOf of [
        elsewhere + '-a', // another chat's answer
        requestId + '-u', // a question, not an answer
        randomUUID() + '-a',
        'nonsense',
        42,
      ]) {
        const refused = await ask(browser, chat.id, 'Explain it again', { reexplainOf });
        assert.deepEqual(
          [refused.status, refused.body.code],
          [404, 'ANSWER_NOT_FOUND'],
          String(reexplainOf),
        );
      }
      const opened = await browser.get(`/api/conversations/${chat.id}`);
      const answers = opened.body.messages.filter((m) => m.role === 'assistant');
      assert.equal(answers.length, 2);
      for (const message of answers)
        for (const key of [
          'coverage',
          'category',
          'quickQuestionId',
          'reexplainOf',
          'proposedAction',
        ])
          assert.ok(key in message, `${key} at the top level`);
      assert.equal(answers[0].reexplainOf, null);
      assert.equal(answers[1].reexplainOf, requestId + '-a');
      assert.equal(answers[1].coverage, mode === 'document-search' ? 'full' : 'partial');
      // Feedback sits next to them.
      await browser.post(`/api/conversations/${chat.id}/feedback`, {
        messageId: requestId + '-a',
        rating: 'unclear',
      });
      const rated = (await browser.get(`/api/conversations/${chat.id}`)).body.messages[1];
      assert.equal(rated.feedback, 'unclear');
      assert.equal(rated.coverage, mode === 'document-search' ? 'full' : 'partial');
      // User messages are unchanged.
      assert.equal('coverage' in opened.body.messages[0], false);
    });
  });

test('knowledge gaps: unanswered onboarding questions are logged without names, ids or times', async () => {
  await withApp(
    { mode: 'gemini-chat', models: scriptedModels, companyRetrieve: scriptedRetrieve },
    async (app) => {
      const hr = await app.hrBrowser();
      const intern = syntheticProfile();
      intern.job.track = 'intern';
      const { employee, browser } = await app.readyEmployee(hr, { profile: intern });
      const chat = (await browser.post('/api/conversations')).body;
      const question =
        'Where do I park? I am PC-0001, text me on +60 12-345 6789 or avery@example.com, IC 900101-14-5678';
      const requestId = randomUUID();
      const answered = await ask(browser, chat.id, question, {}, requestId);
      assert.deepEqual([answered.body.coverage, answered.body.category], ['none', 'onboarding']);
      // Repeating the request does not log twice.
      await ask(browser, chat.id, question, {}, requestId);
      // An answer withheld for missing citations is a gap with the nearest source.
      await ask(browser, chat.id, 'Is there a gym?');
      // Not logged: off-topic, answered, re-explanations and personal chips.
      await ask(browser, chat.id, 'What is the weather today?');
      await ask(browser, chat.id, 'What is the dress code?');
      await ask(
        browser,
        chat.id,
        'Please explain this step by step for this question: Where do I park?',
        {
          reexplainOf: requestId + '-a',
        },
      );
      await ask(browser, chat.id, 'Where and what time do I report on day 1?', {
        quickQuestionId: 'day-one-arrival',
      });
      // HR accounts' own questions are not logged either.
      const hrChat = (await hr.post('/api/conversations')).body;
      await ask(hr, hrChat.id, 'Where do I park my car?');

      const paths = app.firestore.paths('knowledgeGaps/');
      assert.equal(paths.length, 2);
      const docs = paths.map((path) => app.firestore.read(path));
      const parking = docs.find((doc) => doc.topic === 'parking');
      assert.deepEqual(parking, {
        questionRedacted:
          'Where do I park? I am [employee ID], text me on [phone] or [email], IC [IC number]',
        topic: 'parking',
        track: 'intern',
        nearestSource: null,
        companyId: 'univrse',
        createdDay: '2026-10-15',
      });
      assert.deepEqual(docs.find((doc) => doc.topic === 'gym').nearestSource, {
        title: 'Synthetic handbook',
        heading: 'Dress',
      });
      const stored = JSON.stringify(docs);
      for (const secret of [employee.account.id, chat.id, requestId, 'PC-0001', 'avery@', 'T01:'])
        assert.ok(!stored.includes(secret), secret);

      const listed = await hr.get('/api/hr/knowledge-gaps');
      assert.equal(listed.status, 200);
      assert.equal(listed.body.total, 2);
      assert.deepEqual(
        listed.body.groups.map((g) => [g.topic, g.count, g.tracks.intern, g.lastSeenDay]),
        [
          ['gym', 1, 1, '2026-10-15'],
          ['parking', 1, 1, '2026-10-15'],
        ],
      );
      assert.ok(!listed.text.includes(employee.account.id));
      // A failed gap write does not fail the answer.
      app.firestore.fail(14, { only: ['set'] });
      const still = await ask(browser, chat.id, 'Where can I park a bicycle?');
      assert.equal(still.status, 200);
    },
  );
});

test('the "Keep it brief" button text counts as a brief request', () => {
  assert.deepEqual(supportRequest('Please keep the answer brief.'), {
    format: 'brief',
    reason: 'brief-request',
  });
  assert.deepEqual(
    supportRequest('Please keep the answer brief for this question: What is the dress code?'),
    { format: 'brief', reason: 'brief-request' },
  );
  assert.deepEqual(supportRequest('keep it brief'), { format: 'brief', reason: 'brief-request' });
  assert.equal(supportRequest('Please do not keep the answer brief'), null);
  assert.equal(supportRequest("Don't keep it short"), null);
});

test('an example answer says it is fictional in a first sentence that is shown and spoken', async () => {
  assert.equal(fictionalExampleOpening, 'Here is a fictional example to show how this works.');
  // Already said in the first sentence: not repeated.
  const own = 'In this fictional example, Sam arrives at 08:45. Sam signs in.';
  assert.equal(withFictionalOpening(own), own);
  assert.equal(
    withFictionalOpening('Sam arrives at 08:45. This fictional case shows the process.'),
    `${fictionalExampleOpening}\nSam arrives at 08:45. This fictional case shows the process.`,
  );
  await withApp(
    { mode: 'gemini-chat', models: scriptedModels, companyRetrieve: scriptedRetrieve },
    async (app) => {
      const hr = await app.hrBrowser();
      const { browser } = await app.readyEmployee(hr);
      const chat = (await browser.post('/api/conversations')).body;
      const answered = await ask(browser, chat.id, 'Give me a worked example of the dress code.');
      assert.equal(answered.status, 200, answered.text);
      assert.equal(answered.body.answer, `${fictionalExampleOpening}\nBusiness casual clothing.`);
      // No label line (a line ending in a colon) that speech would drop.
      assert.ok(answered.body.answer.split('\n').every((line) => !/:\s*$/.test(line)));
      assert.ok(!answered.body.answer.includes('Fictional worked example:'));
      // An ordinary answer (a new chat, without the example style) has no opening.
      const other = (await browser.post('/api/conversations')).body;
      const plain = await ask(browser, other.id, 'What is the dress code?');
      assert.equal(plain.body.answer, 'Business casual clothing.');
    },
  );
});
