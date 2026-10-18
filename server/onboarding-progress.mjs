import {
  areaOrder,
  briefingMaxLength,
  checkTypes,
  completionThreshold,
  completionTypes,
  writtenAnswerMaxLength,
} from './onboarding-content.mjs';
import { AI_READINESS_STEP_ID, presentAiProficiency } from './ai-proficiency.mjs';

// Pure onboarding footprint rules (issue #47): template validation, the
// Onboarding view, step transitions and the quick-question chip selection. No
// storage here; onboarding-journey.mjs reads and writes Firestore.

export const stepStatuses = Object.freeze(['todo', 'submitted', 'done']);
export const progressSources = Object.freeze(['employee', 'hr', 'alya-agent']);
export const briefingCompletions = Object.freeze(['listened', 'read', 'helpful']);
const stepIdPattern = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;

// A stored template as the server uses it, or null when it is not one: the
// five areas in contract order, each with at least one step, unique
// step ids "<areaId>.<slug>", a known completion type, and a check exactly on
// "check" steps. `required` defaults to true; the threshold to 70. A null
// template makes the caller fall back to the built-in seed. A step's briefing
// (v1.5) is { text, sourceTitle|null } or null; an optional step has none.
export function validTemplate(doc, track) {
  if (!isObject(doc) || !Array.isArray(doc.areas) || doc.areas.length !== areaOrder.length)
    return null;
  const seen = new Set();
  const areas = [];
  for (const [index, area] of doc.areas.entries()) {
    if (!isObject(area) || area.id !== areaOrder[index] || !text(area.title)) return null;
    if (!Array.isArray(area.steps) || !area.steps.length) return null;
    const steps = [];
    for (const step of area.steps) {
      if (!isObject(step) || typeof step.id !== 'string' || !stepIdPattern.test(step.id))
        return null;
      if (!step.id.startsWith(area.id + '.') || seen.has(step.id)) return null;
      if (!text(step.title) || !completionTypes.includes(step.completion)) return null;
      if (step.required !== undefined && typeof step.required !== 'boolean') return null;
      if (step.askAlya !== null && step.askAlya !== undefined && !text(step.askAlya)) return null;
      const check = step.completion === 'check' ? validCheck(step.check) : null;
      if (step.completion === 'check' && !check) return null;
      const required = step.required !== false;
      const brief = validBriefing(step.briefing);
      if (brief === undefined) return null;
      seen.add(step.id);
      steps.push({
        id: step.id,
        title: step.title,
        description: typeof step.description === 'string' ? step.description : '',
        required,
        completion: step.completion,
        askAlya: text(step.askAlya) ? step.askAlya : null,
        briefing: required ? brief : null,
        ...(check ? { check } : {}),
      });
    }
    areas.push({
      id: area.id,
      icon: typeof area.icon === 'string' ? area.icon : '',
      title: area.title,
      description: typeof area.description === 'string' ? area.description : '',
      steps,
    });
  }
  const threshold =
    Number.isInteger(doc.threshold) && doc.threshold >= 1 && doc.threshold <= 100
      ? doc.threshold
      : completionThreshold;
  return {
    track,
    version: Number.isInteger(doc.version) ? doc.version : 1,
    threshold,
    areas,
  };
}
// { text, sourceTitle } or null; undefined when the briefing is malformed.
function validBriefing(briefing) {
  if (briefing === null || briefing === undefined) return null;
  if (!isObject(briefing) || !text(briefing.text) || briefing.text.length > briefingMaxLength)
    return undefined;
  if (
    briefing.sourceTitle !== null &&
    briefing.sourceTitle !== undefined &&
    !text(briefing.sourceTitle)
  )
    return undefined;
  return {
    text: briefing.text,
    sourceTitle: text(briefing.sourceTitle) ? briefing.sourceTitle : null,
  };
}
// The pairs { id, text } of a list, with unique ids; null when malformed.
function idTextList(list, { min, max }) {
  if (!Array.isArray(list) || list.length < min || list.length > max) return null;
  const out = [];
  for (const item of list) {
    if (!isObject(item) || !text(item.id) || !text(item.text)) return null;
    if (out.some((o) => o.id === item.id)) return null;
    out.push({ id: item.id, text: item.text });
  }
  return out;
}
// A check of contract v1.4: { type: "choice", scenario, options, correctOptionId,
// explanation, sourceTitle } or { type: "written", scenario, keyPoints, mustNot,
// modelAnswer, explanation, sourceTitle, maxLength }. A check without a type
// (template version 1) is a choice check.
function validCheck(check) {
  if (!isObject(check) || !text(check.scenario)) return null;
  if (!text(check.explanation) || !text(check.sourceTitle)) return null;
  const type = check.type ?? 'choice';
  if (!checkTypes.includes(type)) return null;
  const common = {
    type,
    scenario: check.scenario,
    explanation: check.explanation,
    sourceTitle: check.sourceTitle,
  };
  if (type === 'choice') {
    const options = idTextList(check.options, { min: 2, max: 8 });
    if (!options || !options.some((o) => o.id === check.correctOptionId)) return null;
    return { ...common, options, correctOptionId: check.correctOptionId };
  }
  const keyPoints = idTextList(check.keyPoints, { min: 1, max: 6 });
  const mustNot = idTextList(check.mustNot ?? [], { min: 0, max: 6 });
  if (!keyPoints || !mustNot || !text(check.modelAnswer)) return null;
  const maxLength =
    check.maxLength === undefined
      ? writtenAnswerMaxLength
      : Number.isInteger(check.maxLength) && check.maxLength >= 20 && check.maxLength <= 2000
        ? check.maxLength
        : null;
  if (!maxLength) return null;
  return { ...common, keyPoints, mustNot, modelAnswer: check.modelAnswer, maxLength };
}

// The template step with this id and its area, or null.
export function findStep(template, stepId) {
  if (typeof stepId !== 'string') return null;
  for (const area of template.areas) {
    const step = area.steps.find((s) => s.id === stepId);
    if (step) return { area, step };
  }
  return null;
}

// The stored record of a step, whatever it holds, or null.
export function stepRecord(progress, stepId) {
  const entry = isObject(progress?.steps) ? progress.steps[stepId] : undefined;
  return isObject(entry) ? entry : null;
}
// The stored entry of a step, or null for "todo". Only "submitted" and "done"
// are statuses; a record with only briefedAt (v1.5) is still todo.
// For 'role-tools.ai-readiness-training', when progress.aiProficiency is
// present, the step is 'done' once a self-assessment has been submitted
// (status 'assessed') or the practice exercise is completed. The assessment is
// a training-needs survey, not an exam, so there is no pass mark.
export function progressEntry(progress, stepId) {
  const entry = stepRecord(progress, stepId);
  if (stepId === AI_READINESS_STEP_ID && isObject(progress?.aiProficiency)) {
    const { aiProficiency } = progress;
    if (aiProficiency.trainingCompleted !== true && aiProficiency.status !== 'assessed')
      return null;
    if (entry && entry.status === 'done') return entry;
    return {
      status: 'done',
      updatedAt:
        aiProficiency.trainingCompletedAt ||
        aiProficiency.assessedAt ||
        aiProficiency.updatedAt ||
        null,
      source: entry?.source || 'employee',
    };
  }
  return entry && ['submitted', 'done'].includes(entry.status) ? entry : null;
}
export const statusOf = (progress, stepId) => progressEntry(progress, stepId)?.status || 'todo';
// Briefings (v1.5): every required step with a briefing needs it first.
// Whether a step is satisfied by a reviewed document submission, not by a click.
export const needsDocument = (areaId, step) =>
  areaId === 'documentation' && step.completion === 'hr_verify' && step.required !== false;
export const briefedAt = (record) =>
  typeof record?.briefedAt === 'string' && record.briefedAt ? record.briefedAt : null;
export const briefingRequired = (step) => step.required !== false && Boolean(step.briefing);
export const needsBriefing = (step, record) => briefingRequired(step) && !briefedAt(record);

// The Onboarding shape of contract v1.2. Only required steps count: an
// area's percent is round(required done / required total x 100), and it meets
// the threshold when the exact ratio is at least threshold/100 (3 of 4 for
// 70%). Onboarding is complete when every area meets it; the overall percent
// (the mean of the area percents) is for display only. Submitted steps wait on
// HR and are not done. Optional steps are shown but never counted.
//
// nextStep: the first required todo step of the first area (in order) below
// the threshold that still has one; otherwise the first required todo step
// anywhere; otherwise null. Submitted and optional steps are never next.
export function buildOnboarding(template, progress) {
  const threshold = Number.isInteger(template.threshold) ? template.threshold : completionThreshold;
  let waitingOnHr = 0;
  const nextOf = (area, step) => ({
    id: step.id,
    title: step.title,
    areaId: area.id,
    areaTitle: area.title,
    completion: step.completion,
    askAlya: step.askAlya,
  });
  let firstBelow = null,
    firstAnywhere = null,
    sum = 0,
    counted = 0;
  const areas = template.areas.map((area) => {
    let done = 0,
      total = 0,
      todo = null;
    const steps = area.steps.map((step) => {
      const entry = progressEntry(progress, step.id);
      const status = entry?.status || 'todo';
      const required = step.required !== false;
      if (status === 'submitted') waitingOnHr++;
      if (required) {
        total++;
        if (status === 'done') done++;
        if (status === 'todo' && !todo) todo = step;
      }
      return {
        id: step.id,
        title: step.title,
        description: step.description,
        required,
        completion: step.completion,
        askAlya: step.askAlya,
        hasCheck: Boolean(step.check),
        // A documentation step is finished by saving its required document (HR review is separate).
        requiresDocument: area.id === 'documentation' && step.completion === 'hr_verify',
        briefing: step.briefing
          ? { text: step.briefing.text, sourceTitle: step.briefing.sourceTitle ?? null }
          : null,
        briefingRequired: briefingRequired(step),
        briefed: Boolean(briefedAt(stepRecord(progress, step.id))),
        status,
        updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
        source: typeof entry?.source === 'string' ? entry.source : null,
      };
    });
    const ratio = total ? done / total : 1;
    const meetsThreshold = ratio * 100 >= threshold - 1e-9;
    if (todo && !firstAnywhere) firstAnywhere = nextOf(area, todo);
    if (todo && !meetsThreshold && !firstBelow) firstBelow = nextOf(area, todo);
    // An area with no required step has nothing to measure, so it stays out of the overall percent.
    if (total) {
      sum += ratio;
      counted++;
    }
    return {
      id: area.id,
      icon: area.icon || '',
      title: area.title,
      description: area.description,
      percent: Math.round(ratio * 100),
      done,
      total,
      meetsThreshold,
      steps,
    };
  });
  return {
    track: template.track,
    percent: counted ? Math.round((sum / counted) * 100) : 100,
    threshold,
    complete: areas.every((area) => area.meetsThreshold),
    waitingOnHr,
    nextStep: firstBelow || firstAnywhere,
    aiProficiency: presentAiProficiency(
      progress?.aiProficiency,
      stepRecord(progress, AI_READINESS_STEP_ID),
    ),
    areas,
  };
}

// Step transitions. Each returns the step's new stored entry (null = todo) or
// throws { rule } naming the contract error; `entry` is the current one.
export class StepRuleError extends Error {
  constructor(rule) {
    super(rule);
    this.rule = rule;
  }
}
// The employee's "complete": self -> done, hr_verify -> submitted, a check
// needs its scenario. Completing a step that is already further along keeps it.
// Optional steps complete and reopen like self steps. A required step that has
// a briefing needs it first (v1.5): `record` is the step's stored record.
const asSelf = (step) => step.required === false || step.completion === 'self';
export function employeeComplete(step, entry, record = entry) {
  if (step.completion === 'check' && !asSelf(step)) {
    if (entry?.status === 'done') return entry;
    throw new StepRuleError('CHECK_REQUIRED');
  }
  if (entry) return entry;
  if (needsBriefing(step, record)) throw new StepRuleError('BRIEFING_REQUIRED');
  return { status: asSelf(step) ? 'done' : 'submitted' };
}
// The employee's "reopen": their own self-done step or submission goes back
// to todo; an HR-verified step or a passed check is locked.
export function employeeReopen(step, entry) {
  if (!entry || asSelf(step)) return null;
  if (step.completion === 'check') throw new StepRuleError('STEP_LOCKED');
  if (step.completion === 'hr_verify' && entry.status === 'done')
    throw new StepRuleError('STEP_LOCKED');
  return null;
}
// HR verifies (done) or unverifies (todo) hr_verify steps only.
export function hrSetStatus(step, entry, status) {
  if (step.completion !== 'hr_verify' || step.required === false)
    throw new StepRuleError('STEP_NOT_HR_VERIFIED');
  if (status === 'done') return entry?.status === 'done' ? entry : { status: 'done' };
  return null;
}

// Calendar days. Dates are "YYYY-MM-DD"; "today" is the company's calendar day
// (Malaysia), so a start date turns over at local midnight.
export const companyTimeZone = 'Asia/Kuala_Lumpur';
export function companyDay(at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: companyTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
export function addDays(day, days) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The chips of GET /api/me/quick-questions (at most 3):
//   1. the next-step chip "step:<stepId>" when the next step has an askAlya;
//   2. general chips from config: personal ones up to the day after the start
//      date (or when there is no start date), knowledge ones after that;
//   3. filled up to 3 from the other kind.
// The chips for one task: its own question first, then related ones (at most `limit`).
export function taskChips({ template, stepId, questions = [], limit = 3 }) {
  const found = findStep(template, stepId);
  if (!found) return null;
  const { step } = found;
  const out = [];
  if (step.askAlya)
    out.push({
      id: `step:${step.id}`,
      label: step.askAlya,
      question: step.askAlya,
      kind: 'knowledge',
      stepId: step.id,
    });
  questions.forEach((question, index) =>
    out.push({
      id: `step:${step.id}#${index + 1}`,
      label: question,
      question,
      kind: 'knowledge',
      stepId: step.id,
    }),
  );
  return out.slice(0, limit);
}

export function selectChips({ onboarding, chips, startDate, today, limit = 3 }) {
  const out = [];
  const next = onboarding.nextStep;
  if (next?.askAlya)
    out.push({
      id: `step:${next.id}`,
      label: next.askAlya,
      question: next.askAlya,
      kind: 'knowledge',
      stepId: next.id,
    });
  const personalFirst = !startDate || today <= addDays(startDate, 1);
  const first = personalFirst ? 'personal' : 'knowledge';
  const ordered = [
    ...chips.filter((chip) => chip.kind === first),
    ...chips.filter((chip) => chip.kind !== first),
  ];
  for (const chip of ordered) {
    if (out.length >= limit) break;
    out.push({
      id: chip.id,
      label: chip.label,
      question: chip.question,
      kind: chip.kind,
      stepId: null,
    });
  }
  return out.slice(0, limit);
}

// A stored chip list for one track, or null when it is malformed.
export function validChips(list) {
  if (!Array.isArray(list)) return null;
  const chips = [];
  for (const chip of list) {
    if (!isObject(chip) || !text(chip.id) || chip.id.startsWith('step:')) return null;
    if (!text(chip.label) || !text(chip.question)) return null;
    if (!['knowledge', 'personal'].includes(chip.kind)) return null;
    if (chip.kind === 'personal' && !['arrival', 'host'].includes(chip.personal)) return null;
    if (chips.some((c) => c.id === chip.id)) return null;
    chips.push({
      id: chip.id,
      label: chip.label,
      question: chip.question,
      kind: chip.kind,
      ...(chip.kind === 'personal' ? { personal: chip.personal } : {}),
    });
  }
  return chips;
}

const normalizeQuestion = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const generalChipStepIds = Object.freeze({
  'dress-code': 'policies.employee-handbook',
  'company-background': 'alignment.products-customers',
});

// The required step with a briefing that a helpful chat answer covers, or null:
// follows reexplainOf back to the original answer, checks step:<stepId> (and
// general chips that explain a step), proposedAction.stepId, and a user
// question that matches a step's askAlya or title.
export function stepForHelpfulMessage(template, messages, messageId) {
  if (!template || !Array.isArray(messages) || typeof messageId !== 'string') return null;
  const byId = new Map(messages.filter((m) => m?.id).map((m) => [m.id, m]));
  const start = byId.get(messageId);
  if (!start || start.role !== 'assistant') return null;
  const requireBriefingStep = (stepId) => {
    const found = findStep(template, stepId);
    return found && briefingRequired(found.step) ? found.step.id : null;
  };
  const seen = new Set();
  let current = start;
  while (current && !seen.has(current.id) && seen.size < 10) {
    seen.add(current.id);
    const qid = current.quickQuestionId ?? current.result?.quickQuestionId ?? null;
    if (typeof qid === 'string') {
      if (qid.startsWith('step:')) {
        const matched = requireBriefingStep(qid.slice(5));
        if (matched) return matched;
      } else if (generalChipStepIds[qid]) {
        const matched = requireBriefingStep(generalChipStepIds[qid]);
        if (matched) return matched;
      }
    }
    const actionStep =
      current.proposedAction?.stepId ?? current.result?.proposedAction?.stepId ?? null;
    if (typeof actionStep === 'string') {
      const matched = requireBriefingStep(actionStep);
      if (matched) return matched;
    }
    const idx = messages.indexOf(current);
    const userMsg =
      (current.requestId &&
        messages.find((m) => m?.role === 'user' && m.requestId === current.requestId)) ||
      (idx > 0 && messages[idx - 1]?.role === 'user' ? messages[idx - 1] : null);
    const asked = normalizeQuestion(userMsg?.text);
    if (asked) {
      for (const area of template.areas || []) {
        for (const step of area.steps || []) {
          if (!briefingRequired(step)) continue;
          if (
            (step.askAlya && normalizeQuestion(step.askAlya) === asked) ||
            normalizeQuestion(step.title) === asked
          ) {
            return step.id;
          }
        }
      }
    }
    const nextId = current.reexplainOf ?? current.result?.reexplainOf ?? null;
    current = typeof nextId === 'string' ? byId.get(nextId) : null;
  }
  return null;
}
