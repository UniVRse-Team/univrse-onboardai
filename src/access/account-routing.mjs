// Which screen a signed-in or signed-out browser sees for a path.

// An admin lands on the platform dashboard, HR on the workspace, and an
// employee on My onboarding (/onboarding).
export const landingPath = (account) =>
  account?.role === 'admin' ? '/admin' : account?.role === 'hr' ? '/hr' : '/onboarding';

export const adminHome = '/admin';
const companyPathPattern = /^\/admin\/companies\/([a-z][a-z0-9-]{1,30}[a-z0-9])\/?$/;
// '/admin' and everything below it belong to platform administrators.
export const isAdminArea = (path) => path === '/admin' || String(path).startsWith('/admin/');
export const adminCompanyPath = (companyId) => '/admin/companies/' + encodeURIComponent(companyId);
// -> { page: 'dashboard' } | { page: 'company', companyId } | null (not an admin page)
export function parseAdminPath(path) {
  if (path === '/admin' || path === '/admin/') return { page: 'dashboard' };
  const match = companyPathPattern.exec(String(path));
  return match ? { page: 'company', companyId: match[1] } : null;
}

const loginPaths = ['/', '/login'];

// Every route needs an account. Signed-out visitors are sent to /login, which
// is also the public landing page. accounts: true | false | null (null while
// /api/config is loading). account: the SessionAccount, or null when signed out.
// An HR account only uses /hr; an employee account never uses /hr.
export function routeDecision({ accounts, loading = false, account = null, path }) {
  if (accounts === null || loading) return { type: 'loading' };
  if (accounts === false) {
    // Accounts are off: only the sign-in page exists, and it says so.
    return loginPaths.includes(path) ? { type: 'render' } : { type: 'redirect', to: '/login' };
  }
  if (!account)
    return loginPaths.includes(path) ? { type: 'render' } : { type: 'redirect', to: '/login' };
  if (account.mustChangePassword === true) return { type: 'change-password' };
  const landing = landingPath(account);
  // /dashboard was the same page as My onboarding and is retired.
  if (path === '/dashboard' && account.role !== 'hr') return { type: 'redirect', to: landing };
  if (loginPaths.includes(path) || path === '/signup') return { type: 'redirect', to: landing };
  // An admin belongs to no company and may only use the two admin pages.
  if (account.role === 'admin')
    return parseAdminPath(path) ? { type: 'render' } : { type: 'redirect', to: adminHome };
  if (isAdminArea(path)) return { type: 'redirect', to: landing };
  if (account.role === 'hr' && path !== '/hr') return { type: 'redirect', to: landing };
  if (account.role !== 'hr' && path === '/hr') return { type: 'redirect', to: landing };
  return { type: 'render' };
}

// Result of an app-wide account error action, given the current session.
export function afterAccountAction(action, account) {
  if (action === 'sign-in') return { account: null, to: '/login', notice: true };
  // An admin session on a company route: back to the dashboard.
  if (action === 'company-account-required') return { account, to: adminHome, notice: false };
  // A non-admin on an admin route: back to their own landing page.
  if (action === 'admin-role-required' && account)
    return { account, to: landingPath(account), notice: false };
  if (action === 'change-password' && account)
    return { account: { ...account, mustChangePassword: true }, to: null, notice: false };
  return { account, to: null, notice: false };
}

// What a repeat GET /api/auth/session means for a browser that believes it is
// signed in as `current`. `result` is { account } from a 200, or { error } from
// an AccountApiError; a network failure never signs anyone out.
export function sessionCheckOutcome(current, result) {
  if (!current) return { type: 'ok' };
  if (result?.error) {
    const { status, code } = result.error;
    return status === 401 && code === 'SESSION_EXPIRED' ? { type: 'expired' } : { type: 'ok' };
  }
  const account = result?.account ?? null;
  if (!account) return { type: 'expired' };
  if (account.id !== current.id || account.mustChangePassword !== current.mustChangePassword)
    return { type: 'update', account };
  return { type: 'ok' };
}
