import express from 'express';
import {
  accountErrors,
  companyErrors,
  companyProfileErrors,
  digestErrors,
} from './account-errors.mjs';
import {
  accountCookie,
  adminCookie,
  accountCookieOptions,
  readCookie,
  sameOrigin,
  sendAccountError,
} from './account-routes.mjs';
import { ChatError } from './chat-errors.mjs';

export function mountAdminRoutes(app, { env, accounts, profileDigest = null }) {
  const clearSession = (req, res) => {
    res.clearCookie(adminCookie, accountCookieOptions(req, env));
    res.clearCookie(accountCookie, accountCookieOptions(req, env));
  };

  function guard(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!sameOrigin(req)) throw accountErrors.crossOrigin();
    if (!accounts) throw accountErrors.notConfigured();
    next();
  }

  const adminOnly = async (req, res, next) => {
    const token = readCookie(req, adminCookie) || readCookie(req, accountCookie);
    if (token === undefined) throw accountErrors.authRequired();
    const session = await accounts.session(token);
    if (!session) {
      clearSession(req, res);
      throw accountErrors.sessionExpired();
    }
    if (session.account.mustChangePassword) throw accountErrors.passwordChangeRequired();
    if (session.account.role !== 'admin') throw accountErrors.adminRequired();
    req.accountSession = session;
    next();
  };

  const admin = express.Router();

  const jsonParser = express.json({ limit: '64kb' });
  const profileJson = (req, res, next) => {
    jsonParser(req, res, (error) => {
      if (error?.type === 'entity.too.large') {
        return next(companyProfileErrors.tooLarge());
      }
      next(error);
    });
  };

  admin.use((req, res, next) => {
    if (req.path === '/profile-digest') return next();
    if (req.path.endsWith('/profile')) return profileJson(req, res, next);
    return jsonParser(req, res, next);
  });

  admin.get('/companies', adminOnly, async (req, res) => {
    res.json(await accounts.listCompanies());
  });

  admin.post('/companies', adminOnly, async (req, res) => {
    res.status(201).json(await accounts.createCompany(req.accountSession, req.body));
  });

  admin.get('/companies/:companyId', adminOnly, async (req, res) => {
    res.json(await accounts.getCompany(req.params.companyId));
  });

  admin.patch('/companies/:companyId', adminOnly, async (req, res) => {
    res.json(await accounts.renameCompany(req.accountSession, req.params.companyId, req.body));
  });

  admin.put('/companies/:companyId/status', adminOnly, async (req, res) => {
    res.json(await accounts.setCompanyStatus(req.accountSession, req.params.companyId, req.body));
  });

  admin.get('/companies/:companyId/profile', adminOnly, async (req, res) => {
    res.json(await accounts.companyProfile(req.params.companyId));
  });

  admin.put('/companies/:companyId/profile', adminOnly, async (req, res) => {
    res.json(await accounts.saveCompanyProfile(req.accountSession, req.params.companyId, req.body));
  });

  admin.post('/profile-digest', adminOnly, async (req, res) => {
    if (!profileDigest) throw digestErrors.notConfigured();
    await profileDigest.handle(req, res);
  });

  admin.get('/companies/:companyId/hr-accounts', adminOnly, async (req, res) => {
    res.json(await accounts.listCompanyHr(req.params.companyId));
  });

  admin.post('/companies/:companyId/hr-accounts', adminOnly, async (req, res) => {
    res
      .status(201)
      .json(await accounts.createCompanyHr(req.accountSession, req.params.companyId, req.body));
  });

  admin.put('/companies/:companyId/default-hr', adminOnly, async (req, res) => {
    res.json(await accounts.setDefaultHr(req.accountSession, req.params.companyId, req.body));
  });

  admin.post(
    '/companies/:companyId/hr-accounts/:accountId/password',
    adminOnly,
    async (req, res) => {
      res.json(
        await accounts.resetHrPasswordByAdmin(
          req.accountSession,
          req.params.companyId,
          req.params.accountId,
        ),
      );
    },
  );

  admin.get('/events', adminOnly, async (req, res) => {
    res.json(await accounts.listAdminEvents(req.query));
  });

  const mounted = express.Router();
  mounted.use(guard, admin);
  mounted.use(() => {
    throw accountErrors.notFound();
  });
  mounted.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ChatError) return sendAccountError(res, error);
    console.warn(
      'Admin request failed: ' +
        JSON.stringify({ name: error?.name, code: String(error?.code || 'UNKNOWN') }),
    );
    res.status(500).json({
      code: 'ADMIN_REQUEST_FAILED',
      error: 'The admin request could not be completed. Please try again.',
    });
  });

  app.use('/api/admin', mounted);
}
