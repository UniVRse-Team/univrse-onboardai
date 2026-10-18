// Old URLs that now lead to the Alya chat page or the website sections.
const ALYA_PATH = '/alya';
const LEGACY_EXACT = ['/guide', '/chat', '/avatar-preview', '/about', '/resources', '/mira'];
const LEGACY_PREFIXES = ['/guide/', '/mira/'];

export function legacyRedirect(pathname) {
  if (pathname === '/documents' || pathname === '/dashboard') return '/onboarding';
  if (LEGACY_EXACT.includes(pathname)) return ALYA_PATH;
  if (LEGACY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return ALYA_PATH;
  return null;
}
