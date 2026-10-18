import express from 'express';
import { mountDocumentSubmissionRoutes } from './document-submission-routes.mjs';
import { ChatError } from './chat-errors.mjs';
import { accountErrors, autofillErrors } from './account-errors.mjs';
import { companyKnowledgeRequestErrors } from './company-knowledge.mjs';
import { readUploadedDocument } from './read-uploaded-document.mjs';
import { workspaceLimits } from './workspace-limits.mjs';
import { mountOnboardingRoutes } from './onboarding-routes.mjs';

// HTTP routes for accounts (see docs/account-access.md for the contract):
//   /api/auth/*           sign in, session, sign out, change password
//   /api/me/*             the signed-in account's own data
//   /api/hr/employees*    HR-only employee administration, including deletion
//   /api/hr/employees/autofill  HR-only profile autofill (profile-autofill.mjs)
//   /api/hr/departments*        HR-only departments and Employee ID prefixes (Settings)
//   /api/hr/company-knowledge*  HR-only company knowledge uploads (company-knowledge.mjs)
//   onboarding journey routes   /api/me/onboarding*, /api/hr/support-requests*, ...
//                               (onboarding-routes.mjs, docs/onboarding-journey.md)
// GET /api/hr/support-summaries (named per-employee summaries) was removed by
// D1 Option A (issue #48); GET /api/hr/team-insights replaces it.
// Every route checks the browser's Origin like the saved-chat routes, answers
// 503 ACCOUNTS_NOT_CONFIGURED without DATABASE_URL, is never cached, and sits
// behind the app's POST rate limiter.
export const accountCookie = 'onboardai_account';

export function readCookie(req, name) {
  const prefix = name + '=';
  return req
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
}

// The same rule as the saved-chat routes: a browser Origin header, when sent,
// must name this host.
export function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.host;
  } catch {
    return false;
  }
}

export function accountCookieOptions(req, env) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || env.NODE_ENV === 'production',
    path: '/api',
  };
}

export function sendAccountError(res, error) {
  res.status(error.status).json({ code: error.code, error: error.message, ...error.details });
}

// profileAutofill: the service from createProfileAutofill, or null (503
// AUTOFILL_NOT_CONFIGURED). chatMemory(): the saved-chat store holding account
// chats (deletion). companyKnowledge: the service from createCompanyKnowledge
// (the HR library). journey: { onboarding, support, gaps, actions? } from
// onboarding-journey.mjs, support-requests.mjs, knowledge-gaps.mjs and
// agent-actions.mjs.
export function mountAccountRoutes(
  app,
  {
    env,
    accounts,
    profileAutofill = null,
    chatMemory = null,
    companyKnowledge = null,
    journey = null,
    submissions = null,
  },
) {
  const setSession = (req, res, result) =>
    res.cookie(accountCookie, result.token, {
      ...accountCookieOptions(req, env),
      maxAge: result.sessionMs,
    });
  const clearSession = (req, res) => res.clearCookie(accountCookie, accountCookieOptions(req, env));

  function guard(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!sameOrigin(req)) throw accountErrors.crossOrigin();
    if (!accounts) throw accountErrors.notConfigured();
    next();
  }
  // Requires a usable session. allowPasswordChange lets an account with a
  // forced password change through (session, change password, sign out only).
  const signedIn =
    ({ allowPasswordChange = false, role = null } = {}) =>
    async (req, res, next) => {
      const token = readCookie(req, accountCookie);
      if (token === undefined) throw accountErrors.authRequired();
      const session = await accounts.session(token);
      if (!session) {
        clearSession(req, res);
        throw accountErrors.sessionExpired();
      }
      if (session.account.mustChangePassword && !allowPasswordChange)
        throw accountErrors.passwordChangeRequired();
      if (session.account.role === 'admin' && role !== 'admin')
        throw accountErrors.companyAccountRequired();
      if (role && session.account.role !== role)
        throw role === 'hr' ? accountErrors.hrRequired() : accountErrors.employeeRequired();
      req.accountSession = session;
      next();
    };
  const hr = signedIn({ role: 'hr' });
  const employee = signedIn({ role: 'employee' });

  const auth = express.Router();
  auth.post('/sign-in', async (req, res) => {
    const previous = readCookie(req, accountCookie);
    const result = await accounts.signIn(req.body, previous);
    setSession(req, res, result);
    res.json({ account: result.account });
  });
  auth.get('/session', async (req, res) => {
    const token = readCookie(req, accountCookie);
    if (token === undefined) return res.json({ account: null });
    const session = await accounts.session(token);
    if (!session) {
      clearSession(req, res);
      throw accountErrors.sessionExpired();
    }
    res.json({ account: session.account });
  });
  auth.post('/sign-out', async (req, res) => {
    await accounts.signOut(readCookie(req, accountCookie));
    clearSession(req, res);
    res.status(204).end();
  });
  auth.post('/password', signedIn({ allowPasswordChange: true }), async (req, res) => {
    const result = await accounts.changePassword(req.accountSession, req.body);
    setSession(req, res, result);
    res.json({ account: result.account });
  });

  const me = express.Router();
  me.get('/profile', signedIn(), async (req, res) => {
    res.json({ profile: await accounts.myProfile(req.accountSession.account) });
  });

  const employees = express.Router();
  // Read-only company and profile details for HR.
  employees.get('/company', hr, async (req, res) => {
    const companyId = req.accountSession.account.companyId;
    const company = await accounts.getCompany(companyId);
    const profileEnvelope = await accounts.companyProfile(companyId);
    res.json({
      company: { id: company.id, name: company.name, status: company.status },
      defaultHr: company.defaultHr,
      ...profileEnvelope,
    });
  });
  // Reads profile fields from an uploaded document; saves nothing.
  employees.post('/employees/autofill', hr, async (req, res) => {
    if (!profileAutofill) throw autofillErrors.notConfigured();
    await profileAutofill.handle(req, res);
  });
  // Each item: { account, profile, track, onboarding: { percent, waitingOnHr } }.
  employees.get('/employees', hr, async (req, res) => {
    const listed = await accounts.listEmployees(req.accountSession);
    res.json({ employees: journey ? await journey.onboarding.withOnboarding(listed) : listed });
  });
  // { profile } in; { employee, temporaryPassword } out. The server assigns the
  // Employee ID and the temporary password; this response is the only place
  // the password ever appears (never cached: the guard sets no-store).
  employees.post('/employees', hr, async (req, res) => {
    res.status(201).json(await accounts.createEmployee(req.accountSession, req.body));
  });
  employees.get('/employees/:id', hr, async (req, res) => {
    res.json({ employee: await accounts.getEmployee(req.accountSession, req.params.id) });
  });
  employees.put('/employees/:id/profile', hr, async (req, res) => {
    res.json({
      employee: await accounts.replaceProfile(req.accountSession, req.params.id, req.body),
    });
  });
  employees.post('/employees/:id/password', hr, async (req, res) => {
    res.json(await accounts.resetPassword(req.accountSession, req.params.id, req.body));
  });
  employees.put('/employees/:id/status', hr, async (req, res) => {
    res.json(await accounts.setStatus(req.accountSession, req.params.id, req.body));
  });
  // Deletes the employee's Firestore data, then the account. Safe to retry.
  employees.delete('/employees/:id', hr, async (req, res) => {
    await accounts.getEmployee(req.accountSession, req.params.id);
    await submissions?.eraseEmployee(req.params.id);
    await accounts.deleteEmployee(req.accountSession, req.params.id, {
      eraseChats: (owner) => chatMemory().eraseOwner(owner),
      // The checklist agent's sessions (#51); never fails the deletion.
      eraseAgentSessions: journey?.actions
        ? (accountId) => journey.actions.forgetAccount(accountId)
        : null,
    });
    res.status(204).end();
  });

  // HR Settings: the departments and their Employee ID prefixes.
  employees.get('/departments', hr, async (req, res) => {
    res.json({ departments: await accounts.listDepartments(req.accountSession) });
  });
  employees.post('/departments', hr, async (req, res) => {
    res.status(201).json(await accounts.createDepartment(req.accountSession, req.body));
  });
  employees.patch('/departments/:id', hr, async (req, res) => {
    res.json(await accounts.updateDepartment(req.accountSession, req.params.id, req.body));
  });

  // The company knowledge library: uploaded files, stored company-wide as text.
  const library = () => {
    if (!companyKnowledge) throw accountErrors.notConfigured();
    return companyKnowledge;
  };
  employees.get('/company-knowledge', hr, async (req, res) => {
    res.json(await library().snapshot(req.accountSession.account.companyId));
  });
  // A raw file body (application/octet-stream, X-File-Name), read into text
  // with the shared upload reader. Only the text and metadata are stored.
  // With ?replaces=<document id> the file replaces that document (one
  // company_document_replaced audit row, ids only); without it the upload adds.
  const rawFile = express.raw({ type: 'application/octet-stream', limit: workspaceLimits.bytes });
  employees.post(
    '/company-knowledge/documents',
    hr,
    (req, res, next) => {
      if (!companyKnowledge) throw accountErrors.notConfigured();
      if (!req.is('application/octet-stream')) throw companyKnowledgeRequestErrors.fileRequired();
      // The topic is checked before the file is read.
      req.knowledgeTopic = companyKnowledge.describe(req.query);
      rawFile(req, res, (error) =>
        next(
          error?.type === 'entity.too.large'
            ? new ChatError(413, 'FILE_TOO_LARGE', 'Each file must be 5 MB or smaller.')
            : error,
        ),
      );
    },
    async (req, res) => {
      let name;
      try {
        name = decodeURIComponent(req.get('X-File-Name') || '');
      } catch {
        throw new ChatError(400, 'FILE_NAME_INVALID', 'Choose a file with a valid name.');
      }
      const file = await readUploadedDocument(name, req.body);
      if (req.aborted || res.destroyed) return;
      const actorId = req.accountSession.account.id;
      const companyId = req.accountSession.account.companyId;
      const upload = { ...file, content: req.body };
      const result = req.knowledgeTopic.replaces
        ? await companyKnowledge.replace(
            actorId,
            req.knowledgeTopic,
            upload,
            new Date(),
            (detail, during) =>
              accounts.recordEvent(req.accountSession, 'company_document_replaced', detail, during),
            companyId,
          )
        : await companyKnowledge.add(actorId, req.knowledgeTopic, upload, new Date(), companyId);
      if (!res.destroyed) res.status(result.duplicate ? 200 : 201).json(result);
    },
  );
  // { category } -> { document }: moves a document to another area or to
  // 'additional', with a company_document_moved audit row (ids only).
  employees.patch('/company-knowledge/documents/:id', hr, async (req, res) => {
    res.json(
      await library().move(
        req.params.id,
        req.body,
        (detail, during) =>
          accounts.recordEvent(req.accountSession, 'company_document_moved', detail, during),
        req.accountSession.account.companyId,
      ),
    );
  });
  employees.delete('/company-knowledge/documents/:id', hr, async (req, res) => {
    await library().remove(req.params.id, req.accountSession.account.companyId);
    res.status(204).end();
  });

  if (journey)
    mountOnboardingRoutes({
      me,
      hr: employees,
      employee,
      hrOnly: hr,
      journey: journey.onboarding,
      support: journey.support,
      gaps: journey.gaps,
      actions: journey.actions ?? null,
      accounts,
    });

  mountDocumentSubmissionRoutes({
    me,
    hr: employees,
    employeeOnly: employee,
    hrOnly: hr,
    submissions,
  });
  for (const [path, router] of [
    ['/api/auth', auth],
    ['/api/me', me],
    ['/api/hr', employees],
  ]) {
    const mounted = express.Router();
    mounted.use(guard, router);
    mounted.use(() => {
      throw accountErrors.notFound();
    });
    mounted.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      if (error instanceof ChatError) return sendAccountError(res, error);
      // Only the error's name and code, never request data or values.
      console.warn(
        'Account request failed: ' +
          JSON.stringify({ name: error?.name, code: String(error?.code || 'UNKNOWN') }),
      );
      res.status(500).json({
        code: 'ACCOUNT_REQUEST_FAILED',
        error: 'The account request could not be completed. Please try again.',
      });
    });
    app.use(path, mounted);
  }
}
