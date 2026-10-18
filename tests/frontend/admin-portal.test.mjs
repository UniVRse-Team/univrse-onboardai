import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigestRequest,
  validateDigestFile,
  digestErrorMessage,
  validateNewCompany,
  companyErrorMessage,
  splitCreatedHr,
  splitResetHr,
  copyHrText,
  oneTimeNote,
  countsLabel,
  eventLabel,
  eventSummary,
  statusLabel,
  DIGEST_PASTED_NAME,
} from '../../src/admin/admin-api.mjs';
import {
  emptyProfileForm,
  profileToForm,
  formToProfile,
  validateProfileForm,
  saveErrorInfo,
  warningLines,
  fieldLabel,
  isProfileDirty,
  textFields,
  listFields,
  lineListFields,
} from '../../src/admin/company-profile-form.mjs';
import {
  parseAdminPath,
  adminCompanyPath,
  isAdminArea,
  parseCompanyTenantPath,
  companyTenantPath,
} from '../../src/access/account-routing.mjs';

test('parseAdminPath parses dashboard and company routes and rejects malformed paths', () => {
  assert.deepEqual(parseAdminPath('/admin'), { page: 'dashboard' });
  assert.deepEqual(parseAdminPath('/admin/'), { page: 'dashboard' });
  assert.deepEqual(parseAdminPath('/admin/companies/acme'), { page: 'company', companyId: 'acme' });
  assert.deepEqual(parseAdminPath('/admin/companies/univrse/'), {
    page: 'company',
    companyId: 'univrse',
  });
  assert.equal(parseAdminPath('/admin/companies'), null);
  assert.equal(parseAdminPath('/admin/companies/'), null);
  assert.equal(parseAdminPath('/admin/companies/bad_id_with_underscore'), null);
  assert.equal(parseAdminPath('/admin/companies/-leading-hyphen'), null);
  assert.equal(parseAdminPath('/admin/companies/trailing-hyphen-'), null);
  assert.equal(parseAdminPath('/hr'), null);
  assert.equal(parseAdminPath('/dashboard'), null);
});

test('adminCompanyPath builds the expected path', () => {
  assert.equal(adminCompanyPath('acme-corp'), '/admin/companies/acme-corp');
});

test('companyTenantPath and parseCompanyTenantPath handle tenant URLs', () => {
  assert.equal(companyTenantPath('luna-digital'), '/companies/luna-digital');
  assert.deepEqual(parseCompanyTenantPath('/companies/luna-digital'), {
    companyId: 'luna-digital',
  });
  assert.deepEqual(parseCompanyTenantPath('/companies/luna-digital/'), {
    companyId: 'luna-digital',
  });
  assert.deepEqual(parseCompanyTenantPath('/companies/luna-digital/login'), {
    companyId: 'luna-digital',
  });
  assert.equal(companyTenantPath('univrse'), '/companies/univrse');
  assert.deepEqual(parseCompanyTenantPath('/companies/univrse'), { companyId: 'univrse' });
  assert.deepEqual(parseCompanyTenantPath('/companies/univrse/'), { companyId: 'univrse' });
  assert.deepEqual(parseCompanyTenantPath('/companies/univrse/login'), { companyId: 'univrse' });
  assert.deepEqual(parseCompanyTenantPath('/companies/acme-corp'), { companyId: 'acme-corp' });
  assert.equal(parseCompanyTenantPath('/companies'), null);
  assert.equal(parseCompanyTenantPath('/companies/'), null);
  assert.equal(parseCompanyTenantPath('/companies/BAD_CAPS'), null);
  assert.equal(parseCompanyTenantPath('/admin'), null);
});

test('isAdminArea identifies admin area correctly', () => {
  assert.equal(isAdminArea('/admin'), true);
  assert.equal(isAdminArea('/admin/companies/acme'), true);
  assert.equal(isAdminArea('/hr'), false);
  assert.equal(isAdminArea('/dashboard'), false);
});

test('validateNewCompany validates names and optional custom slug IDs', () => {
  assert.deepEqual(validateNewCompany({ name: 'Acme Corp' }), {});
  assert.equal(validateNewCompany({ name: '' }).name, 'Enter the company name.');
  assert.equal(validateNewCompany({ name: '   ' }).name, 'Enter the company name.');
  assert.ok(validateNewCompany({ name: 'a'.repeat(81) }).name);

  // Valid custom ID
  assert.deepEqual(validateNewCompany({ name: 'Acme', id: 'acme-corp' }), {});
  // Invalid custom IDs
  assert.ok(validateNewCompany({ name: 'Acme', id: '123-bad' }).id);
  assert.ok(validateNewCompany({ name: 'Acme', id: 'BadCaps' }).id);
  assert.ok(validateNewCompany({ name: 'Acme', id: 'a' }).id);
  assert.ok(validateNewCompany({ name: 'Acme', id: '-hyphen' }).id);
});

test('validateDigestFile checks file type, empty files and size limits', () => {
  assert.equal(validateDigestFile({ name: 'handbook.pdf', size: 1024 }), '');
  assert.equal(validateDigestFile({ name: 'policy.docx', size: 1024 }), '');
  assert.equal(validateDigestFile({ name: 'readme.txt', size: 1024 }), '');
  assert.equal(validateDigestFile({ name: 'guide.md', size: 1024 }), '');

  assert.equal(validateDigestFile(null), 'Choose a file.');
  assert.equal(
    validateDigestFile({ name: 'sheet.xlsx', size: 1024 }),
    'Upload a PDF, Word (.docx), text or Markdown file.',
  );
  assert.equal(validateDigestFile({ name: 'empty.pdf', size: 0 }), 'That file is empty.');
  assert.equal(
    validateDigestFile({ name: 'huge.pdf', size: 6 * 1024 * 1024 }),
    'That file is larger than 5 MB.',
  );
});

test('buildDigestRequest supports both files and pasted text as UTF-8 files', () => {
  const file = { name: 'handbook.pdf', size: 100 };
  const fileReq = buildDigestRequest({ file });
  assert.equal(fileReq.url, '/api/admin/profile-digest');
  assert.equal(fileReq.method, 'POST');
  assert.equal(fileReq.headers['Content-Type'], 'application/octet-stream');
  assert.equal(fileReq.headers['X-File-Name'], 'handbook.pdf');
  assert.equal(fileReq.rawBody, file);

  const textReq = buildDigestRequest({ text: 'Company mission statement' });
  assert.equal(textReq.headers['X-File-Name'], encodeURIComponent(DIGEST_PASTED_NAME));
  assert.ok(textReq.rawBody instanceof Uint8Array);

  assert.throws(() => buildDigestRequest({}), /A file or pasted text is required/);
  assert.throws(() => buildDigestRequest({ text: '   ' }), /A file or pasted text is required/);
});

test('digestErrorMessage maps server error codes', () => {
  assert.match(digestErrorMessage({ code: 'DIGEST_FILE_INVALID' }), /could not be read/);
  assert.match(digestErrorMessage({ code: 'DIGEST_FILE_TOO_LARGE' }), /larger than 5 MB/);
  assert.match(digestErrorMessage({ code: 'DIGEST_NOTHING_FOUND' }), /No company facts/);
  assert.match(digestErrorMessage({ code: 'DIGEST_RATE_LIMITED' }), /Wait a minute/);
  assert.match(digestErrorMessage({ code: 'DIGEST_NOT_CONFIGURED' }), /not set up/);
  assert.match(digestErrorMessage({ code: 'DIGEST_UNAVAILABLE' }), /Gemini is not available/);
  assert.match(digestErrorMessage({ code: 'DIGEST_TIMEOUT' }), /took too long/);
});

test('splitCreatedHr and splitResetHr separate temporary password into secret', () => {
  const created = splitCreatedHr({
    hrAccount: { id: 'hr-1', username: 'HR-0001' },
    company: { id: 'acme' },
    temporaryPassword: 'temp-pass-123',
  });
  assert.equal(created.hrAccount.username, 'HR-0001');
  assert.equal(created.secret.username, 'HR-0001');
  assert.equal(created.secret.temporaryPassword, 'temp-pass-123');

  const reset = splitResetHr(
    { hrAccount: { id: 'hr-1', username: 'HR-0001' }, temporaryPassword: 'new-temp-456' },
    'HR-0001',
  );
  assert.equal(reset.secret.username, 'HR-0001');
  assert.equal(reset.secret.temporaryPassword, 'new-temp-456');

  assert.equal(copyHrText(reset.secret), 'HR ID: HR-0001\nTemporary password: new-temp-456');
  assert.ok(oneTimeNote.includes('Shown once'));
});

test('countsLabel and event helpers format correctly', () => {
  assert.equal(countsLabel({ hr: 1, employees: 5 }), '1 HR account · 5 employees');
  assert.equal(countsLabel({ hr: 2, employees: 1 }), '2 HR accounts · 1 employee');
  assert.equal(statusLabel('active'), 'Active');
  assert.equal(statusLabel('disabled'), 'Disabled');

  assert.equal(eventLabel('company_created'), 'Company created');
  assert.equal(eventLabel('company_updated'), 'Company renamed');
  assert.equal(eventLabel('company_disabled'), 'Company disabled');
  assert.equal(eventLabel('company_enabled'), 'Company enabled');
  assert.equal(
    eventSummary({ actor: { username: 'admin' }, target: { username: 'HR-0001' } }),
    'admin · HR-0001',
  );
});

test('profile form conversion and dirty tracking', () => {
  const empty = emptyProfileForm();
  assert.equal(empty.overview, '');
  assert.deepEqual(empty.values, []);
  assert.deepEqual(empty.benefits, []);

  const profile = {
    overview: 'Acme produces widgets.',
    mission: 'To build widgets.',
    values: [{ name: 'Quality', description: 'High standards' }],
    benefits: ['Health insurance', 'Remote allowance'],
  };

  const form = profileToForm(profile);
  assert.equal(form.overview, 'Acme produces widgets.');
  assert.equal(form.values[0].name, 'Quality');
  assert.deepEqual(form.benefits, ['Health insurance', 'Remote allowance']);

  const back = formToProfile(form);
  assert.equal(back.overview, 'Acme produces widgets.');
  assert.equal(back.values[0].name, 'Quality');
  assert.deepEqual(back.benefits, ['Health insurance', 'Remote allowance']);

  assert.equal(isProfileDirty(form, profile), false);
  assert.equal(isProfileDirty({ ...form, overview: 'Changed' }, profile), true);
});

test('profile form validation enforces field limits and character constraints', () => {
  const valid = emptyProfileForm();
  valid.overview = 'Valid overview text';
  assert.deepEqual(validateProfileForm(valid), {});

  // Text too long
  const longOverview = emptyProfileForm();
  longOverview.overview = 'a'.repeat(2001);
  const errors = validateProfileForm(longOverview);
  assert.ok(errors.overview);

  // List field required check
  const listForm = emptyProfileForm();
  listForm.values = [{ name: '', description: 'No name given' }];
  const listErrors = validateProfileForm(listForm);
  assert.equal(listErrors['values[0].name'], 'This is required.');
});

test('saveErrorInfo maps conflict and validation errors', () => {
  const conflict = saveErrorInfo({ status: 409, code: 'COMPANY_PROFILE_CONFLICT' });
  assert.equal(conflict.conflict, true);
  assert.match(conflict.message, /Someone else saved this profile/);

  const invalid = saveErrorInfo({
    code: 'COMPANY_PROFILE_INVALID',
    fields: [{ field: 'overview', problem: 'too_long' }],
  });
  assert.equal(invalid.conflict, false);
  assert.equal(invalid.fields.overview, 'This is too long.');

  const warnings = warningLines([{ field: 'faqs[0].answer', problem: 'too_long' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Frequently asked questions, item 1, Answer/);
});

test('company rename validation and error messages handle empty, long and taken names', () => {
  const empty = validateNewCompany({ name: '' });
  assert.equal(empty.name, 'Enter the company name.');

  const whitespace = validateNewCompany({ name: '   ' });
  assert.equal(whitespace.name, 'Enter the company name.');

  const tooLong = validateNewCompany({ name: 'a'.repeat(81) });
  assert.equal(tooLong.name, 'Keep the name to 80 characters or fewer.');

  const valid = validateNewCompany({ name: 'Valid Company' });
  assert.equal(valid.name, undefined);

  assert.equal(
    companyErrorMessage({ code: 'COMPANY_NAME_TAKEN' }),
    'Another company already uses that name.',
  );
  assert.equal(
    companyErrorMessage({ code: 'COMPANY_NOT_FOUND' }),
    'That company no longer exists.',
  );
});

import { filterAccountByPath } from '../../src/access/use-account-session.js';

test('filterAccountByPath prevents cross-contamination between admin and non-admin tabs', () => {
  const adminAccount = { id: 'adm-1', username: 'admin', role: 'admin' };
  const hrAccount = { id: 'hr-1', username: 'HR-0001', role: 'hr' };
  const empAccount = { id: 'emp-1', username: 'EMP-0001', role: 'employee' };

  // Admin paths only accept admin accounts
  assert.deepEqual(filterAccountByPath(adminAccount, '/admin'), adminAccount);
  assert.deepEqual(filterAccountByPath(adminAccount, '/admin/companies/acme'), adminAccount);
  assert.equal(filterAccountByPath(hrAccount, '/admin'), null);
  assert.equal(filterAccountByPath(empAccount, '/admin/companies/acme'), null);

  // Non-admin paths only accept non-admin accounts
  assert.deepEqual(filterAccountByPath(hrAccount, '/hr'), hrAccount);
  assert.deepEqual(filterAccountByPath(empAccount, '/onboarding'), empAccount);
  assert.equal(filterAccountByPath(adminAccount, '/hr'), null);
  assert.equal(filterAccountByPath(adminAccount, '/onboarding'), null);
  assert.equal(filterAccountByPath(adminAccount, '/login'), null);

  // Null account returns null
  assert.equal(filterAccountByPath(null, '/admin'), null);
});
