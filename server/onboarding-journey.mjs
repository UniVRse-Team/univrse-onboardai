import { randomInt } from 'node:crypto';
import { journeyErrors } from './account-errors.mjs';
import { ChatError } from './chat-errors.mjs';
import { createStorageCall } from './firestore-client.mjs';
import { asProfileStorageError } from './employee-profiles.mjs';
import { journeyCollections, quickQuestionsDoc } from './onboarding-collections.mjs';
import {
  builtInQuickQuestions,
  builtInTemplate,
  stepQuestions,
  templateVersion,
  trackOf,
} from './onboarding-content.mjs';
import {
  AI_READINESS_STEP_ID,
  aiLearningPaths,
  aiLevelsList,
  applyAiAssessment,
  applyAiTrainingCompleted,
  applyAiTrainingReopened,
  assertAiProficiencyAccess,
  normalizeAiProficiency,
  presentAiProficiency,
  validateAiAssessmentInput,
} from './ai-proficiency.mjs';
import { DEFAULT_COMPANY_ID } from './companies.mjs';
import {
  StepRuleError,
  briefedAt,
  briefingCompletions,
  buildOnboarding,
  companyDay,
  employeeComplete,
  employeeReopen,
  findStep,
  hrSetStatus,
  needsBriefing,
  needsDocument,
  progressEntry,
  selectChips,
  stepForHelpfulMessage,
  stepRecord,
  taskChips,
  validChips,
  validTemplate,
} from './onboarding-progress.mjs';

// The onboarding footprint (issue #47), quick-question chips and first-day
// details (issue #50) for signed-in employee accounts. Firestore layout
// (docs/onboarding-journey.md):
//
//   onboardingTemplates/{track}    the template per track (built-in fallback)
//   onboardingProgress/{accountId} { accountId, updatedAt, steps: { [stepId]: entry } }
//   config/quickQuestions          { employee: [Chip], intern: [...], contractor: [...] }
//   employeeFirstDay/{accountId}   the details HR enters for day 1
//
// Only the employee's own completions, HR verifications and (F5) Alya's
// confirmed actions change progress. Answer style, feedback, support requests
// and check attempts never do, and wrong check answers are not stored. A
// written check answer is never stored or logged at all, right or wrong.
//
// Briefings (contract v1.5): a required step with a briefing needs it first.
// POST .../briefing stores briefedAt and briefedBy ("listened" | "read") in
// the step's progress record, which keeps them when the step is reopened. The
// server records what the employee confirmed; it cannot prove listening.
// `accounts` is the account service: profiles (track, start date) come from it,
// and every HR change writes its account_events row through it.
export const firstDayLimits = Object.freeze({
  location: 120,
  hostName: 80,
  hostContact: 120,
  notes: 300,
});
export const personalSource = 'Your first-day details from HR';
const arrivalPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const singleLineControl = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const notesControl = /[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029]/;
const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const ruleErrors = {
  BRIEFING_REQUIRED: journeyErrors.briefingRequired,
  CHECK_REQUIRED: journeyErrors.checkRequired,
  STEP_LOCKED: journeyErrors.stepLocked,
  STEP_NOT_HR_VERIFIED: journeyErrors.stepNotHrVerified,
};

// PUT /api/hr/employees/:id/first-day: a full replacement. Returns the stored
// fields or throws 400 FIRST_DAY_INVALID with details.fields.
export function validateFirstDay(body) {
  if (!isPlainObject(body)) throw journeyErrors.firstDayInvalid([]);
  const problems = [];
  const keys = ['location', 'arrivalTime', 'hostName', 'hostContact', 'notes'];
  for (const key of Object.keys(body))
    if (!keys.includes(key)) problems.push({ field: key, problem: 'unknown' });
  const value = {};
  for (const key of keys) {
    const raw = body[key];
    const required = ['location', 'arrivalTime', 'hostName'].includes(key);
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
      if (required) problems.push({ field: key, problem: 'required' });
      else value[key] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      problems.push({ field: key, problem: 'not_text' });
      continue;
    }
    const text = key === 'notes' ? raw.replace(/\r\n?/g, '\n').trim() : raw.trim();
    if ((key === 'notes' ? notesControl : singleLineControl).test(text))
      problems.push({ field: key, problem: 'invalid_characters' });
    else if (key === 'arrivalTime') {
      if (!arrivalPattern.test(text)) problems.push({ field: key, problem: 'invalid_time' });
      else value[key] = text;
    } else if ([...text].length > firstDayLimits[key])
      problems.push({ field: key, problem: 'too_long' });
    else value[key] = text;
  }
  if (problems.length) throw journeyErrors.firstDayInvalid(problems);
  return value;
}
export const presentFirstDay = (data) =>
  data
    ? {
        location: data.location,
        arrivalTime: data.arrivalTime,
        hostName: data.hostName,
        hostContact: data.hostContact ?? null,
        notes: data.notes ?? null,
        updatedAt: data.updatedAt ?? null,
        updatedBy: data.updatedBy ?? null,
      }
    : null;

const longDate = (day) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));

// The answer to a personal chip, from the employee's first-day details and
// start date only, never from company documents. Coverage "none" when HR has
// not added the details yet.
export function personalReply(personal, firstDay, startDate) {
  const date = startDate ? longDate(startDate) : null;
  if (!firstDay) {
    const opening = date ? `Your first day is ${date}. ` : '';
    return {
      coverage: 'none',
      answer:
        opening +
        (personal === 'host'
          ? 'HR hasn’t added your first-day details yet, so I don’t know who will meet you. You can ask HR to follow up.'
          : 'HR hasn’t added your first-day details yet, so I can’t tell you where and when to report. You can ask HR to follow up.'),
    };
  }
  const where = `Please arrive at ${firstDay.location} by ${firstDay.arrivalTime}`;
  const parts =
    personal === 'host'
      ? [
          `${firstDay.hostName} will meet you on your first day${date ? `, ${date}` : ''}.`,
          firstDay.hostContact ? `You can reach them at ${firstDay.hostContact}.` : '',
          `${where}.`,
        ]
      : [
          date ? `Your first day is ${date}.` : '',
          `${where}${date ? '' : ' on your first day'}.`,
          `${firstDay.hostName} will meet you.`,
          firstDay.notes ? `A note from HR: ${firstDay.notes}` : '',
        ];
  return { coverage: 'full', answer: parts.filter(Boolean).join(' ') };
}

export function createOnboardingJourney({
  // A Firestore instance, or an async function returning one.
  firestore,
  accounts,
  now = () => new Date(),
  timeoutMs,
  log,
  // Templates and the chip config change rarely; each server keeps them this long.
  cacheMs = 60000,
  // The written-check grader (check-grader.mjs), or null without Gemini.
  grader = null,
  // (n) => an integer in [0, n), for shuffling choice options.
  random = (n) => randomInt(n),
}) {
  let client = null;
  const database = async () =>
    (client ??= await (typeof firestore === 'function' ? firestore() : firestore));
  const call = createStorageCall({ timeoutMs, log });
  const guarded = async (operation, fn) => {
    try {
      return await call(operation, fn);
    } catch (error) {
      throw asProfileStorageError(error);
    }
  };
  const progressRef = (db, accountId) => db.collection(journeyCollections.progress).doc(accountId);
  const firstDayRef = (db, accountId) => db.collection(journeyCollections.firstDay).doc(accountId);

  // Cached reads with the built-in fallback. A failed read is not cached.
  const cache = new Map();
  async function cached(key, read) {
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < cacheMs) return hit.value;
    const value = await read();
    cache.set(key, { at: now().getTime(), value });
    return value;
  }
  function template(track) {
    return cached(`template:${track}`, async () => {
      const snapshot = await guarded('read onboarding template', async () =>
        (await database()).collection(journeyCollections.templates).doc(track).get(),
      );
      const stored = snapshot.exists ? validTemplate(snapshot.data(), track) : null;
      if (snapshot.exists && !stored)
        log?.('Onboarding template is malformed; the built-in template is used.');
      // A template older than the built-in one (its migration has not run
      // yet) is replaced by it, so new content never waits for a migration.
      if (stored && stored.version < templateVersion) {
        log?.(
          `Onboarding template ${track} is version ${stored.version}; the built-in version ${templateVersion} is used until the migration updates it.`,
        );
        return builtInTemplate(track);
      }
      return stored || builtInTemplate(track);
    });
  }
  function chipConfig(track) {
    return cached(`chips:${track}`, async () => {
      const snapshot = await guarded('read quick questions', async () =>
        (await database()).collection(journeyCollections.config).doc(quickQuestionsDoc).get(),
      );
      return (
        (snapshot.exists && validChips(snapshot.data()?.[track])) || builtInQuickQuestions()[track]
      );
    });
  }
  const readProgress = (accountId) =>
    guarded('read onboarding progress', async () => {
      const snapshot = await progressRef(await database(), accountId).get();
      return snapshot.exists ? snapshot.data() : null;
    });
  const readFirstDay = (accountId) =>
    guarded('read first-day details', async () => {
      const snapshot = await firstDayRef(await database(), accountId).get();
      return snapshot.exists ? snapshot.data() : null;
    });

  // The employee's profile facts the journey needs.
  async function employeeFacts(account) {
    const profile = await accounts.myProfile(account);
    return { track: trackOf(profile), startDate: profile?.job.startDate || null, profile };
  }
  async function onboardingOf(accountId, track) {
    const [chosen, progress] = await Promise.all([template(track), readProgress(accountId)]);
    return { template: chosen, progress, onboarding: buildOnboarding(chosen, progress) };
  }

  // Documentation steps are finished by saving the required document, not by a click. The
  // submissions service binds `documentStatuses(accountId)` -> { [stepId]: status of
  // the step's latest submission } ('Pending Review' | 'Under Review' | 'Approved' |
  // 'Rejected'). Until it is bound (no document storage) nothing is derived.
  let documentStatuses = null;
  const documentStepIds = (chosen) =>
    chosen.areas
      .flatMap((area) => area.steps.map((step) => [area.id, step]))
      .filter(([areaId, step]) => needsDocument(areaId, step))
      .map(([, step]) => step.id);
  // For the employee a Documentation task is complete once its document has been
  // saved. HR reviews it separately; the review never changes the employee's progress.
  // A saved document completes its task. Without one nothing is changed, so an
  // employee's earlier saved progress is never reset by a read.
  const documentWanted = (latest, entry) => (latest ? 'done' : (entry?.status ?? null));
  // Brings the saved step statuses in line with the saved submissions. Idempotent;
  // run on every read and after every submission or review, so a failed earlier
  // write heals itself. A read failure never blocks the dashboard.
  async function reconcileDocuments(accountId, track) {
    if (!documentStatuses) return;
    let latest;
    try {
      latest = await documentStatuses(accountId);
    } catch (error) {
      log?.('Document statuses could not be read: ' + (error?.message || error));
      return;
    }
    const { template: chosen, progress } = await onboardingOf(accountId, track);
    for (const stepId of documentStepIds(chosen)) {
      const entry = progressEntry(progress, stepId);
      const want = documentWanted(latest[stepId], entry);
      if ((entry?.status || null) === want) continue;
      await changeStep(accountId, track, stepId, () => (want ? { status: want } : null), {
        source: 'employee',
        actorId: accountId,
      });
    }
  }
  async function syncDocuments(accountId) {
    const { track } = await employeeTrack(accountId);
    await reconcileDocuments(accountId, track);
  }
  const documentStepGuard = async (track, stepId) => {
    const found = findStep(await template(track), stepId);
    return found && needsDocument(found.area.id, found.step);
  };

  // Changes one step in a transaction. change(step, entry, record) returns the
  // new entry (null = todo) or throws a StepRuleError; `record` is the step's
  // whole stored record. Unchanged steps are not written. The briefing fields
  // stay, whatever the status becomes.
  async function changeStep(accountId, track, stepId, change, { source, actorId }) {
    const chosen = await template(track);
    const found = findStep(chosen, stepId);
    if (!found) throw journeyErrors.stepNotFound();
    const progress = await guarded('save onboarding progress', async () => {
      const db = await database(),
        ref = progressRef(db, accountId);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const current = snapshot.exists ? snapshot.data() : { accountId, steps: {} };
        const entry = progressEntry(current, stepId);
        const record = stepRecord(current, stepId);
        let next;
        try {
          next = change(found.step, entry, record);
        } catch (error) {
          // A ChatError passes through the storage call unchanged.
          if (error instanceof StepRuleError) throw ruleErrors[error.rule]();
          throw error;
        }
        if (next === entry || (!next && !entry)) return current;
        const at = now().toISOString();
        const steps = { ...(current.steps || {}) };
        const briefing = briefedAt(record)
          ? { briefedAt: record.briefedAt, briefedBy: record.briefedBy ?? null }
          : {};
        if (next)
          steps[stepId] = { status: next.status, updatedAt: at, source, actorId, ...briefing };
        else if (briefing.briefedAt) steps[stepId] = briefing;
        else delete steps[stepId];
        let aiProficiency = current.aiProficiency;
        if (stepId === AI_READINESS_STEP_ID) {
          const base = normalizeAiProficiency(current.aiProficiency, record);
          aiProficiency =
            next?.status === 'done'
              ? applyAiTrainingCompleted(base, at)
              : applyAiTrainingReopened(base, at);
        }
        const updated = {
          accountId,
          updatedAt: at,
          steps,
          ...(aiProficiency !== undefined ? { aiProficiency } : {}),
        };
        tx.set(ref, updated);
        return updated;
      });
    });
    return buildOnboarding(chosen, progress);
  }

  // --- Employee ---------------------------------------------------------------
  async function myOnboarding(account) {
    const { track } = await employeeFacts(account);
    await reconcileDocuments(account.id, track);
    return (await onboardingOf(account.id, track)).onboarding;
  }
  const documentRequired = () =>
    new ChatError(
      409,
      'DOCUMENT_REQUIRED',
      'Upload your document to complete this task. It cannot be marked complete without saving it.',
    );
  async function completeStep(account, stepId) {
    const { track } = await employeeFacts(account);
    if (await documentStepGuard(track, stepId)) throw documentRequired();
    return changeStep(account.id, track, stepId, employeeComplete, {
      source: 'employee',
      actorId: account.id,
    });
  }
  async function reopenStep(account, stepId) {
    const { track } = await employeeFacts(account);
    if (await documentStepGuard(track, stepId)) throw documentRequired();
    return changeStep(account.id, track, stepId, employeeReopen, {
      source: 'employee',
      actorId: account.id,
    });
  }
  async function myAiProficiency(account, query = {}) {
    assertAiProficiencyAccess(account, query);
    const progress = await readProgress(account.id);
    return {
      aiProficiency: presentAiProficiency(
        progress?.aiProficiency,
        stepRecord(progress, AI_READINESS_STEP_ID),
      ),
      levels: aiLevelsList,
      learningPaths: aiLearningPaths,
    };
  }
  async function saveAiProficiency(account, body, query = {}) {
    assertAiProficiencyAccess(account, query);
    const validated = validateAiAssessmentInput(body, account);
    const { track } = await employeeFacts(account);
    const chosen = await template(track);
    const progress = await guarded('save ai proficiency', async () => {
      const db = await database(),
        ref = progressRef(db, account.id);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const current = snapshot.exists ? snapshot.data() : { accountId: account.id, steps: {} };
        const at = now().toISOString();
        const record = stepRecord(current, AI_READINESS_STEP_ID);
        const base = normalizeAiProficiency(current.aiProficiency, record);
        const aiProficiency = applyAiAssessment(base, validated, at);
        const steps = { ...(current.steps || {}) };
        if (aiProficiency.trainingCompleted) {
          steps[AI_READINESS_STEP_ID] = {
            ...(record || {}),
            status: 'done',
            updatedAt: record?.updatedAt || aiProficiency.trainingCompletedAt || at,
            source: record?.source || 'employee',
            actorId: record?.actorId || account.id,
          };
        } else if (record?.briefedAt) {
          steps[AI_READINESS_STEP_ID] = {
            briefedAt: record.briefedAt,
            briefedBy: record.briefedBy ?? null,
          };
        } else {
          delete steps[AI_READINESS_STEP_ID];
        }
        const updated = {
          accountId: account.id,
          updatedAt: at,
          steps,
          aiProficiency,
        };
        tx.set(ref, updated);
        return updated;
      });
    });
    const onboarding = buildOnboarding(chosen, progress);
    return {
      aiProficiency: onboarding.aiProficiency,
      levels: aiLevelsList,
      learningPaths: aiLearningPaths,
      onboarding,
    };
  }
  async function completeAiTraining(account, body = {}, query = {}) {
    assertAiProficiencyAccess(account, query);
    if (isPlainObject(body)) {
      assertAiProficiencyAccess(account, body);
      const allowedKeys = new Set(['userId', 'accountId', 'companyId', 'practiceNote']);
      for (const key of Object.keys(body)) {
        if (!allowedKeys.has(key)) throw journeyErrors.aiProficiencyInvalid();
      }
      if (
        body.practiceNote !== undefined &&
        body.practiceNote !== null &&
        (typeof body.practiceNote !== 'string' || body.practiceNote.length > 2000)
      ) {
        throw journeyErrors.aiProficiencyInvalid();
      }
    } else if (body !== undefined && body !== null) {
      throw journeyErrors.aiProficiencyInvalid();
    }
    const { track } = await employeeFacts(account);
    const chosen = await template(track);
    const progress = await guarded('complete ai training', async () => {
      const db = await database(),
        ref = progressRef(db, account.id);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const current = snapshot.exists ? snapshot.data() : { accountId: account.id, steps: {} };
        const at = now().toISOString();
        const record = stepRecord(current, AI_READINESS_STEP_ID);
        const base = normalizeAiProficiency(current.aiProficiency, record);
        const aiProficiency = applyAiTrainingCompleted(base, at);
        const briefing = briefedAt(record)
          ? { briefedAt: record.briefedAt, briefedBy: record.briefedBy ?? null }
          : { briefedAt: at, briefedBy: 'read' };
        const steps = {
          ...(current.steps || {}),
          [AI_READINESS_STEP_ID]: {
            ...briefing,
            status: 'done',
            updatedAt: aiProficiency.trainingCompletedAt || at,
            source: record?.source || 'employee',
            actorId: account.id,
          },
        };
        const updated = {
          accountId: account.id,
          updatedAt: at,
          steps,
          aiProficiency,
        };
        tx.set(ref, updated);
        return updated;
      });
    });
    const onboarding = buildOnboarding(chosen, progress);
    return {
      aiProficiency: onboarding.aiProficiency,
      levels: aiLevelsList,
      learningPaths: aiLearningPaths,
      onboarding,
    };
  }
  // The step's check, with the briefing gate: a required step with a
  // briefing needs it before its check is shown or answered, unless the
  // check is already passed.
  async function checkFor(account, stepId) {
    const { track } = await employeeFacts(account);
    const { template: chosen, progress } = await onboardingOf(account.id, track);
    const found = findStep(chosen, stepId);
    if (!found) throw journeyErrors.stepNotFound();
    if (!found.step.check) throw journeyErrors.checkNotFound();
    const passed = progressEntry(progress, stepId)?.status === 'done';
    if (!passed && needsBriefing(found.step, stepRecord(progress, stepId)))
      throw journeyErrors.briefingRequired();
    return { track, check: found.step.check };
  }
  // A new order of the options on every call (Fisher-Yates).
  function shuffled(options) {
    const out = options.map(({ id, text }) => ({ id, text }));
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = random(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  // The scenario without its answer: never correctOptionId, keyPoints, mustNot,
  // modelAnswer or explanation.
  async function checkQuestion(account, stepId) {
    const { check } = await checkFor(account, stepId);
    if (check.type === 'written')
      return {
        stepId,
        type: 'written',
        scenario: check.scenario,
        sourceTitle: check.sourceTitle,
        maxLength: check.maxLength,
      };
    return {
      stepId,
      type: 'choice',
      scenario: check.scenario,
      options: shuffled(check.options),
      sourceTitle: check.sourceTitle,
    };
  }
  const markPassed = (account, track, stepId) =>
    changeStep(
      account.id,
      track,
      stepId,
      (step, entry) => (entry?.status === 'done' ? entry : { status: 'done' }),
      { source: 'employee', actorId: account.id },
    );
  // A correct answer marks the step done; a wrong one changes and stores
  // nothing. Choice: { optionId } -> { correct, explanation, onboarding }.
  // Written: { answer } -> { correct, feedback, explanation|null, onboarding };
  // the answer is graded and dropped, never stored or logged.
  async function answerCheck(account, stepId, body) {
    const { track, check } = await checkFor(account, stepId);
    const fields = isPlainObject(body) ? Object.keys(body) : null;
    if (check.type === 'written') {
      const answer = fields && fields.length === 1 ? body.answer : undefined;
      if (typeof answer !== 'string' || !answer.trim() || [...answer].length > check.maxLength)
        throw journeyErrors.checkAnswerInvalid(check);
      if (!grader) throw journeyErrors.checkGraderUnavailable();
      let graded;
      try {
        graded = await grader.grade(check, answer.trim());
      } catch {
        throw journeyErrors.checkGraderUnavailable();
      }
      const onboarding = graded.correct
        ? await markPassed(account, track, stepId)
        : (await onboardingOf(account.id, track)).onboarding;
      return {
        correct: graded.correct,
        feedback: graded.feedback,
        explanation: graded.correct ? check.explanation : null,
        onboarding,
      };
    }
    const optionId = fields && fields.length === 1 ? body.optionId : undefined;
    if (typeof optionId !== 'string' || !check.options.some((o) => o.id === optionId))
      throw journeyErrors.checkAnswerInvalid(check);
    const correct = optionId === check.correctOptionId;
    const onboarding = correct
      ? await markPassed(account, track, stepId)
      : (await onboardingOf(account.id, track)).onboarding;
    return { correct, explanation: check.explanation, onboarding };
  }
  // POST .../briefing { completion: "listened" | "read" }: records the
  // briefing once; the first briefedAt and briefedBy are kept.
  async function recordBriefing(account, stepId, body) {
    const completion = isPlainObject(body) ? body.completion : undefined;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some((key) => key !== 'completion') ||
      !briefingCompletions.includes(completion)
    )
      throw journeyErrors.briefingCompletionInvalid();
    const { track } = await employeeFacts(account);
    const chosen = await template(track);
    const found = findStep(chosen, stepId);
    if (!found) throw journeyErrors.stepNotFound();
    if (!found.step.briefing || found.step.required === false)
      throw journeyErrors.briefingNotFound();
    const progress = await guarded('save onboarding progress', async () => {
      const db = await database(),
        ref = progressRef(db, account.id);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const current = snapshot.exists ? snapshot.data() : { accountId: account.id, steps: {} };
        const record = stepRecord(current, stepId);
        if (briefedAt(record)) return current;
        const at = now().toISOString();
        const updated = {
          accountId: account.id,
          updatedAt: at,
          steps: {
            ...(current.steps || {}),
            [stepId]: { ...(record || {}), briefedAt: at, briefedBy: completion },
          },
          ...(current.aiProficiency !== undefined ? { aiProficiency: current.aiProficiency } : {}),
        };
        tx.set(ref, updated);
        return updated;
      });
    });
    return buildOnboarding(chosen, progress);
  }
  // When an employee marks a step's answer (or its re-explanation) helpful,
  // they already understand that concept, so the step's briefing is recorded.
  async function recordHelpfulAnswer(account, messages, messageId) {
    const { track } = await employeeFacts(account);
    const chosen = await template(track);
    const stepId = stepForHelpfulMessage(chosen, messages, messageId);
    if (!stepId) return null;
    return recordBriefing(account, stepId, { completion: 'helpful' });
  }
  // Whether this employee still needs the step's briefing (F5 approvals).
  async function briefingNeeded(account, stepId) {
    const { track } = await employeeFacts(account);
    const { template: chosen, progress } = await onboardingOf(account.id, track);
    const found = findStep(chosen, stepId);
    if (!found) return false;
    if (progressEntry(progress, stepId)) return false;
    return needsBriefing(found.step, stepRecord(progress, stepId));
  }
  async function requireBriefed(account, stepId) {
    if (await briefingNeeded(account, stepId)) throw journeyErrors.briefingRequired();
  }
  async function quickQuestions(account, { stepId = null } = {}) {
    const { track, startDate } = await employeeFacts(account);
    // Asked from a task: that task's questions, not the overall next step's.
    if (typeof stepId === 'string' && stepId && stepId.length <= 120) {
      const forTask = taskChips({
        template: await template(track),
        stepId,
        questions: stepQuestions[stepId] || [],
      });
      if (forTask) return { chips: forTask };
    }
    const [{ onboarding }, chips] = await Promise.all([
      onboardingOf(account.id, track),
      chipConfig(track),
    ]);
    return { chips: selectChips({ onboarding, chips, startDate, today: companyDay(now()) }) };
  }
  // The chip a chat turn names, or null when it is not one of this employee's:
  // a "step:<stepId>" chip for a step of their template, or a configured chip.
  async function resolveChip(account, chipId) {
    if (typeof chipId !== 'string' || !chipId || chipId.length > 120) return null;
    const { track } = await employeeFacts(account);
    if (chipId.startsWith('step:')) {
      // "step:<id>" is the task's own question, "step:<id>#2" a related one.
      const found = findStep(await template(track), chipId.slice(5).split('#')[0]);
      return found ? { id: chipId, kind: 'knowledge', stepId: found.step.id } : null;
    }
    const chip = (await chipConfig(track)).find((c) => c.id === chipId);
    return chip ? { ...chip, stepId: null } : null;
  }
  async function myFirstDay(account) {
    const [{ startDate }, firstDay] = await Promise.all([
      employeeFacts(account),
      readFirstDay(account.id),
    ]);
    return { firstDay: presentFirstDay(firstDay), startDate };
  }
  async function personalAnswer(account, chip) {
    const [{ startDate }, firstDay] = await Promise.all([
      employeeFacts(account),
      readFirstDay(account.id),
    ]);
    return personalReply(chip.personal, firstDay, startDate);
  }
  async function trackFor(account) {
    return (await employeeFacts(account)).track;
  }

  // --- HR -----------------------------------------------------------------------
  async function employeeTrack(id, actor = null) {
    const { profile } = await accounts.getEmployee(actor, id);
    return { track: trackOf(profile), startDate: profile?.job.startDate || null };
  }
  async function employeeOnboarding(id, actor = null) {
    const { track } = await employeeTrack(id, actor);
    await reconcileDocuments(id, track);
    return (await onboardingOf(id, track)).onboarding;
  }
  async function employeeAiProficiency(id, actor = null, query = {}) {
    const actorCompany = actor?.account?.companyId || DEFAULT_COMPANY_ID;
    if (query?.companyId && String(query.companyId) !== actorCompany) {
      throw journeyErrors.aiProficiencyForbidden();
    }
    await accounts.getEmployee(actor, id);
    const progress = await readProgress(id);
    return {
      aiProficiency: presentAiProficiency(
        progress?.aiProficiency,
        stepRecord(progress, AI_READINESS_STEP_ID),
      ),
      levels: aiLevelsList,
      learningPaths: aiLearningPaths,
    };
  }
  // PATCH .../onboarding/steps/:stepId { status: "done" | "todo" }.
  async function setEmployeeStep(actor, id, stepId, body) {
    const status = isPlainObject(body) ? body.status : undefined;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some((key) => key !== 'status') ||
      !['done', 'todo'].includes(status)
    )
      throw journeyErrors.stepStatusInvalid();
    const { track } = await employeeTrack(id, actor);
    const found = findStep(await template(track), stepId);
    if (!found) throw journeyErrors.stepNotFound();
    if (found.step.completion !== 'hr_verify') throw journeyErrors.stepNotHrVerified();
    // A document step follows the employee's saved submission; HR cannot un-submit it.
    if (needsDocument(found.area.id, found.step) && status === 'todo' && documentStatuses) {
      if ((await documentStatuses(id))[stepId])
        throw new ChatError(
          409,
          'DOCUMENT_SUBMITTED',
          'The employee has submitted this document, so the step stays complete. Review the document in Submissions.',
        );
    }
    return accounts.recordEmployeeChange(
      actor,
      id,
      'onboarding_step_verified',
      () =>
        changeStep(id, track, stepId, (step, entry) => hrSetStatus(step, entry, status), {
          source: 'hr',
          actorId: actor.account.id,
        }),
      { stepId, status },
    );
  }
  async function employeeFirstDay(id, actor = null) {
    const { startDate } = await employeeTrack(id, actor);
    return { firstDay: presentFirstDay(await readFirstDay(id)), startDate };
  }
  async function putEmployeeFirstDay(actor, id, body) {
    const value = validateFirstDay(body);
    await accounts.getEmployee(actor, id);
    const stored = { ...value, updatedAt: now().toISOString(), updatedBy: actor.account.id };
    await accounts.recordEmployeeChange(actor, id, 'first_day_updated', () =>
      guarded('save first-day details', async () => {
        await firstDayRef(await database(), id).set(stored);
      }),
    );
    return { firstDay: presentFirstDay(stored) };
  }
  // GET /api/hr/employees: adds onboarding { percent, waitingOnHr, complete } to each
  // item of accounts.listEmployees() (which carries the track).
  async function withOnboarding(list) {
    const progress = new Map();
    for (let i = 0; i < list.length; i += 100) {
      const ids = list.slice(i, i + 100).map((item) => item.account.id);
      if (!ids.length) continue;
      const snapshots = await guarded('read onboarding progress', async () => {
        const db = await database();
        return db.getAll(...ids.map((id) => progressRef(db, id)));
      });
      for (const snapshot of snapshots)
        if (snapshot.exists) progress.set(snapshot.id, snapshot.data());
    }
    const out = [];
    for (const item of list) {
      const view = buildOnboarding(await template(item.track), progress.get(item.account.id));
      out.push({
        ...item,
        onboarding: {
          percent: view.percent,
          waitingOnHr: view.waitingOnHr,
          complete: view.complete,
        },
      });
    }
    return out;
  }

  return {
    template,
    myOnboarding,
    completeStep,
    reopenStep,
    myAiProficiency,
    saveAiProficiency,
    completeAiTraining,
    checkQuestion,
    answerCheck,
    recordBriefing,
    recordHelpfulAnswer,
    briefingNeeded,
    requireBriefed,
    quickQuestions,
    resolveChip,
    myFirstDay,
    personalAnswer,
    trackFor,
    employeeOnboarding,
    employeeAiProficiency,
    setEmployeeStep,
    employeeFirstDay,
    putEmployeeFirstDay,
    withOnboarding,
    bindDocumentStatuses: (fn) => {
      documentStatuses = fn;
    },
    syncDocuments,
    // The shared Firestore handle (also used by the task-verification store).
    firestore: database,
    // A passed verification (quiz, matching) marks the step done for the employee.
    verifyStep: async (account, stepId) =>
      markPassed(account, (await employeeFacts(account)).track, stepId),
    // An authorised coordinator confirms an employee's tool access.
    verifyEmployeeStep: async (actor, id, stepId) => {
      const { track } = await employeeTrack(id, actor);
      if (!findStep(await template(track), stepId)) throw journeyErrors.stepNotFound();
      return accounts.recordEmployeeChange(
        actor,
        id,
        'onboarding_step_verified',
        () =>
          changeStep(
            id,
            track,
            stepId,
            (step, entry) => (entry?.status === 'done' ? entry : { status: 'done' }),
            { source: 'hr', actorId: actor.account.id },
          ),
        { stepId, status: 'done' },
      );
    },
  };
}
