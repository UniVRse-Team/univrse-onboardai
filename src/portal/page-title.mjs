import { isAdminArea, isHrArea, parseCompanyTenantPath } from '../access/account-routing.mjs';

// "luna-digital" -> "Luna Digital": readable stand-in until the real name loads.
export function companyNameFromId(companyId) {
  return String(companyId || '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Browser tab title. active: the matching navigation item ({ label }) or null.
// tenantName: the company's real name for /companies/<id> when it has loaded.
// changePassword: true while the forced change-password screen is showing.
export function pageTitle({
  path,
  account = null,
  active = null,
  tenantName = '',
  changePassword = false,
}) {
  if (changePassword) return 'Change your password · ' + (account?.company?.name || 'OnboardAi');
  const tenant = parseCompanyTenantPath(path);
  if (tenant) return 'Welcome · ' + (tenantName || companyNameFromId(tenant.companyId));
  const accessTitle =
    path === '/' || path === '/login'
      ? 'Welcome'
      : path === '/signup'
        ? 'Create an employee account'
        : isHrArea(path)
          ? 'HR workspace'
          : isAdminArea(path)
            ? 'Platform Admin'
            : null;
  const companyBrand = account?.company?.name || 'OnboardAi';
  return (accessTitle || active?.label || 'Page not found') + ' · ' + companyBrand;
}
