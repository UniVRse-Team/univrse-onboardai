// Browser client for the platform-admin routes (contract #86 section 4.3).
// The session is an HttpOnly cookie; nothing here reads or stores a secret.

import { accountRequest } from '../access/account-api.mjs';

const enc = encodeURIComponent;
const base = (companyId) => '/api/admin/companies/' + enc(companyId);

export const DIGEST_PASTED_NAME = 'pasted-text.txt';
export const digestExtensions = ['.pdf', '.docx', '.txt', '.md'];
export const digestAccept = digestExtensions.join(',');
export const maxDigestBytes = 5 * 1024 * 1024;

// Describes POST /api/admin/profile-digest. `input` is { file } (a File) or
// { text } (pasted). Pasted text is sent as the UTF-8 file pasted-text.txt.
export function buildDigestRequest(input, encoder = new TextEncoder()) {
  const hasText = typeof input?.text === 'string' && input.text.trim() !== '';
  const body = input?.file ?? (hasText ? encoder.encode(input.text) : null);
  if (!body) throw new TypeError('A file or pasted text is required.');
  const name = input?.file ? input.file.name : DIGEST_PASTED_NAME;
  return {
    url: '/api/admin/profile-digest',
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': enc(name),
    },
    rawBody: body,
  };
}

// Returns an error message, or '' when the file can be sent.
export function validateDigestFile(file) {
  if (!file) return 'Choose a file.';
  const dot = String(file.name || '').lastIndexOf('.');
  const extension = dot < 0 ? '' : file.name.slice(dot).toLowerCase();
  if (!digestExtensions.includes(extension))
    return 'Upload a PDF, Word (.docx), text or Markdown file.';
  if (!file.size) return 'That file is empty.';
  if (file.size > maxDigestBytes) return 'That file is larger than 5 MB.';
  return '';
}

const digestErrors = {
  DIGEST_FILE_INVALID:
    'That file could not be read. Use a PDF, Word (.docx), text or Markdown file.',
  DIGEST_FILE_TOO_LARGE: 'That file is larger than 5 MB.',
  DIGEST_NOTHING_FOUND: 'No company facts were found in that document. Try another one.',
  DIGEST_RATE_LIMITED: 'That is a lot of drafts at once. Wait a minute, then try again.',
  DIGEST_NOT_CONFIGURED: 'Drafting from a document is not set up on this server.',
  DIGEST_UNAVAILABLE: 'Gemini is not available right now. Try again in a moment.',
  DIGEST_TIMEOUT: 'Gemini took too long to read the document. Try a shorter one.',
};
export const digestErrorMessage = (error) =>
  digestErrors[error?.code] || error?.message || 'The draft could not be made. Please try again.';

export const adminApi = {
  companies: (options) => accountRequest('/api/admin/companies', options),
  // body: { name, id? } -> { company }
  createCompany: ({ name, id }) =>
    accountRequest('/api/admin/companies', {
      method: 'POST',
      body: id ? { name, id } : { name },
    }),
  company: (companyId, options) => accountRequest(base(companyId), options),
  renameCompany: (companyId, name) =>
    accountRequest(base(companyId), { method: 'PATCH', body: { name } }),
  setStatus: (companyId, status) =>
    accountRequest(base(companyId) + '/status', { method: 'PUT', body: { status } }),
  profile: (companyId, options) => accountRequest(base(companyId) + '/profile', options),
  saveProfile: (companyId, body) =>
    accountRequest(base(companyId) + '/profile', { method: 'PUT', body }),
  // Nothing is stored by this call; the answer only fills the form.
  digest: (input, signal) => {
    const { url, method, headers, rawBody } = buildDigestRequest(input);
    return accountRequest(url, { method, headers, rawBody, signal });
  },
  hrAccounts: (companyId, options) => accountRequest(base(companyId) + '/hr-accounts', options),
  // -> { hrAccount, temporaryPassword, company }
  createHrAccount: (companyId, body = {}) =>
    accountRequest(base(companyId) + '/hr-accounts', { method: 'POST', body }),
  resetHrPassword: (companyId, accountId) =>
    accountRequest(base(companyId) + '/hr-accounts/' + enc(accountId) + '/password', {
      method: 'POST',
    }),
  setDefaultHr: (companyId, accountId) =>
    accountRequest(base(companyId) + '/default-hr', { method: 'PUT', body: { accountId } }),
  events: (companyId, { before, limit } = {}, options) => {
    const query = new URLSearchParams({ companyId });
    if (before) query.set('before', before);
    if (limit) query.set('limit', String(limit));
    return accountRequest('/api/admin/events?' + query.toString(), options);
  },
};

// POST …/hr-accounts answers with the temporary password. This splits the answer
// so only `secret` (shown once in the dialog) holds it; `hrAccount` and `company`
// are safe to keep in page state.
export function splitCreatedHr(response) {
  const { hrAccount, company, temporaryPassword } = response || {};
  return {
    hrAccount,
    company,
    secret: { username: hrAccount?.username ?? '', temporaryPassword: temporaryPassword ?? '' },
  };
}

export function splitResetHr(response, username = '') {
  const { hrAccount, temporaryPassword } = response || {};
  return {
    hrAccount,
    secret: {
      username: hrAccount?.username || username,
      temporaryPassword: temporaryPassword || response?.temporaryPassword || '',
    },
  };
}

export function copyHrText({ username, temporaryPassword }) {
  return `HR ID: ${username}\nTemporary password: ${temporaryPassword}`;
}

export const oneTimeNote =
  'Shown once; they must change it at first sign-in. Copy it now and share it securely.';

const companyErrors = {
  COMPANY_NAME_TAKEN: 'Another company already uses that name.',
  COMPANY_ID_TAKEN: 'Another company already uses that ID.',
  COMPANY_NOT_FOUND: 'That company no longer exists.',
};
export const companyErrorMessage = (error) =>
  companyErrors[error?.code] ||
  error?.message ||
  'The change could not be saved. Please try again.';

// 400 COMPANY_INVALID { fields: [{ field: name|id, problem }] } -> { name, id }
export function companyFieldErrors(fields) {
  const text = {
    required: 'This is required.',
    too_long: 'This is too long.',
    invalid_format:
      'Use lower-case letters, numbers and hyphens, 3 to 32 characters, starting with a letter.',
  };
  const errors = {};
  for (const item of Array.isArray(fields) ? fields : [])
    if (item?.field) errors[item.field] = text[item.problem] || 'This value is not valid.';
  return errors;
}

export const companyIdPattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const companyNameMax = 80;

// Client check before POST /api/admin/companies. -> { name?, id? } messages
export function validateNewCompany({ name, id }) {
  const errors = {};
  const trimmed = String(name ?? '').trim();
  if (!trimmed) errors.name = 'Enter the company name.';
  else if (trimmed.length > companyNameMax)
    errors.name = `Keep the name to ${companyNameMax} characters or fewer.`;
  const advanced = String(id ?? '').trim();
  if (advanced && !companyIdPattern.test(advanced))
    errors.id =
      'Use lower-case letters, numbers and hyphens, 3 to 32 characters, starting with a letter.';
  return errors;
}

export const statusLabel = (status) => (status === 'disabled' ? 'Disabled' : 'Active');

// One line for a CompanySummary's counts.
export function countsLabel(counts) {
  const hr = counts?.hr ?? 0;
  const employees = counts?.employees ?? 0;
  return `${hr} HR ${hr === 1 ? 'account' : 'accounts'} · ${employees} ${employees === 1 ? 'employee' : 'employees'}`;
}

const actionLabels = {
  company_created: 'Company created',
  company_updated: 'Company renamed',
  company_disabled: 'Company disabled',
  company_enabled: 'Company enabled',
  company_profile_updated: 'Company profile saved',
  company_default_hr_set: 'Default HR changed',
  hr_account_created: 'HR account created',
  admin_created: 'Administrator created',
};
export const eventLabel = (action) =>
  actionLabels[action] || String(action || 'Event').replace(/_/g, ' ');

// One short sentence for an AdminEvent: who did what to whom.
export function eventSummary(event) {
  const who = event?.actor?.username || 'The system';
  const target = event?.target?.username || event?.targetLabel || '';
  return `${who}${target ? ' · ' + target : ''}`;
}
