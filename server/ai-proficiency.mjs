import { journeyErrors } from './account-errors.mjs';

// AI Proficiency Self-Assessment & Micro-Training (Area 4: role-tools).
// Persisted inside onboardingProgress/{accountId}.aiProficiency and synced
// with onboardingProgress.steps['role-tools.ai-readiness-training'].
export const AI_READINESS_STEP_ID = 'role-tools.ai-readiness-training';
export { DEFAULT_COMPANY_ID } from './companies.mjs';

export const aiProficiencyStatuses = Object.freeze([
  'unanswered',
  'assessed',
  'not_sure',
  'skipped',
]);

export const aiLearningPathIds = Object.freeze(['beginner', 'intermediate', 'advanced']);

export const aiLevelDescriptions = Object.freeze({
  1: 'Never used AI',
  2: 'Tried basic questions',
  3: 'Use AI for drafts or summaries',
  4: 'Give clear context and refine prompts',
  5: 'Check AI answers for errors',
  6: 'Use approved AI regularly at work',
  7: 'Create multi-step AI workflows',
  8: 'Build simple automations',
  9: 'Integrate AI tools and evaluate results',
  10: 'Design, evaluate and teach AI workflows',
});

export const aiLevelsList = Object.freeze(
  Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    return Object.freeze({
      level,
      description: aiLevelDescriptions[level],
      learningPathId: level <= 3 ? 'beginner' : level <= 6 ? 'intermediate' : 'advanced',
    });
  }),
);

export const aiLearningPaths = Object.freeze({
  beginner: Object.freeze({
    id: 'beginner',
    title: 'Basics, Beginner Intro & Safe Use',
    focus:
      'Safe daily usage, protecting confidential/company data, and basic drafting/summarization prompts.',
    practiceTask:
      'Write a simple prompt to summarize a public meeting note or draft a routine message while verifying no confidential company or personal data is included.',
  }),
  intermediate: Object.freeze({
    id: 'intermediate',
    title: 'Better Prompts & Checking Results',
    focus:
      'Structuring context, constraints, and verifying outputs for accuracy or hallucinations.',
    practiceTask:
      'Refine a vague prompt by adding role context, formatting constraints, and a verification checklist to spot potential errors in the AI’s draft.',
  }),
  advanced: Object.freeze({
    id: 'advanced',
    title: 'Workflows, Automation & Responsible Integration',
    focus: 'Multi-step task chaining, evaluation criteria, and responsible workflow integration.',
    practiceTask:
      'Outline a multi-step AI workflow for a recurring role task, specifying human-in-the-loop review gates and data privacy safeguards.',
  }),
});

const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function isValidAiLevel(level) {
  return Number.isInteger(level) && level >= 1 && level <= 10;
}

// Deterministic path mapping:
// - Levels 1-3, 'not_sure', 'skipped', or 'unanswered' -> 'beginner'
// - Levels 4-6 -> 'intermediate'
// - Levels 7-10 -> 'advanced'
export function learningPathFor(status, level) {
  if (status === 'assessed' && isValidAiLevel(level)) {
    if (level <= 3) return 'beginner';
    if (level <= 6) return 'intermediate';
    return 'advanced';
  }
  return 'beginner';
}

// Normalizes a stored aiProficiency object (or undefined/null) into the
// canonical schema stored on onboardingProgress/{userId}.aiProficiency.
export function normalizeAiProficiency(raw, stepEntry = null) {
  if (!isPlainObject(raw)) {
    const stepDone = stepEntry?.status === 'done';
    const stepAt = typeof stepEntry?.updatedAt === 'string' ? stepEntry.updatedAt : null;
    return {
      status: 'unanswered',
      level: null,
      learningPathId: 'beginner',
      assessedAt: null,
      updatedAt: stepDone ? stepAt : null,
      trainingCompleted: stepDone,
      trainingCompletedAt: stepDone ? stepAt : null,
    };
  }
  const status = aiProficiencyStatuses.includes(raw.status) ? raw.status : 'unanswered';
  const level = status === 'assessed' && isValidAiLevel(raw.level) ? raw.level : null;
  const normalizedStatus = status === 'assessed' && level === null ? 'unanswered' : status;
  const learningPathId = aiLearningPathIds.includes(raw.learningPathId)
    ? raw.learningPathId
    : learningPathFor(normalizedStatus, level);
  const assessedAt =
    normalizedStatus === 'skipped' || normalizedStatus === 'unanswered'
      ? null
      : typeof raw.assessedAt === 'string' && raw.assessedAt
        ? raw.assessedAt
        : null;
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : null;
  const trainingCompleted = raw.trainingCompleted === true;
  const trainingCompletedAt =
    trainingCompleted && typeof raw.trainingCompletedAt === 'string' && raw.trainingCompletedAt
      ? raw.trainingCompletedAt
      : null;
  return {
    status: normalizedStatus,
    level,
    learningPathId,
    assessedAt,
    updatedAt,
    trainingCompleted,
    trainingCompletedAt,
  };
}

// Enriches the stored record with levelDescription, learningPath, and practiceTask
// for API responses and frontend integration.
export function presentAiProficiency(raw, stepEntry = null) {
  const record = normalizeAiProficiency(raw, stepEntry);
  const path = aiLearningPaths[record.learningPathId] || aiLearningPaths.beginner;
  return {
    ...record,
    levelDescription: record.level !== null ? aiLevelDescriptions[record.level] : null,
    learningPath: { ...path },
    practiceTask: path.practiceTask,
  };
}

// Validates tenant and user isolation (companyId + authenticated userId).
export function assertAiProficiencyAccess(account, target = {}) {
  if (!account?.id) throw journeyErrors.aiProficiencyForbidden();
  const accountCompany = account.companyId || DEFAULT_COMPANY_ID;
  if (
    target.userId !== undefined &&
    target.userId !== null &&
    String(target.userId) !== account.id
  ) {
    throw journeyErrors.aiProficiencyForbidden();
  }
  if (
    target.accountId !== undefined &&
    target.accountId !== null &&
    String(target.accountId) !== account.id
  ) {
    throw journeyErrors.aiProficiencyForbidden();
  }
  if (
    target.companyId !== undefined &&
    target.companyId !== null &&
    String(target.companyId) !== accountCompany
  ) {
    throw journeyErrors.aiProficiencyForbidden();
  }
}

// Validates PUT /api/me/ai-proficiency request body.
// Accepted shapes:
//   { status: 'assessed', level: 1..10 } (or { level: 1..10 })
//   { status: 'not_sure', level?: null }
//   { status: 'skipped', level?: null }
export function validateAiAssessmentInput(body, account = null) {
  if (!isPlainObject(body)) throw journeyErrors.aiProficiencyInvalid();
  if (account) assertAiProficiencyAccess(account, body);
  const allowedKeys = new Set(['status', 'level', 'userId', 'accountId', 'companyId']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) throw journeyErrors.aiProficiencyInvalid();
  }
  const status = body.status === undefined && isValidAiLevel(body.level) ? 'assessed' : body.status;
  if (!['assessed', 'not_sure', 'skipped'].includes(status)) {
    throw journeyErrors.aiProficiencyInvalid();
  }
  if (status === 'assessed') {
    if (!isValidAiLevel(body.level)) throw journeyErrors.aiProficiencyInvalid();
    return { status: 'assessed', level: body.level };
  }
  if (body.level !== undefined && body.level !== null) {
    throw journeyErrors.aiProficiencyInvalid();
  }
  return { status, level: null };
}

// Applies a self-assessment update ('assessed', 'not_sure', or 'skipped').
// Non-Destructive Editing: preserves trainingCompleted and trainingCompletedAt
// if trainingCompleted was already true. Never sets trainingCompleted = true
// from a rating alone.
export function applyAiAssessment(currentRaw, validatedInput, atIso) {
  const current = normalizeAiProficiency(currentRaw);
  const { status, level } = validatedInput;
  const learningPathId = learningPathFor(status, level);
  const assessedAt = status === 'skipped' ? null : atIso;
  return {
    status,
    level: status === 'assessed' ? level : null,
    learningPathId,
    assessedAt,
    updatedAt: atIso,
    trainingCompleted: current.trainingCompleted,
    trainingCompletedAt: current.trainingCompleted ? current.trainingCompletedAt || atIso : null,
  };
}

// Marks the AI micro-practice task completed.
export function applyAiTrainingCompleted(currentRaw, atIso) {
  const current = normalizeAiProficiency(currentRaw);
  return {
    status: current.status,
    level: current.level,
    learningPathId: current.learningPathId || 'beginner',
    assessedAt: current.assessedAt,
    updatedAt: atIso,
    trainingCompleted: true,
    trainingCompletedAt: current.trainingCompletedAt || atIso,
  };
}

// Reopens the AI practice task while preserving the self-assessment rating.
export function applyAiTrainingReopened(currentRaw, atIso) {
  const current = normalizeAiProficiency(currentRaw);
  return {
    status: current.status,
    level: current.level,
    learningPathId: current.learningPathId || 'beginner',
    assessedAt: current.assessedAt,
    updatedAt: atIso,
    trainingCompleted: false,
    trainingCompletedAt: null,
  };
}

// Alya's spoken/written reply when an employee saves or updates their AI
// self-assessment.
export function alyaAssessmentReply(raw) {
  const view = presentAiProficiency(raw);
  const path = view.learningPath;
  const opening =
    view.status === 'assessed' && view.level !== null
      ? `I have recorded your AI proficiency at level ${view.level} (${view.levelDescription}).`
      : view.status === 'not_sure'
        ? 'No problem at all—I have noted that you are not sure of your AI level yet.'
        : 'I have noted that you skipped the AI proficiency rating.';
  const completionNote = view.trainingCompleted
    ? 'Your AI Readiness step remains completed on your checklist.'
    : 'Once you finish this practice task, let me know or mark the step as completed to earn full credit.';
  return (
    `${opening} Your recommended learning path is ${path.title}, which focuses on ${path.focus.charAt(0).toLowerCase() + path.focus.slice(1)} ` +
    `Practice task: ${path.practiceTask} ${completionNote}`
  );
}

// Detects when an employee tells Alya in chat that they set or skipped their
// AI proficiency self-assessment (as opposed to completing the practice task).
// Returns { status: 'assessed' | 'not_sure' | 'skipped', level: number | null } or null.
export function parseChatAiAssessment(question) {
  const text = String(question || '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .trim();
  if (!text || text.length > 220 || /\?\s*$/.test(text)) return null;
  if (/^(how|what|where|when|who|which|why|can|could|should|shall|do|does|did|is|are)\b/.test(text))
    return null;
  if (!/\bai\b/.test(text)) return null;
  // Do not match statements about finishing the practice task / training exercise.
  if (
    /\b(practice\s+task|practice\s+exercise|training\s+exercise|micro[-\s]?practice)\b/.test(text)
  )
    return null;

  if (
    /\b(skip|skipped|skipping)\b.*\b(ai\b.*(assessment|proficiency|rating|level)|assessment|rating)\b/.test(
      text,
    ) ||
    /\b(ai\b.*(assessment|proficiency|rating|level))\b.*\b(skip|skipped)\b/.test(text)
  ) {
    return { status: 'skipped', level: null };
  }

  if (
    /\b(not\s+sure|unsure)\b.*\b(ai\b.*(proficiency|level|assessment|rating|experience))\b/.test(
      text,
    ) ||
    /\b(ai\b.*(proficiency|level|assessment|rating|experience))\b.*\b(not\s+sure|unsure)\b/.test(
      text,
    )
  ) {
    return { status: 'not_sure', level: null };
  }

  const levelMatch =
    text.match(
      /\b(?:ai\s+(?:proficiency|experience|skill|level|rating|assessment)|proficiency\s+level)\b[^0-9]{0,25}\b(?:level\s*)?(10|[1-9])\b/,
    ) ||
    text.match(
      /\b(?:set|rated|rate|chose|choose|picked|select|selected)\b[^.!?]{0,30}\bai\b[^0-9]{0,25}\b(?:level\s*)?(10|[1-9])\b/,
    ) ||
    text.match(/\b(?:level\s*)(10|[1-9])\b[^.!?]{0,25}\bai\s+(?:proficiency|assessment|rating)\b/);
  if (levelMatch) {
    const level = Number(levelMatch[1]);
    if (isValidAiLevel(level)) return { status: 'assessed', level };
  }
  return null;
}
