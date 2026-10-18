import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionPage,
  nextStep,
  previousStep,
  sceneOrder,
  shownScene,
  stepAnnouncement,
  stepBounds,
} from '../../src/avatar/scene-steps.mjs';
import { answerPresentation } from '../../src/avatar/answer-presentation.mjs';
import { clothingPresentation } from '../../src/avatar/clothing-presentation.mjs';

const pages = [
  { start: 0, end: 30, text: 'First part of a long caption,' },
  { start: 30, end: 61, text: 'and the second part of it.' },
];

test('without voice, every visible scene can be stepped through in spoken order', () => {
  const presentation = answerPresentation({
    text: 'Check in at reception. Bring your laptop. Meet your manager.',
    reply: 'Check in at reception. Bring your laptop. Meet your manager.',
  });
  const order = sceneOrder(presentation);
  assert.deepEqual(order, [0, 1, 2]);
  let step = { scene: 0, page: 0 };
  const seen = [shownScene(presentation, { voiceLed: false, step, order })];
  while (!stepBounds(step, order).last) {
    step = nextStep(step, order);
    seen.push(shownScene(presentation, { voiceLed: false, step, order }));
  }
  assert.deepEqual(seen, [0, 1, 2]);
  assert.deepEqual(nextStep(step, order), step, 'Next stops at the last scene');
  assert.equal(stepBounds({ scene: 0, page: 0 }, order).first, true);
});

test('clothing gaps are skipped when stepping, as they are while Alya speaks', () => {
  const reply = 'Wear a blouse with trousers. Contact HR for the exact policy. Avoid beachwear.';
  const presentation = answerPresentation(
    { referenceQuestion: 'What should I wear?', reply, text: reply },
    reply,
  );
  assert.equal(presentation.kind, 'clothing');
  assert.equal(presentation.scenes[1].visible, false);
  const order = sceneOrder(presentation);
  assert.deepEqual(order, [0, 2]);
  assert.equal(
    shownScene(presentation, {
      voiceLed: false,
      step: nextStep({ scene: 0, page: 0 }, order),
      order,
    }),
    2,
  );
  assert.deepEqual(sceneOrder(null), []);
  assert.deepEqual(sceneOrder(clothingPresentation({ referenceQuestion: 'x' }, 'Hello.')), []);
});

test('a long caption is read page by page before the next scene, and Previous returns', () => {
  const order = [0, 1];
  const counts = { 0: 2, 1: 1 };
  let step = { scene: 0, page: 0 };
  step = nextStep(step, order, counts);
  assert.deepEqual(step, { scene: 0, page: 1 });
  assert.equal(stepBounds(step, order, counts).last, false);
  step = nextStep(step, order, counts);
  assert.deepEqual(step, { scene: 1, page: 0 });
  assert.equal(stepBounds(step, order, counts).last, true);
  step = previousStep(step, order, counts);
  assert.deepEqual(step, { scene: 0, page: 1 }, 'back to the end of the previous scene');
  step = previousStep(step, order, counts);
  assert.deepEqual(step, { scene: 0, page: 0 });
  assert.deepEqual(previousStep(step, order, counts), { scene: 0, page: 0 });
  // A resize can leave fewer pages than the reader's position.
  assert.deepEqual(previousStep({ scene: 0, page: 5 }, order, counts), { scene: 0, page: 0 });
  assert.deepEqual(nextStep({ scene: 0, page: 5 }, order, counts), { scene: 1, page: 0 });
});

test('caption pages follow the voice, or the reader when stepping', () => {
  assert.equal(captionPage(pages, { character: 0 }), 0);
  assert.equal(captionPage(pages, { character: 45 }), 1);
  assert.equal(captionPage(pages, { character: 999 }), 1);
  assert.equal(captionPage(pages, { page: 1 }), 1);
  assert.equal(captionPage(pages, { page: 7 }), 1, 'clamped to the last page');
  assert.equal(captionPage(pages, { page: -2 }), 0);
  assert.equal(captionPage(pages, { page: null, character: 45 }), 1);
});

test('voice-led scenes show the opening scene until audio starts, then follow it', () => {
  const presentation = answerPresentation({
    text: 'Submit your leave request. Wait for manager approval.',
    reply: 'Submit your leave request. Wait for manager approval.',
  });
  const order = sceneOrder(presentation);
  const step = { scene: 1, page: 0 };
  // A slower voice (Gemini) can take a while to return the first sentence.
  assert.equal(shownScene(presentation, { voiceLed: true, started: false, step, order }), 0);
  assert.equal(
    shownScene(presentation, { voiceLed: true, started: true, spokenIndex: 1, step, order }),
    1,
  );
  // During a deliberate gap nothing is shown.
  assert.equal(
    shownScene(presentation, { voiceLed: true, started: true, spokenIndex: -1, step, order }),
    -1,
  );
  const gapFirst = answerPresentation(
    {
      referenceQuestion: 'What should I wear?',
      reply: 'Contact HR first. Wear a blouse.',
      text: 'Contact HR first. Wear a blouse.',
    },
    'Contact HR first. Wear a blouse.',
  );
  assert.equal(
    shownScene(gapFirst, { voiceLed: true, started: false, step, order: sceneOrder(gapFirst) }),
    -1,
    'an opening gap is never filled with a garment',
  );
});

test('moving to another scene is announced in plain words', () => {
  const presentation = answerPresentation({
    text: 'Read the agenda before the meeting. Prepare your work update.',
    reply: 'Read the agenda before the meeting. Prepare your work update.',
  });
  const order = sceneOrder(presentation);
  assert.equal(
    stepAnnouncement(presentation, order, { scene: 1, page: 0 }),
    `Step 2 of 2. ${presentation.scenes[1].label}. Prepare your work update.`,
  );
  assert.equal(stepAnnouncement(presentation, order, { scene: 4, page: 0 }), '');
});

test('without a voice the guide advances at reading pace, within limits', async () => {
  const { autoAdvanceDelay } = await import('../../src/avatar/scene-steps.mjs');
  assert.equal(autoAdvanceDelay(0), 3500);
  assert.equal(autoAdvanceDelay(20), 7600);
  assert.equal(autoAdvanceDelay(20, 2), 3800);
  assert.equal(autoAdvanceDelay(500), 14000);
});
