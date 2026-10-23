import { companyTenantPath } from './account-routing.mjs';

// Where the browser goes once a session is over (sign-out, expiry, rejected
// session). Employees and HR return to their company link; everyone else,
// including platform admins, goes to the generic /login.
export function signedOutPath(account) {
  const companyId = account?.companyId || account?.company?.id;
  if (companyId && (account.role === 'employee' || account.role === 'hr')) {
    return companyTenantPath(companyId);
  }
  return '/login';
}

// Sign-out may be wired straight to onClick, so only an explicit
// { navigate: false } suppresses navigation; a click event never does.
export function shouldNavigateAfterSignOut(options) {
  return options?.navigate !== false;
}
