import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  briefingAction,
  briefingErrorMessage,
  briefingMessage,
  briefingRecordedText,
  briefingTitle,
  canConfirmRead,
  dashboardPath,
  findBriefing,
  listenedCompletion,
  opensInPage,
  shouldFocusBriefingCard,
} from '../../src/avatar/briefing-flow.mjs';
import { createServerSpeech } from '../../src/avatar/answer-audio-player.js';
import { answerSpeech } from '../../src/avatar/spoken-answer.mjs';
import { answerPresentation } from '../../src/avatar/answer-presentation.mjs';
import { sceneOrder } from '../../src/avatar/scene-steps.mjs';
import {
  actionLabels,
  briefingDoneLabel,
  briefingStatus,
  isMainAction,
  stepActions,
  stepErrorMessage,
} from '../../src/access/onboarding-view.mjs';
import { stepAskHandoff } from '../../src/access/support-flow.mjs';

// A required step from GET /api/me/onboarding (contract v1.5).
const step = (overrides = {}) => ({
  id: 'documentation.tax-id-documents',
  title: 'Pass over a copy of your IC (front and back)',
  description: '',
  required: true,
  completion: 'hr_verify',
  askAlya: 'How do I sign my contract?',
  hasCheck: false,
  status: 'todo',
  briefing: {
    text: 'Your contract arrives by email on your first morning. Read it, sign it and return it to People & Culture. HR then confirms it in your plan.',
    sourceTitle: 'First-Day & First-Week Guide',
  },
  briefingRequired: true,
  briefed: false,
  ...overrides,
});

// The real player, with audio that plays when told to.
function mockVoice({ fail = false } = {}) {
  const originalWindow = globalThis.window,
    originalFetch = globalThis.fetch;
  const sources = [];
  class AudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    async resume() {}
    async close() {}
    async decodeAudioData() {
      return { duration: 1 };
    }
    createBufferSource() {
      const source = {
        connect() {},
        disconnect() {},
        start() {},
        stop() {
          this.onended?.();
        },
      };
      sources.push(source);
      return source;
    }
  }
  globalThis.window = { AudioContext };
  globalThis.fetch = async () =>
    fail
      ? { ok: false, json: async () => ({ error: 'Voice unavailable' }) }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  const player = createServerSpeech();
  const settle = () => new Promise(setImmediate);
  return {
    player,
    sources,
    settle,
    // Let every audio chunk play to its natural end.
    async playThrough() {
      for (let i = 0; i < 20; i++) {
        await settle();
        const playing = sources.find((source) => !source.done && source.onended);
        if (!playing) continue;
        playing.done = true;
        playing.onended();
      }
    },
    restore() {
      player.dispose();
      globalThis.window = originalWindow;
      globalThis.fetch = originalFetch;
    },
  };
}
const speakBriefing = (player) => {
  const speech = answerSpeech(briefingMessage(step()));
  return player.speak(speech.text, { segments: speech.segments });
};

test('"listened" is sent only when the briefing plays to its natural end', async () => {
  const fixture = mockVoice();
  try {
    const playback = speakBriefing(fixture.player);
    await fixture.playThrough();
    const outcome = await playback;
    assert.equal(outcome, 'ended');
    assert.equal(listenedCompletion(outcome), 'listened');
  } finally {
    fixture.restore();
  }
});

test('stopping, interrupting or leaving the page records nothing', async () => {
  // Stop voice.
  let fixture = mockVoice();
  try {
    const playback = speakBriefing(fixture.player);
    await fixture.settle();
    fixture.player.stop();
    assert.equal(await playback, 'stopped');
    assert.equal(listenedCompletion('stopped'), null);
  } finally {
    fixture.restore();
  }
  // Interrupted by another answer, or "Listen again" restarting it.
  fixture = mockVoice();
  try {
    const first = speakBriefing(fixture.player);
    await fixture.settle();
    const again = speakBriefing(fixture.player);
    assert.equal(await first, 'stopped', 'the interrupted playback never counts');
    await fixture.playThrough();
    assert.equal(listenedCompletion(await again), 'listened', 'the restart can count');
  } finally {
    fixture.restore();
  }
  // Navigating away disposes the player mid-briefing.
  fixture = mockVoice();
  try {
    const playback = speakBriefing(fixture.player);
    await fixture.settle();
    fixture.player.dispose();
    assert.equal(listenedCompletion(await playback), null);
  } finally {
    fixture.restore();
  }
  // A voice failure is not listening either; the read path takes over.
  fixture = mockVoice({ fail: true });
  try {
    assert.equal(listenedCompletion(await speakBriefing(fixture.player)), null);
  } finally {
    fixture.restore();
  }
  assert.equal(listenedCompletion('unavailable'), null);
  assert.equal(listenedCompletion('empty'), null);
});

test('the briefing entry presents and speaks the whole briefing text, nothing else', () => {
  const message = briefingMessage(step());
  assert.equal(briefingTitle(step()), 'Briefing: Pass over a copy of your IC (front and back)');
  assert.equal(message.briefing, true);
  assert.equal(message.reply, step().briefing.text, 'the full text, not a short reply');
  const speech = answerSpeech(message);
  assert.equal(speech.text, step().briefing.text);
  assert.equal(speech.segments.join(' '), speech.text);
  assert.equal(answerPresentation(message).text, speech.text);
  assert.equal(briefingMessage(step({ briefing: null })), null);
  assert.equal(briefingMessage(step({ briefing: { text: '  ' } })), null);
});

test('reading needs the last page of the last scene, and only without voice', () => {
  const presentation = answerPresentation(briefingMessage(step()));
  const order = sceneOrder(presentation);
  assert.equal(order.length, 3);
  const last = { scene: order.length - 1, page: 0 };
  assert.equal(
    canConfirmRead({ voiceAvailable: false, step: { scene: 0, page: 0 }, order }),
    false,
  );
  assert.equal(canConfirmRead({ voiceAvailable: false, step: last, order }), true);
  // A long last caption has two pages: the button waits for the second.
  assert.equal(
    canConfirmRead({ voiceAvailable: false, step: last, order, pageCounts: { [order.at(-1)]: 2 } }),
    false,
  );
  assert.equal(
    canConfirmRead({
      voiceAvailable: false,
      step: { ...last, page: 1 },
      order,
      pageCounts: { [order.at(-1)]: 2 },
    }),
    true,
  );
  assert.equal(canConfirmRead({ voiceAvailable: true, step: last, order }), false);
  assert.equal(canConfirmRead({ voiceAvailable: false, step: last, order: [] }), false);
});

test('after the briefing, Alya’s page offers the step’s own action (#66)', () => {
  assert.deepEqual(briefingAction(step({ completion: 'self', title: 'Meet your buddy' })), {
    kind: 'complete',
    label: 'Mark as completed',
    note: '',
    done: '“Meet your buddy” is completed.',
  });
  assert.deepEqual(briefingAction(step()), {
    kind: 'complete',
    label: 'Mark as submitted',
    note: 'HR will verify it.',
    done: '“Pass over a copy of your IC (front and back)” is marked as submitted. HR will verify it.',
  });
  // A check step's question is answered on Alya's page, not on the dashboard.
  assert.deepEqual(briefingAction(step({ completion: 'check', title: 'Data protection' })), {
    kind: 'check',
    label: 'Alya’s question',
    note: 'Answer it to complete this step.',
    done: 'You passed. “Data protection” is done.',
  });
  assert.equal(briefingAction(step({ status: 'done' })).kind, 'none');
  assert.match(briefingAction(step({ status: 'submitted' })).text, /waiting for HR/);
});

test('the dashboard offers Ask Alya first; the completing action only once briefed', () => {
  for (const [completion, finish] of [
    ['self', 'complete'],
    ['hr_verify', 'submit'],
    ['check', 'check'],
  ]) {
    // Before the briefing: Ask Alya alone, filled; nothing disabled, no reason text.
    const before = step({ completion });
    assert.deepEqual(stepActions(before), ['ask'], completion);
    assert.equal(isMainAction('ask', stepActions(before)), true);
    // Ask Alya hands over the briefing, not the chip question.
    assert.deepEqual(stepAskHandoff(before), { kind: 'briefing', stepId: before.id });
    // Once briefed, the completing action shows as a shortcut beside it.
    const after = step({ completion, briefed: true });
    assert.deepEqual(stepActions(after), ['ask', finish], completion);
    assert.equal(isMainAction(finish, stepActions(after)), true);
    assert.equal(isMainAction('ask', stepActions(after)), false);
  }
  assert.deepEqual(stepActions(step({ completion: 'self', status: 'done', briefed: true })), [
    'ask',
    'reopen',
  ]);
  assert.deepEqual(stepActions(step({ status: 'submitted', briefed: true })), ['ask', 'withdraw']);
  assert.equal(briefingStatus(step({ briefed: true })), briefingDoneLabel);
  assert.equal(briefingDoneLabel, 'Briefing done');
  assert.equal(briefingStatus(step()), '');
  assert.equal(briefingStatus(step({ briefed: true, status: 'done' })), '');
  // Optional steps (and payloads before v1.5) are unchanged: their own action,
  // then Ask Alya with the step's question as a chip.
  const optional = step({ required: false, briefing: null, briefingRequired: false });
  assert.deepEqual(stepActions(optional), ['submit', 'ask']);
  assert.deepEqual(stepAskHandoff(optional), {
    id: 'step:documentation.tax-id-documents',
    question: 'How do I sign my contract?',
  });
  assert.deepEqual(stepActions({ id: 'x', completion: 'self', status: 'todo', askAlya: null }), [
    'complete',
  ]);
  assert.equal(stepAskHandoff({ id: 'x', askAlya: null }), null);
  assert.equal(actionLabels.ask, 'Ask Alya');
  assert.equal('briefing' in actionLabels, false, 'no separate briefing button');
});

test('409 BRIEFING_REQUIRED and BRIEFING_NOT_FOUND read calmly', () => {
  assert.equal(
    stepErrorMessage({ status: 409, code: 'BRIEFING_REQUIRED' }),
    'Listen to Alya’s briefing first. Choose “Ask Alya” on this step.',
  );
  assert.match(stepErrorMessage({ status: 404, code: 'BRIEFING_NOT_FOUND' }), /no briefing/);
  assert.match(briefingErrorMessage({ status: 404, code: 'BRIEFING_NOT_FOUND' }), /no briefing/);
  assert.match(briefingErrorMessage({ status: 409, code: 'BRIEFING_REQUIRED' }), /isn’t recorded/);
  assert.equal(
    briefingErrorMessage({ status: 429 }),
    'That’s a lot at once. Please try again shortly.',
  );
});

test('the briefing is read from the onboarding payload by step id', () => {
  const onboarding = {
    areas: [{ id: 'documentation', steps: [step(), step({ id: 'b', briefing: null })] }],
  };
  assert.equal(
    findBriefing(onboarding, 'documentation.tax-id-documents').step.id,
    'documentation.tax-id-documents',
  );
  assert.match(findBriefing(onboarding, 'b').missing, /no briefing/);
  assert.match(findBriefing(onboarding, 'gone').missing, /no longer in your plan/);
  assert.equal(briefingRecordedText('listened'), 'Briefing done. Thanks for listening.');
  assert.equal(briefingRecordedText('read'), 'Briefing done. Thanks for reading it.');
  assert.equal(briefingRecordedText('helpful'), 'Briefing done. Marked as helpful.');
});

test('#66 QA: the action card takes focus when it appears, also for a step briefed earlier', () => {
  // A step briefed earlier: the card is there on the entry's first render.
  assert.equal(shouldFocusBriefingCard({ before: undefined, phase: 'done' }), true);
  // After a played or read briefing.
  assert.equal(shouldFocusBriefingCard({ before: 'presenting', phase: 'done' }), true);
  assert.equal(shouldFocusBriefingCard({ before: 'recording', phase: 'done' }), true);
  // When the step is completed.
  assert.equal(shouldFocusBriefingCard({ before: 'acting', phase: 'completed' }), true);
  assert.equal(shouldFocusBriefingCard({ before: undefined, phase: 'completed' }), true);
  // Not again while the card stays, and not before it shows.
  assert.equal(shouldFocusBriefingCard({ before: 'done', phase: 'done' }), false);
  assert.equal(shouldFocusBriefingCard({ before: 'acting', phase: 'done' }), false);
  assert.equal(shouldFocusBriefingCard({ before: 'done', phase: 'acting' }), false);
  assert.equal(shouldFocusBriefingCard({ before: 'completed', phase: 'completed' }), false);
  assert.equal(shouldFocusBriefingCard({ before: undefined, phase: 'presenting' }), false);
  // Never while the employee types in the composer.
  assert.equal(shouldFocusBriefingCard({ before: undefined, phase: 'done', typing: true }), false);
  assert.equal(
    shouldFocusBriefingCard({ before: 'acting', phase: 'completed', typing: true }),
    false,
  );
});

test('#66 QA: Back to your dashboard is a link; only a plain left click stays in the app', () => {
  assert.equal(dashboardPath, '/onboarding');
  assert.equal(opensInPage({ button: 0 }), true);
  assert.equal(opensInPage({}), true);
  assert.equal(opensInPage({ button: 1 }), false);
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'])
    assert.equal(opensInPage({ button: 0, [key]: true }), false);
  const source = readFileSync(
    new URL('../../src/avatar/BriefingEntry.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /<a\s+href=\{dashboardPath\}/);
  assert.doesNotMatch(source, /<button[^>]*alya-briefing-secondary/);
});
