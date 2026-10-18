import { agentActionErrors } from './agent-actions.mjs';
import { ChatError } from './chat-errors.mjs';
import {
  ALIGNMENT_ACTIVITY_STEP_IDS,
  TOOL_ACCESS_STEP_IDS,
  createTaskVerificationStore,
} from './task-verification.mjs';
import { mountTaskVerificationRoutes } from './task-verification-routes.mjs';

// HTTP routes of the onboarding journey (issues #47-#50, contract v1.1 in
// docs/onboarding-journey.md). They are added to the account routers of
// account-routes.mjs, so they share its Origin check, no-store caching, 503
// ACCOUNTS_NOT_CONFIGURED and { code, error } error mapping.
//
//   me (role employee):  /api/me/onboarding*, /api/me/quick-questions,
//                        /api/me/first-day, /api/me/support-requests*,
//                        /api/me/agent-actions/:id, /api/me/task-verifications*,
//                        /api/me/company-policy-handbook
//   hr (role hr):        /api/hr/support-requests*, /api/hr/knowledge-gaps,
//                        /api/hr/team-insights, /api/hr/employees/:id/onboarding*,
//                        /api/hr/employees/:id/first-day
export const ALIGNMENT_STEP_IDS = Object.freeze([
  'alignment.products-customers',
  'alignment.mission-values',
  'alignment.org-structure',
  'alignment.role-contribution',
]);

export function mountOnboardingRoutes({
  me,
  hr,
  employee,
  hrOnly,
  journey,
  support,
  gaps,
  actions = null,
  taskVerificationStore = null,
  accounts = null,
}) {
  const account = (req) => req.accountSession.account;
  const verifications =
    taskVerificationStore || createTaskVerificationStore({ firestore: journey.firestore });

  me.get('/onboarding', employee, async (req, res) => {
    res.json(await journey.myOnboarding(account(req)));
  });
  // Steps proven by an activity (alignment) or by a coordinator (tool access) are
  // finished only through that verification, never by a direct request here.
  const gated = (stepId) =>
    TOOL_ACCESS_STEP_IDS.includes(stepId) || ALIGNMENT_ACTIVITY_STEP_IDS.includes(stepId);
  const requireNotGated = (req) => {
    if (gated(req.params.stepId))
      throw new ChatError(
        409,
        'VERIFICATION_REQUIRED',
        'This task is completed by its activity or by verification, not by confirming it directly.',
      );
  };
  me.post('/onboarding/steps/:stepId/complete', employee, async (req, res) => {
    requireNotGated(req);
    res.json(await journey.completeStep(account(req), req.params.stepId));
  });
  me.post('/onboarding/steps/:stepId/reopen', employee, async (req, res) => {
    requireNotGated(req);
    res.json(await journey.reopenStep(account(req), req.params.stepId));
  });
  // Alya's briefing of a step was listened to or read (contract v1.5).
  me.post('/onboarding/steps/:stepId/briefing', employee, async (req, res) => {
    res.json(await journey.recordBriefing(account(req), req.params.stepId, req.body));
  });
  me.get('/onboarding/steps/:stepId/check', employee, async (req, res) => {
    res.json(await journey.checkQuestion(account(req), req.params.stepId));
  });
  me.post('/onboarding/steps/:stepId/check', employee, async (req, res) => {
    res.json(await journey.answerCheck(account(req), req.params.stepId, req.body));
  });
  me.get('/ai-proficiency', employee, async (req, res) => {
    res.json(await journey.myAiProficiency(account(req), req.query));
  });
  me.put('/ai-proficiency', employee, async (req, res) => {
    res.json(await journey.saveAiProficiency(account(req), req.body, req.query));
  });
  me.post('/ai-proficiency/complete-training', employee, async (req, res) => {
    res.json(await journey.completeAiTraining(account(req), req.body, req.query));
  });
  me.get('/quick-questions', employee, async (req, res) => {
    res.json(await journey.quickQuestions(account(req), { stepId: req.query.stepId }));
  });
  me.get('/first-day', employee, async (req, res) => {
    res.json(await journey.myFirstDay(account(req)));
  });
  me.post('/support-requests/preview', employee, async (req, res) => {
    res.json(await support.preview(account(req), req.body));
  });
  me.post('/support-requests', employee, async (req, res) => {
    const { created, request } = await support.create(account(req), req.body);
    res.status(created ? 201 : 200).json({ request });
  });
  me.get('/support-requests', employee, async (req, res) => {
    res.json({ requests: await support.mine(account(req)) });
  });
  // The employee's answer to a proposed checklist change (#51). With the
  // checklist agent off there is never a pending action.
  me.post('/agent-actions/:id', employee, async (req, res) => {
    if (!actions) throw agentActionErrors.notPending();
    res.json(await actions.decide(account(req), req.params.id, req.body));
  });

  mountTaskVerificationRoutes({
    me,
    hr,
    employee,
    hrOnly,
    journey,
    store: verifications,
    accounts,
  });

  hr.get('/support-requests', hrOnly, async (req, res) => {
    res.json(await support.hrList(req.accountSession));
  });
  hr.patch('/support-requests/:id', hrOnly, async (req, res) => {
    res.json({ request: await support.hrUpdate(req.accountSession, req.params.id, req.body) });
  });
  hr.get('/knowledge-gaps', hrOnly, async (req, res) => {
    res.json(await gaps.list(req.accountSession.account.companyId));
  });
  hr.get('/team-insights', hrOnly, async (req, res) => {
    res.json(await support.insights(req.accountSession));
  });
  hr.get('/employees/:id/onboarding', hrOnly, async (req, res) => {
    if (accounts) await accounts.getEmployee(req.accountSession, req.params.id);
    res.json(await journey.employeeOnboarding(req.params.id, req.accountSession));
  });
  hr.get('/employees/:id/ai-proficiency', hrOnly, async (req, res) => {
    if (accounts) await accounts.getEmployee(req.accountSession, req.params.id);
    res.json(await journey.employeeAiProficiency(req.params.id, req.accountSession, req.query));
  });
  hr.patch('/employees/:id/onboarding/steps/:stepId', hrOnly, async (req, res) => {
    if (accounts) await accounts.getEmployee(req.accountSession, req.params.id);
    res.json(
      await journey.setEmployeeStep(req.accountSession, req.params.id, req.params.stepId, req.body),
    );
  });
  hr.get('/employees/:id/first-day', hrOnly, async (req, res) => {
    if (accounts) await accounts.getEmployee(req.accountSession, req.params.id);
    res.json(await journey.employeeFirstDay(req.params.id, req.accountSession));
  });
  hr.put('/employees/:id/first-day', hrOnly, async (req, res) => {
    if (accounts) await accounts.getEmployee(req.accountSession, req.params.id);
    res.json(await journey.putEmployeeFirstDay(req.accountSession, req.params.id, req.body));
  });
}
