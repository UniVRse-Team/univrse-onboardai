// Pure rules for the chat side of the onboarding journey: the Ask HR consent
// flow, quick-question chips, the re-explain request and F5 approval cards.

import { fieldProblems, journeyErrorMessage } from './journey-errors.mjs';

export const NOTE_MAX = 500;
export const noCoverageText = 'I couldn’t find this in the company documents';

const isAnswer = (message) =>
  message?.role === 'assistant' && !message.intro && !message.error && !message.plain;

// Which Ask HR offer an answer gets: 'no-answer' | 'follow-up' | null.
export function askHrOffer(message) {
  if (!isAnswer(message)) return null;
  if (message.coverage === 'none') return 'no-answer';
  if (message.reexplainOf && message.feedback === 'unclear') return 'follow-up';
  return null;
}

export const staleAskHrText =
  'These company documents are out of date. HR can confirm the current guidance.';

// The sentence above the Ask HR button for a 'no-answer' offer. A stale
// turn (guardrail.verdict === 'stale') names the out-of-date documents.
export function noAnswerNote(message) {
  return message?.guardrail?.verdict === 'stale'
    ? staleAskHrText
    : `${noCoverageText}. HR may be able to help.`;
}

// "Still unclear" brings the other explanations forward.
export function reexplainForward(message) {
  return isAnswer(message) && message.feedback === 'unclear';
}

export const askHrLabels = {
  'no-answer': 'Ask HR',
  'follow-up': 'Ask HR to follow up',
};

// Note field.
export function noteCounter(note) {
  return `${[...String(note ?? '')].length} / ${NOTE_MAX}`;
}
export function noteProblem(note) {
  return [...String(note ?? '')].length > NOTE_MAX
    ? `Keep your note to ${NOTE_MAX} characters or fewer.`
    : '';
}

export function previewBody({ conversationId, messageId }) {
  return { conversationId, messageId };
}
export function requestBody({ conversationId, messageId, note }) {
  const trimmed = String(note ?? '').trim();
  return trimmed ? { conversationId, messageId, note: trimmed } : { conversationId, messageId };
}

// Exactly what HR will see, from the preview response.
export function previewView(preview) {
  const sources = Array.isArray(preview?.sources) ? preview.sources : [];
  return {
    question: String(preview?.question ?? ''),
    answer: String(preview?.alyaAnswer ?? ''),
    sources: sources.map((source) =>
      source.heading && source.heading !== source.title
        ? `${source.title} — ${source.heading}`
        : String(source.title ?? ''),
    ),
  };
}

export function previewErrorMessage(error) {
  if (error?.status === 404 && !error.code)
    return 'I couldn’t find that answer to share. Please try asking again.';
  return journeyErrorMessage(error, 'Could not prepare your request. Please try again.');
}

// Sending a request: a note problem goes on the note field, anything else is a message.
export function sendErrorView(error) {
  const fields = fieldProblems(error?.fields, { note: 'Your note' });
  if (fields.note) return { note: fields.note, message: '' };
  return {
    note: '',
    message: journeyErrorMessage(error, 'Could not send your request. Please try again.'),
  };
}

// Text after sending. `existing` is true when the same answer was sent before.
export function sentMessage(request, { existing = false } = {}) {
  const base = existing ? 'You had already sent this to HR.' : 'Sent to HR.';
  return `${base} Status: ${requestStatusWord(request?.status)}.`;
}
export function requestStatusWord(status) {
  if (status === 'briefing_scheduled') return 'briefing scheduled';
  if (status === 'resolved') return 'resolved';
  return 'with HR';
}

// Body fields for POST /api/chat beyond the question.
export function chatExtras({ quickQuestionId, reexplainOf } = {}) {
  const extras = {};
  if (quickQuestionId) extras.quickQuestionId = quickQuestionId;
  if (reexplainOf) extras.reexplainOf = reexplainOf;
  return extras;
}

// The extra answer fields from a chat response or a stored message.
export function answerExtras(source, result) {
  const read = (key) => source?.[key] ?? result?.[key] ?? null;
  const out = {
    coverage: read('coverage'),
    category: read('category'),
    proposedAction: read('proposedAction'),
  };
  const quick = read('quickQuestionId');
  const re = read('reexplainOf');
  if (quick) out.quickQuestionId = quick;
  if (re) out.reexplainOf = re;
  const guardrail = read('guardrail');
  if (guardrail && typeof guardrail === 'object') out.guardrail = guardrail;
  return out;
}

// Chips, at most 3, each with the question to send.
export function visibleChips(payload) {
  const chips = Array.isArray(payload?.chips) ? payload.chips : [];
  return chips
    .filter((chip) => chip?.id && chip.label && chip.question)
    .slice(0, 3)
    .map((chip) => ({ id: chip.id, label: chip.label, question: chip.question }));
}

// F5 approval cards.
export function actionPrompt(action) {
  const what = action.newStatus === 'submitted' ? 'as submitted for HR to verify' : 'as done';
  return `Mark “${action.stepTitle}” (${action.areaTitle}) ${what}?`;
}
export function actionIsPending(action, now = Date.now()) {
  if (action?.status !== 'pending') return false;
  const expires = Date.parse(action.expiresAt);
  return Number.isNaN(expires) || expires > now;
}
export function actionResolvedText(action) {
  if (action.status === 'approved')
    return action.newStatus === 'submitted'
      ? 'You approved this. It is marked as submitted.'
      : 'You approved this. It is marked as done.';
  if (action.status === 'declined') return 'You chose not yet. Nothing was changed.';
  return 'This request expired. Nothing was changed.';
}
export function actionDecisionError(error) {
  if (error?.code === 'ACTION_NOT_PENDING')
    return { message: 'This request is no longer open. Nothing was changed.', expired: true };
  // v1.5: the action stays pending, so it can be approved after the briefing.
  if (error?.code === 'BRIEFING_REQUIRED')
    return {
      message: 'Listen to Alya’s briefing for this step first. Then you can approve this here.',
      expired: false,
    };
  return { message: error?.message || 'That did not work. Please try again.', expired: false };
}
export const decisionLabels = { approve: 'Approve', decline: 'Not yet' };

// Hand-offs from the dashboard to Alya's page, through sessionStorage:
//   chip:     an optional step's "Ask Alya" question, sent as that step's chip;
//   briefing: "Ask Alya" on a step with a briefing (#66) -> Alya presents it,
//             then shows the step's action on her page.
// A page takes only the kinds it handles; another kind is left in place.
export const handoffKey = 'onboardai-chip-handoff-v1';
export function saveHandoff(storage, handoff) {
  try {
    const value =
      handoff?.kind === 'briefing'
        ? { kind: 'briefing', stepId: handoff.stepId }
        : { kind: 'chip', id: handoff.id, question: handoff.question };
    storage.setItem(handoffKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function readHandoff(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'briefing' && typeof value.stepId === 'string')
    return value.stepId ? { kind: 'briefing', stepId: value.stepId } : null;
  if ((value.kind === undefined || value.kind === 'chip') && typeof value.id === 'string')
    return typeof value.question === 'string'
      ? { kind: 'chip', id: value.id, question: value.question }
      : null;
  return null;
}
export function takeHandoff(storage, accept = ['chip']) {
  try {
    const handoff = readHandoff(JSON.parse(storage.getItem(handoffKey)));
    if (handoff && !accept.includes(handoff.kind)) return null;
    storage.removeItem(handoffKey);
    return handoff;
  } catch {
    try {
      storage.removeItem(handoffKey);
    } catch {}
    return null;
  }
}
// The task a waiting hand-off is about, without taking it (Alya's chips follow that task).
export function peekHandoffStepId(storage) {
  try {
    const handoff = readHandoff(JSON.parse(storage.getItem(handoffKey)));
    if (!handoff) return null;
    if (handoff.kind === 'briefing') return handoff.stepId;
    return handoff.id.startsWith('step:') ? handoff.id.slice(5).split('#')[0] : null;
  } catch {
    return null;
  }
}
export const briefingHandoff = (stepId) => ({ kind: 'briefing', stepId });
// What "Ask Alya" on a dashboard step hands over: its briefing when it has one,
// otherwise its chip question (or nothing).
export function stepAskHandoff(step) {
  if (step?.briefingRequired === true && step.id) return briefingHandoff(step.id);
  return stepChip(step);
}
export function stepChip(step) {
  return step?.askAlya ? { id: 'step:' + step.id, question: step.askAlya } : null;
}

const generalChipStepIds = Object.freeze({
  'dress-code': 'policies.employee-handbook',
  'company-background': 'alignment.products-customers',
});

// The step id a helpful answer covers, following reexplainOf back to the
// original answer.
export function helpfulStepId(message, messages = []) {
  const byId = new Map(
    (Array.isArray(messages) ? messages : []).filter((m) => m?.id).map((m) => [m.id, m]),
  );
  const seen = new Set();
  let current = message;
  while (current && typeof current === 'object' && !seen.has(current.id) && seen.size < 10) {
    if (current.id) seen.add(current.id);
    const qid = current.quickQuestionId ?? current.result?.quickQuestionId ?? null;
    if (typeof qid === 'string') {
      if (qid.startsWith('step:') && qid.length > 5) return qid.slice(5);
      if (generalChipStepIds[qid]) return generalChipStepIds[qid];
    }
    const actionStep = current.proposedAction?.stepId ?? current.result?.proposedAction?.stepId;
    if (typeof actionStep === 'string' && actionStep) return actionStep;
    const nextId = current.reexplainOf ?? current.result?.reexplainOf ?? null;
    current = typeof nextId === 'string' ? byId.get(nextId) : null;
  }
  return null;
}
