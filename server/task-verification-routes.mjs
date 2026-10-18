import { ChatError } from './chat-errors.mjs';
import { contentPackOf } from './companies.mjs';
import {
  ALIGNMENT_ACTIVITIES,
  APPROVED_HANDBOOK_METADATA,
  CONTENT_REQUIREMENTS,
  TOOL_ACCESS_STEP_IDS,
  alignmentPassingScore,
  answerFeedback,
  gradeQuestions,
  validAnswer,
  policyPassingScore,
  publicVerificationContent,
  routingQuestions,
} from './task-verification.mjs';
import { createVerificationContentSource } from './verification-content.mjs';

// Verification routes of the four learning areas (Documentation is untouched).
//
//   me:  GET  /api/me/company-policy-handbook   content without answer keys
//        GET  /api/me/task-verifications        saved records + config
//        POST /api/me/task-verifications/:area/:activity
//   hr:  POST /api/hr/employees/:id/task-verifications/tool-access/:stepId
//        (the authorised confirmation of a tool-access request)
//
// Every record kind is stored apart: acknowledgements, quiz attempts, activity
// attempts, checklist acknowledgements, tool-access requests and confirmations.

// Alignment: four activities (matching and questions). Each pass completes its
// own onboarding step; every attempt is recorded either way.
const alignmentChecks = {
  'products-customers': {
    stepId: 'alignment.products-customers',
    activity: ALIGNMENT_ACTIVITIES.products,
  },
  'mission-values': { stepId: 'alignment.mission-values', activity: ALIGNMENT_ACTIVITIES.values },
  'org-structure': { stepId: 'alignment.org-structure', activity: ALIGNMENT_ACTIVITIES.teams },
  'role-contribution': {
    stepId: 'alignment.role-contribution',
    activity: ALIGNMENT_ACTIVITIES.roleContribution,
  },
};

// The record kept for every graded activity. The score can only be set here, from
// the server's own answer key; the browser never sends a score.
const attemptRecord = (previous = {}, { score, passingScore, passed, answers, at }) => ({
  ...previous,
  attempts: (previous.attempts || 0) + 1,
  score: Math.max(previous.score ?? 0, score),
  lastScore: score,
  passingScore,
  passed: Boolean(previous.passed || passed),
  lastAttemptAt: at,
  ...(passed && !previous.passedAt ? { passedAt: at } : {}),
  history: [...(previous.history || []), { at, score, passed }].slice(-20),
  lastAnswers: answers,
});

const MAX_ANSWER_BYTES = 20000;
const cleanAnswers = (value) => {
  const answers = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (JSON.stringify(answers).length > MAX_ANSWER_BYTES)
    throw new ChatError(400, 'ANSWERS_TOO_LARGE', 'Those answers are too large to save.');
  return answers;
};

const text = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

export function mountTaskVerificationRoutes({
  me,
  hr,
  employee,
  hrOnly,
  journey,
  store,
  contentSource = createVerificationContentSource(),
  accounts = null,
}) {
  const account = (req) => req.accountSession.account;

  // Grades one submission, records the attempt, clears the saved draft and answer
  // session and, on a pass, completes the task. `place` says where the record
  // lives. With `fromSession` the answers are the ones already locked one by one
  // (never the client's), and every question must have been answered. Grading and
  // the clearing of the session share one transaction, so a double submit records
  // one attempt: the second finds no session.
  const submitQuiz = async ({
    acc,
    draftKey,
    questions,
    answers,
    passingScore,
    place,
    stepId,
    fromSession = false,
  }) => {
    const at = new Date().toISOString();
    let attempts = 0,
      graded,
      passed = false;
    const saved = await store.saveVerification(acc.id, (v) => {
      let given = answers;
      if (fromSession) {
        const session = v.sessions?.[draftKey];
        if (!session)
          throw new ChatError(409, 'NO_QUIZ_SESSION', 'This attempt was already submitted.');
        if (questions.some((question) => !session.answers?.[question.id]))
          throw new ChatError(409, 'QUIZ_INCOMPLETE', 'Answer every question before finishing.');
        given = Object.fromEntries(
          Object.entries(session.answers).map(([id, entry]) => [id, entry.value]),
        );
      }
      graded = gradeQuestions(questions, given);
      passed = graded.score >= passingScore;
      const record = attemptRecord(place.get(v), {
        score: graded.score,
        passingScore,
        passed,
        answers: given,
        at,
      });
      place.set(v, record);
      attempts = record.attempts;
      if (v.drafts) delete v.drafts[draftKey];
      if (v.sessions) delete v.sessions[draftKey];
      return v;
    });
    const { results, score } = graded;
    const onboarding = passed && stepId ? await journey.verifyStep(acc, stepId) : null;
    return {
      correct: passed,
      passed,
      score,
      passingScore,
      attempts,
      correctCount: results.filter((result) => result.correct).length,
      totalCount: results.length,
      questionResults: results,
      feedback: passed
        ? `Passed with ${score}% (required: ${passingScore}%).`
        : `Score ${score}%. The pass mark is ${passingScore}%. Read the notes on the missed questions and try again.`,
      verifications: saved.verifications,
      ...(onboarding ? { onboarding } : {}),
    };
  };

  // The quiz behind an activity, one description for every route: its questions,
  // pass mark, the onboarding step a pass completes and where its record lives.
  const resolveQuiz = (areaId, activityId, notes = '') => {
    const content = contentSource();
    if (areaId === 'policies') {
      const quiz = content.policies[activityId]?.quiz;
      if (!quiz) return null;
      return {
        questions: quiz.questions,
        passingScore: policyPassingScore(),
        stepId: activityId,
        place: {
          get: (v) => v.policies?.[activityId]?.quiz,
          set: (v, record) => {
            v.policies = v.policies || {};
            v.policies[activityId] = { ...(v.policies[activityId] || {}), quiz: record };
          },
        },
      };
    }
    if (areaId === 'alignment' && alignmentChecks[activityId]) {
      const check = alignmentChecks[activityId];
      return {
        questions: check.activity.questions,
        passingScore: alignmentPassingScore(),
        stepId: check.stepId,
        place: {
          get: (v) => v.alignment?.[activityId],
          set: (v, record) => {
            v.alignment = v.alignment || {};
            const kept = notes || v.alignment[activityId]?.notes;
            v.alignment[activityId] = { ...record, ...(kept ? { notes: kept } : {}) };
          },
        },
      };
    }
    if (areaId === 'team-support' && activityId === 'support-routing')
      return {
        questions: routingQuestions(content.supportRouting),
        passingScore: alignmentPassingScore(),
        stepId: null,
        place: {
          get: (v) => v.teamSupport?.routing,
          set: (v, record) => {
            v.teamSupport = v.teamSupport || {};
            v.teamSupport.routing = record;
          },
        },
      };
    return null;
  };

  me.get('/company-policy-handbook', employee, async (req, res) => {
    const acc = account(req);
    if (contentPackOf(acc.companyId) !== 'univrse') {
      return res.json({
        metadata: null,
        policies: {},
        alignment: {},
        responsibilities: [],
        supportRouting: null,
        verifiedDirectory: null,
        toolAccessSteps: [],
        contentRequirements: [],
        config: {
          policyPassingScore: policyPassingScore(),
          alignmentPassingScore: alignmentPassingScore(),
          allowRetries: true,
          maxAttemptsPerDay: 5,
        },
      });
    }
    res.json({
      metadata: APPROVED_HANDBOOK_METADATA,
      ...publicVerificationContent(contentSource()),
      toolAccessSteps: TOOL_ACCESS_STEP_IDS,
      contentRequirements: CONTENT_REQUIREMENTS,
    });
  });

  me.get('/task-verifications', employee, async (req, res) => {
    res.json(await store.getVerifications(account(req).id));
  });

  me.post('/task-verifications/:areaId/:activityId', employee, async (req, res) => {
    const acc = account(req);
    if (contentPackOf(acc.companyId) !== 'univrse') {
      throw new ChatError(404, 'ACTIVITY_NOT_FOUND', 'Verification activity not found.');
    }
    const { areaId, activityId } = req.params;
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // One answer at a time. The answer is checked against the server's key and
    // locked in the saved attempt session: a second request for the same question
    // returns the first answer's feedback and never records another.
    if (body.action === 'answer' || body.action === 'finish') {
      const quiz = resolveQuiz(
        areaId,
        activityId,
        body.action === 'finish' ? text(body.notes, 600) : '',
      );
      if (!quiz) throw new ChatError(404, 'ACTIVITY_NOT_FOUND', 'Verification activity not found.');
      const key = `${areaId}/${activityId}`;
      if (body.action === 'finish')
        return res.json(
          await submitQuiz({
            acc,
            draftKey: key,
            questions: quiz.questions,
            passingScore: quiz.passingScore,
            place: quiz.place,
            stepId: quiz.stepId,
            fromSession: true,
          }),
        );
      const question = quiz.questions.find((item) => item.id === body.questionId);
      if (!question) throw new ChatError(404, 'QUESTION_NOT_FOUND', 'Question not found.');
      if (!validAnswer(question, body.answer))
        throw new ChatError(400, 'INVALID_ANSWER', 'That answer is not one of the choices.');
      let locked = false;
      const at = new Date().toISOString();
      const saved = await store.saveVerification(acc.id, (v) => {
        locked = false;
        v.sessions = v.sessions || {};
        const session = (v.sessions[key] = v.sessions[key] || { startedAt: at, answers: {} });
        if (!session.answers[question.id]) {
          session.answers[question.id] = { value: body.answer, at };
          locked = true;
        }
        return v;
      });
      const session = saved.verifications.sessions[key];
      const entry = session.answers[question.id];
      return res.json({
        ...answerFeedback(question, entry.value),
        selected: entry.value,
        alreadyAnswered: !locked,
        answered: quiz.questions.filter((item) => session.answers[item.id]).length,
        total: quiz.questions.length,
        attempt: (quiz.place.get(saved.verifications)?.attempts || 0) + 1,
      });
    }

    // Answers in progress are saved so an employee can leave and come back.
    if (body.action === 'draft') {
      const content = contentSource();
      const known =
        (areaId === 'policies' && content.policies[activityId]?.quiz) ||
        (areaId === 'alignment' && alignmentChecks[activityId]) ||
        (areaId === 'team-support' && activityId === 'support-routing');
      if (!known)
        throw new ChatError(404, 'ACTIVITY_NOT_FOUND', 'Verification activity not found.');
      const answers = cleanAnswers(body.answers);
      const key = `${areaId}/${activityId}`;
      const saved = await store.saveVerification(acc.id, (v) => {
        v.drafts = v.drafts || {};
        v.drafts[key] = {
          answers,
          notes: text(body.notes, 600),
          savedAt: new Date().toISOString(),
        };
        return v;
      });
      return res.json({ saved: true, savedAt: saved.verifications.drafts[key].savedAt });
    }

    if (areaId === 'policies') {
      const content = contentSource();
      const policy = content.policies[activityId];
      if (!policy) throw new ChatError(404, 'POLICY_NOT_FOUND', 'Policy topic not found.');

      if (body.action === 'acknowledge') {
        const at = new Date().toISOString();
        const saved = await store.saveVerification(acc.id, (v) => {
          v.policies = v.policies || {};
          const existing = v.policies[activityId] || {};
          v.policies[activityId] = {
            ...existing,
            acknowledgedAt: existing.acknowledgedAt || at,
          };
          return v;
        });
        // The acknowledgement records the briefing. It completes the step only
        // when the policy has no approved quiz; otherwise the quiz must be passed.
        const briefed = await journey.recordBriefing(acc, activityId, { completion: 'read' });
        const onboarding = policy.quiz ? briefed : await journey.verifyStep(acc, activityId);
        return res.json({
          acknowledged: true,
          acknowledgedAt: saved.verifications.policies[activityId].acknowledgedAt,
          verifications: saved.verifications,
          onboarding,
          message: 'Reading acknowledgement recorded.',
        });
      }

      if (body.action === 'quiz') {
        if (!policy.quiz)
          throw new ChatError(
            409,
            'NO_QUIZ',
            'This policy has no quiz; acknowledging it completes it.',
          );
        const quiz = resolveQuiz('policies', activityId);
        return res.json(
          await submitQuiz({
            acc,
            draftKey: `policies/${activityId}`,
            questions: quiz.questions,
            answers: cleanAnswers(body.answers),
            passingScore: quiz.passingScore,
            stepId: quiz.stepId,
            place: quiz.place,
          }),
        );
      }
      throw new ChatError(400, 'INVALID_POLICY_ACTION', 'Action must be acknowledge or quiz.');
    }

    if (areaId === 'alignment') {
      if (alignmentChecks[activityId]) {
        const notes = activityId === 'role-contribution' ? text(body.notes, 600) : '';
        const quiz = resolveQuiz('alignment', activityId, notes);
        return res.json(
          await submitQuiz({
            acc,
            draftKey: `alignment/${activityId}`,
            questions: quiz.questions,
            answers: cleanAnswers(body.answers),
            passingScore: quiz.passingScore,
            stepId: quiz.stepId,
            place: quiz.place,
          }),
        );
      }
    }

    if (areaId === 'role-tools') {
      if (activityId === 'responsibilities') {
        const checked = Array.isArray(body.checkedItems) ? body.checkedItems.map(String) : [];
        const { byDepartment, default: fallback } = contentSource().responsibilities;
        const dept = text(body.department, 80);
        const items = byDepartment[dept] || fallback;
        if (!items.every((_, i) => checked.includes(String(i))))
          throw new ChatError(400, 'CHECKLIST_INCOMPLETE', 'Tick every item to acknowledge it.');
        const at = new Date().toISOString();
        const saved = await store.saveVerification(acc.id, (v) => {
          v.roleTools = v.roleTools || {};
          v.roleTools.responsibilities = {
            department: dept,
            acknowledgedAt: at,
            itemCount: items.length,
          };
          return v;
        });
        return res.json({
          success: true,
          feedback: 'Saved. This is an acknowledgement, not an assessment.',
          verifications: saved.verifications,
        });
      }

      if (activityId === 'tool-access') {
        const stepId = body.toolId;
        if (!TOOL_ACCESS_STEP_IDS.includes(stepId))
          throw new ChatError(
            400,
            'TOOL_NOT_FOUND',
            'This step does not use an access confirmation.',
          );
        const workEmail = text(body.workEmail, 254);
        if (!/^\S+@\S+\.\S+$/.test(workEmail))
          throw new ChatError(
            400,
            'INVALID_EMAIL',
            'Enter the work or Google account you use for this tool.',
          );
        const at = new Date().toISOString();
        let created = false;
        const saved = await store.saveVerification(acc.id, (v) => {
          v.roleTools = v.roleTools || {};
          v.roleTools.tools = v.roleTools.tools || {};
          const existing = v.roleTools.tools[stepId];
          if (existing?.status === 'confirmed') return v;
          created = true;
          v.roleTools.tools[stepId] = {
            workEmail,
            status: 'awaiting_confirmation',
            requestedAt: at,
          };
          return v;
        });
        return res.json({
          success: true,
          created,
          workflowStatus: saved.verifications.roleTools.tools[stepId].status,
          systemNotice:
            'No automatic directory check is connected to this deployment, so your onboarding coordinator confirms your access. The task completes once they do.',
          verifications: saved.verifications,
        });
      }
    }

    if (areaId === 'team-support') {
      if (activityId === 'support-routing') {
        const quiz = resolveQuiz('team-support', activityId);
        return res.json(
          await submitQuiz({
            acc,
            draftKey: 'team-support/support-routing',
            questions: quiz.questions,
            answers: cleanAnswers(body.answers),
            passingScore: quiz.passingScore,
            stepId: null,
            place: quiz.place,
          }),
        );
      }

      // Optional and private: never required, never part of progress, and not
      // returned by the HR routes. An empty text removes it.
      if (activityId === 'working-preferences') {
        const value = text(body.text, 600);
        const saved = await store.saveVerification(acc.id, (v) => {
          v.teamSupport = v.teamSupport || {};
          if (value)
            v.teamSupport.workingPreferences = { text: value, savedAt: new Date().toISOString() };
          else delete v.teamSupport.workingPreferences;
          return v;
        });
        return res.json({ success: true, verifications: saved.verifications });
      }

      if (activityId === 'confirm-help') {
        const at = new Date().toISOString();
        const saved = await store.saveVerification(acc.id, (v) => {
          v.teamSupport = v.teamSupport || {};
          v.teamSupport.confirmedHelpAt = v.teamSupport.confirmedHelpAt || at;
          return v;
        });
        return res.json({
          success: true,
          confirmedHelpAt: saved.verifications.teamSupport.confirmedHelpAt,
          feedback: 'Saved. You can come back to this page whenever you need to find help.',
          verifications: saved.verifications,
        });
      }
    }

    throw new ChatError(404, 'ACTIVITY_NOT_FOUND', 'Verification activity not found.');
  });

  // The authorised coordinator confirms a pending tool-access request. Only this
  // completes an access step; the employee's request alone never does.
  hr.post('/employees/:id/task-verifications/tool-access/:stepId', hrOnly, async (req, res) => {
    const { id, stepId } = req.params;
    if (accounts) await accounts.getEmployee(req.accountSession, id);
    if (!TOOL_ACCESS_STEP_IDS.includes(stepId))
      throw new ChatError(400, 'TOOL_NOT_FOUND', 'This step does not use an access confirmation.');
    const current = await store.getVerifications(id);
    const request = current.verifications.roleTools?.tools?.[stepId];
    if (!request)
      throw new ChatError(409, 'NO_ACCESS_REQUEST', 'The employee has not requested confirmation.');
    const onboarding = await journey.verifyEmployeeStep(req.accountSession, id, stepId);
    const at = new Date().toISOString();
    await store.saveVerification(id, (v) => {
      v.roleTools.tools[stepId] = {
        ...v.roleTools.tools[stepId],
        status: 'confirmed',
        confirmedAt: at,
        confirmedBy: req.accountSession.account.id,
      };
      return v;
    });
    res.json({ confirmed: true, onboarding });
  });

  // Pending access requests of one employee, for the coordinator.
  hr.get('/employees/:id/task-verifications', hrOnly, async (req, res) => {
    if (accounts) await accounts.getEmployee(req.accountSession, req.params.id);
    const saved = await store.getVerifications(req.params.id);
    // Working preferences, drafts and raw answers are the employee's own; HR sees outcomes only.
    const { drafts: _drafts, sessions: _sessions, ...rest } = saved.verifications;
    const strip = (record) => {
      if (!record || typeof record !== 'object') return record;
      const { lastAnswers: _answers, ...kept } = record;
      return kept;
    };
    const verifications = { ...rest };
    if (verifications.policies)
      verifications.policies = Object.fromEntries(
        Object.entries(verifications.policies).map(([id, p]) => [
          id,
          { ...p, quiz: strip(p.quiz) },
        ]),
      );
    if (verifications.alignment)
      verifications.alignment = Object.fromEntries(
        Object.entries(verifications.alignment).map(([id, a]) => [id, strip(a)]),
      );
    if (verifications.teamSupport) {
      const { workingPreferences: _private, routing, ...others } = verifications.teamSupport;
      verifications.teamSupport = { ...others, ...(routing ? { routing: strip(routing) } : {}) };
    }
    saved.verifications = verifications;
    res.json(saved);
  });
}
