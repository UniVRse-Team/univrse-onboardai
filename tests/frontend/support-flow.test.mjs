import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_MAX,
  actionDecisionError,
  actionIsPending,
  actionPrompt,
  actionResolvedText,
  answerExtras,
  askHrOffer,
  chatExtras,
  handoffKey,
  helpfulStepId,
  noteCounter,
  noteProblem,
  previewBody,
  previewErrorMessage,
  previewView,
  reexplainForward,
  requestBody,
  saveHandoff,
  briefingHandoff,
  sentMessage,
  stepChip,
  takeHandoff,
  visibleChips,
} from '../../src/access/support-flow.mjs';

const answer = (extra = {}) => ({ id: 'r-a', role: 'assistant', text: 'x', ...extra });

test('no-answer coverage offers Ask HR', () => {
  assert.equal(askHrOffer(answer({ coverage: 'none' })), 'no-answer');
  assert.equal(askHrOffer(answer({ coverage: 'full' })), null);
  assert.equal(askHrOffer(answer({ coverage: null })), null);
});
test('Ask HR to follow up needs a re-explained answer marked Still unclear', () => {
  const base = { reexplainOf: 'q-a' };
  assert.equal(askHrOffer(answer({ ...base, feedback: 'unclear' })), 'follow-up');
  assert.equal(askHrOffer(answer({ ...base, feedback: 'helpful' })), null);
  assert.equal(askHrOffer(answer({ ...base })), null);
  assert.equal(askHrOffer(answer({ feedback: 'unclear' })), null);
});
test('the greeting, errors and plain notes are never offered Ask HR', () => {
  for (const m of [
    answer({ intro: true, coverage: 'none' }),
    answer({ error: 'boom', coverage: 'none' }),
    answer({ plain: true, coverage: 'none' }),
    { role: 'user', coverage: 'none' },
  ])
    assert.equal(askHrOffer(m), null);
});
test('Still unclear brings other explanations forward', () => {
  assert.equal(reexplainForward(answer({ feedback: 'unclear' })), true);
  assert.equal(reexplainForward(answer({ feedback: 'helpful' })), false);
});
test('note counter and the 500 character limit', () => {
  assert.equal(NOTE_MAX, 500);
  assert.equal(noteCounter(''), '0 / 500');
  assert.equal(noteCounter('héllo'), '5 / 500');
  assert.equal(noteProblem('a'.repeat(500)), '');
  assert.match(noteProblem('a'.repeat(501)), /500 characters/);
});
test('request bodies carry ids and a trimmed note only when there is one', () => {
  const ids = { conversationId: 'c1', messageId: 'm1' };
  assert.deepEqual(previewBody({ ...ids, note: 'ignored' }), ids);
  assert.deepEqual(requestBody({ ...ids, note: '  ' }), ids);
  assert.deepEqual(requestBody({ ...ids, note: ' please call ' }), { ...ids, note: 'please call' });
});
test('preview shows exactly the question, answer and sources', () => {
  const view = previewView({
    question: 'Q?',
    alyaAnswer: 'A.',
    sources: [
      { title: 'Handbook', heading: 'Leave' },
      { title: 'Policy', heading: 'Policy' },
      { title: 'Guide', heading: '' },
    ],
  });
  assert.deepEqual(view, {
    question: 'Q?',
    answer: 'A.',
    sources: ['Handbook — Leave', 'Policy', 'Guide'],
  });
  assert.deepEqual(previewView(null), { question: '', answer: '', sources: [] });
  assert.match(previewErrorMessage({ status: 404 }), /couldn’t find that answer/);
  assert.equal(previewErrorMessage({ status: 500, message: 'Down' }), 'Down');
});
test('sent state names the status', () => {
  assert.equal(sentMessage({ status: 'open' }), 'Sent to HR. Status: with HR.');
  assert.match(sentMessage({ status: 'resolved' }, { existing: true }), /already sent.*resolved/);
  assert.match(sentMessage({ status: 'briefing_scheduled' }), /briefing scheduled/);
});
test('chat extras only include what is set', () => {
  assert.deepEqual(chatExtras(), {});
  assert.deepEqual(chatExtras({ quickQuestionId: 'step:a.b' }), { quickQuestionId: 'step:a.b' });
  assert.deepEqual(chatExtras({ reexplainOf: 'r-a', quickQuestionId: '' }), { reexplainOf: 'r-a' });
});
test('answer extras read the response or the stored message', () => {
  assert.deepEqual(answerExtras({ coverage: 'none', proposedAction: { id: 'x' } }, {}), {
    coverage: 'none',
    category: null,
    proposedAction: { id: 'x' },
  });
  assert.deepEqual(answerExtras({}, { coverage: 'full', reexplainOf: 'm1' }), {
    coverage: 'full',
    category: null,
    proposedAction: null,
    reexplainOf: 'm1',
  });
  assert.equal(answerExtras(null, null).coverage, null);
});
test('chips: at most three, only complete ones', () => {
  const chips = [1, 2, 3, 4].map((n) => ({
    id: 'c' + n,
    label: 'L' + n,
    question: 'Q' + n,
    kind: 'knowledge',
  }));
  assert.equal(visibleChips({ chips }).length, 3);
  assert.deepEqual(visibleChips({ chips: [{ id: 'a', label: 'A' }, chips[0]] }), [
    { id: 'c1', label: 'L1', question: 'Q1' },
  ]);
  assert.deepEqual(visibleChips(null), []);
});
test('F5 prompt wording by new status', () => {
  const action = { stepTitle: 'Sign the NDA', areaTitle: 'Documentation', newStatus: 'done' };
  assert.equal(actionPrompt(action), 'Mark “Sign the NDA” (Documentation) as done?');
  assert.equal(
    actionPrompt({ ...action, newStatus: 'submitted' }),
    'Mark “Sign the NDA” (Documentation) as submitted for HR to verify?',
  );
});
test('only a pending, unexpired action shows buttons', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  const future = '2026-10-16T11:00:00Z';
  assert.equal(actionIsPending({ status: 'pending', expiresAt: future }, now), true);
  assert.equal(
    actionIsPending({ status: 'pending', expiresAt: '2026-10-16T09:00:00Z' }, now),
    false,
  );
  for (const status of ['approved', 'declined', 'expired'])
    assert.equal(actionIsPending({ status, expiresAt: future }, now), false);
  assert.equal(actionIsPending(null), false);
});
test('resolved actions read as resolved', () => {
  assert.match(actionResolvedText({ status: 'approved', newStatus: 'done' }), /marked as done/);
  assert.match(actionResolvedText({ status: 'approved', newStatus: 'submitted' }), /submitted/);
  assert.match(actionResolvedText({ status: 'declined' }), /not yet/);
  assert.match(actionResolvedText({ status: 'expired' }), /expired/);
});
test('ACTION_NOT_PENDING closes the card; other errors keep the buttons', () => {
  const closed = actionDecisionError({ code: 'ACTION_NOT_PENDING', message: 'x' });
  assert.equal(closed.expired, true);
  const other = actionDecisionError({ message: 'Network' });
  assert.deepEqual(other, { message: 'Network', expired: false });
  // v1.5: the action stays pending until the briefing is done.
  const briefing = actionDecisionError({ status: 409, code: 'BRIEFING_REQUIRED', message: 'x' });
  assert.equal(briefing.expired, false, 'the buttons stay, to approve after the briefing');
  assert.match(briefing.message, /briefing for this step first/);
});
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
    data,
  };
}
test('Ask Alya hand-off is read once, then cleared', () => {
  const storage = memoryStorage();
  const chip = stepChip({ id: 'policies.conduct', askAlya: 'What is the code of conduct?' });
  assert.deepEqual(chip, { id: 'step:policies.conduct', question: 'What is the code of conduct?' });
  assert.equal(saveHandoff(storage, chip), true);
  assert.deepEqual(takeHandoff(storage), { kind: 'chip', ...chip });
  assert.equal(storage.data.has(handoffKey), false);
  assert.equal(takeHandoff(storage), null);
  assert.equal(stepChip({ id: 'x', askAlya: null }), null);
});
test('a broken hand-off is ignored', () => {
  const storage = memoryStorage();
  storage.setItem(handoffKey, '{not json');
  assert.equal(takeHandoff(storage), null);
  storage.setItem(handoffKey, JSON.stringify({ id: 5 }));
  assert.equal(takeHandoff(storage), null);
  assert.equal(
    saveHandoff(
      {
        setItem: () => {
          throw new Error('full');
        },
      },
      { id: 'a', question: 'b' },
    ),
    false,
  );
});

test('real API payload shapes: stored assistant messages and chat responses', () => {
  const stored = {
    id: 'r-a',
    requestId: 'r',
    role: 'assistant',
    text: 'x',
    result: { answer: 'x' },
    coverage: 'full',
    category: 'onboarding',
    quickQuestionId: null,
    reexplainOf: 'q-a',
    proposedAction: null,
    feedback: 'unclear',
  };
  const view = { ...stored, ...answerExtras(stored, stored.result) };
  assert.equal(view.reexplainOf, 'q-a');
  assert.equal(view.proposedAction, null);
  assert.equal(askHrOffer(view), 'follow-up');
  const old = {
    id: 'o-a',
    role: 'assistant',
    coverage: null,
    category: null,
    quickQuestionId: null,
    reexplainOf: null,
    proposedAction: null,
  };
  assert.equal(askHrOffer({ ...old, ...answerExtras(old, {}) }), null);
  const live = {
    coverage: 'none',
    category: 'onboarding',
    quickQuestionId: null,
    reexplainOf: null,
    proposedAction: null,
  };
  assert.equal(
    askHrOffer({ id: 'n-a', role: 'assistant', ...answerExtras(live, null) }),
    'no-answer',
  );
});

test('the briefing hand-off round-trips, and each page takes only its own kinds', () => {
  const storage = memoryStorage();
  // Dashboard -> Alya: "Ask Alya" on a step with a briefing (#66).
  saveHandoff(storage, briefingHandoff('documentation.tax-id-documents'));
  assert.equal(takeHandoff(storage), null, 'a chips-only reader leaves it in place');
  assert.ok(storage.data.has(handoffKey));
  assert.deepEqual(takeHandoff(storage, ['chip', 'briefing']), {
    kind: 'briefing',
    stepId: 'documentation.tax-id-documents',
  });
  assert.equal(storage.data.has(handoffKey), false);
  assert.equal(takeHandoff(storage, ['chip', 'briefing']), null, 'read once');
  // The old Alya -> dashboard check hand-off is gone (#66).
  storage.setItem(handoffKey, JSON.stringify({ kind: 'check', stepId: 'policies.pdpa' }));
  assert.equal(takeHandoff(storage, ['chip', 'briefing']), null);
  // A chip saved by an older build (no kind) still works.
  storage.setItem(handoffKey, JSON.stringify({ id: 'step:x', question: 'Q?' }));
  assert.deepEqual(takeHandoff(storage), { kind: 'chip', id: 'step:x', question: 'Q?' });
  // Broken briefing hand-offs are dropped.
  storage.setItem(handoffKey, JSON.stringify({ kind: 'briefing', stepId: '' }));
  assert.equal(takeHandoff(storage, ['briefing']), null);
  storage.setItem(handoffKey, JSON.stringify({ kind: 'briefing' }));
  assert.equal(takeHandoff(storage, ['briefing']), null);
});

test('helpfulStepId resolves step chips, general step chips, proposed actions and re-explanations', () => {
  const first = answer({ id: 'm1-a', quickQuestionId: 'step:policies.employee-handbook' });
  const second = answer({ id: 'm2-a', reexplainOf: 'm1-a' });
  assert.equal(helpfulStepId(first, [first]), 'policies.employee-handbook');
  assert.equal(helpfulStepId(second, [first, second]), 'policies.employee-handbook');
  assert.equal(
    helpfulStepId(answer({ quickQuestionId: 'dress-code' })),
    'policies.employee-handbook',
  );
  assert.equal(
    helpfulStepId(answer({ proposedAction: { stepId: 'team-support.meet-buddy' } })),
    'team-support.meet-buddy',
  );
  assert.equal(helpfulStepId(answer({ quickQuestionId: 'day-one-host' })), null);
});
