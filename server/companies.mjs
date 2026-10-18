// Companies (tenants, issue #86). Import-free so the migrations, scripts and
// the browser-facing services can all share the same rules.
//
// A company id is an immutable slug. The default company is UniVRse: every
// account and record that existed before #86 belongs to it (SQL migration
// 005_companies.sql and Firestore migration 011_company_scope.mjs write the same
// literal), and it keeps the UniVRse onboarding content. Every other company
// gets the company-neutral starter content pack.
export const DEFAULT_COMPANY_ID = 'univrse';
export const DEFAULT_COMPANY_NAME = 'UniVRse';
export const companyIdPattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const companyNameMax = 80;
export const companyStatuses = Object.freeze(['active', 'disabled']);
export const contentPacks = Object.freeze(['univrse', 'starter']);

export const isCompanyId = (value) => typeof value === 'string' && companyIdPattern.test(value);

// UniVRse keeps its own content; every other company gets the starter pack.
// There is no column for this, so no company can be given UniVRse's content.
export const contentPackOf = (companyId) =>
  companyId === DEFAULT_COMPANY_ID ? 'univrse' : 'starter';

// The onboardingTemplates document of a company's track: {track} for UniVRse
// (unchanged since #47), starter.{track} for the starter pack.
export const templateDocId = (companyId, track) =>
  contentPackOf(companyId) === 'univrse' ? track : `starter.${track}`;

// A company id derived from its name: lower case, runs of anything else as
// one hyphen, cut to 32 characters. '' when nothing usable is left.
export function companyIdFromName(name) {
  let id = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  if (id.length < 3) id = id ? `${id}-co` : '';
  return isCompanyId(id) ? id : '';
}
