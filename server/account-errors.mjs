import { ChatError } from './chat-errors.mjs';

// Account, session and HR errors. They extend ChatError so the chat routes'
// error mapping (conversationFailure) passes them through unchanged. The
// browser receives { code, error } plus any `details` fields.
export class AccountError extends ChatError {
  constructor(status, code, message, details = null) {
    super(status, code, message);
    if (details) this.details = details;
  }
}

export const accountErrors = {
  notConfigured: () =>
    new AccountError(
      503,
      'ACCOUNTS_NOT_CONFIGURED',
      'Employee accounts are not set up on this server. Continue without an account instead.',
    ),
  unavailable: () =>
    new AccountError(
      503,
      'ACCOUNTS_UNAVAILABLE',
      'Accounts are temporarily unavailable. Please try again shortly.',
    ),
  crossOrigin: () =>
    new AccountError(403, 'CROSS_ORIGIN_REJECTED', 'Open OnboardAi on the website itself.'),
  signInInvalid: () => new AccountError(400, 'SIGN_IN_INVALID', 'Enter your ID and password.'),
  // One response for every failed sign-in: unknown ID, wrong password, disabled
  // or locked account. It must not reveal which one applied.
  signInFailed: () =>
    new AccountError(
      401,
      'SIGN_IN_FAILED',
      'The ID or password is incorrect, or this account cannot sign in right now. Check your details or contact HR.',
    ),
  authRequired: () => new AccountError(401, 'AUTH_REQUIRED', 'Sign in to continue.'),
  sessionExpired: () =>
    new AccountError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.'),
  passwordChangeRequired: () =>
    new AccountError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.'),
  hrRequired: () => new AccountError(403, 'HR_ROLE_REQUIRED', 'This page is for HR accounts only.'),
  employeeRequired: () =>
    new AccountError(403, 'EMPLOYEE_ROLE_REQUIRED', 'This page is for employee accounts only.'),
  // Platform administrators (issue #86) use /api/admin only; company accounts
  // never reach it.
  adminRequired: () =>
    new AccountError(403, 'ADMIN_ROLE_REQUIRED', 'This page is for platform administrators.'),
  companyAccountRequired: () =>
    new AccountError(
      403,
      'COMPANY_ACCOUNT_REQUIRED',
      'Platform administrators use the admin dashboard.',
    ),
  employeeNotFound: () =>
    new AccountError(404, 'EMPLOYEE_NOT_FOUND', 'This employee account was not found.'),
  usernameInvalid: () =>
    new AccountError(
      400,
      'USERNAME_INVALID',
      'Use an ID of 3 to 32 letters, numbers, dots, hyphens or underscores.',
    ),
  usernameTaken: () =>
    new AccountError(409, 'USERNAME_TAKEN', 'That ID is already in use. Choose a different ID.'),
  passwordRejected: (message) => new AccountError(400, 'PASSWORD_REJECTED', message),
  passwordChangeInvalid: () =>
    new AccountError(400, 'PASSWORD_CHANGE_INVALID', 'Enter your current and new password.'),
  // The signed-in account is locked after repeated wrong passwords: its session
  // still works, but no password can be checked or changed until the lock ends.
  accountLocked: () =>
    new AccountError(
      429,
      'ACCOUNT_LOCKED',
      'Too many incorrect passwords. Wait up to 15 minutes, then try again.',
    ),
  currentPasswordIncorrect: () =>
    new AccountError(400, 'CURRENT_PASSWORD_INCORRECT', 'The current password is incorrect.'),
  employeeInvalid: () =>
    new AccountError(
      400,
      'EMPLOYEE_INVALID',
      'Send only the employee’s profile. The server assigns the Employee ID and the temporary password.',
    ),
  statusInvalid: () =>
    new AccountError(400, 'STATUS_INVALID', 'Choose a status of active or disabled.'),
  notFound: () => new AccountError(404, 'NOT_FOUND', 'This account action is unavailable.'),
};

// HR Settings: /api/hr/departments. Fixed messages; names are never echoed.
const departmentProblemText = {
  required: 'is required',
  too_long: 'is too long',
  invalid_format: 'is not in the right format',
  reserved: 'is reserved',
};
export const departmentErrors = {
  invalid: (fields) =>
    new AccountError(
      400,
      'DEPARTMENT_INVALID',
      'Check the department: ' +
        (fields.length
          ? fields
              .map(({ field, problem }) => `${field} ${departmentProblemText[problem]}`)
              .join('; ')
          : 'send a name, a prefix or archived') +
        '.',
      { fields },
    ),
  nameTaken: () =>
    new AccountError(
      409,
      'DEPARTMENT_NAME_TAKEN',
      'A department with that name already exists. Choose a different name.',
    ),
  prefixTaken: () =>
    new AccountError(
      409,
      'DEPARTMENT_PREFIX_TAKEN',
      'That prefix is already used by a department. Choose a different prefix.',
    ),
  notFound: () => new AccountError(404, 'DEPARTMENT_NOT_FOUND', 'This department was not found.'),
};

// The onboarding journey (issues #47-#50): footprint steps, scenario checks,
// first-day details and support requests. Fixed messages; values are never echoed.
const fieldProblemText = {
  required: 'is required',
  unknown: 'is not a field here',
  not_text: 'must be text',
  too_long: 'is too long',
  invalid_characters: 'contains line breaks or control characters',
  invalid_time: 'must be a time in HH:MM form',
  invalid_date: 'must be an ISO 8601 date and time',
  invalid_choice: 'is not one of the allowed values',
  not_boolean: 'must be true or false',
};
const listProblems = (fields) =>
  fields
    .slice(0, 5)
    .map(({ field, problem }) => `${field} ${fieldProblemText[problem] || 'is invalid'}`)
    .join('; ') + (fields.length > 5 ? '; and more' : '');
export const journeyErrors = {
  stepNotFound: () =>
    new AccountError(404, 'STEP_NOT_FOUND', 'This onboarding step was not found.'),
  checkRequired: () =>
    new AccountError(
      409,
      'CHECK_REQUIRED',
      'Answer this step’s short scenario check to complete it.',
    ),
  stepLocked: () =>
    new AccountError(
      409,
      'STEP_LOCKED',
      'This step was verified by HR or passed with a scenario check, so it cannot be undone here.',
    ),
  checkNotFound: () =>
    new AccountError(404, 'CHECK_NOT_FOUND', 'This onboarding step has no scenario check.'),
  // A choice check needs { optionId }; a written one { answer } of 1 to maxLength characters.
  checkAnswerInvalid: (check) =>
    new AccountError(
      400,
      'CHECK_ANSWER_INVALID',
      check?.type === 'written'
        ? `Write your answer in up to ${check.maxLength} characters.`
        : 'Choose one of the answers.',
    ),
  checkGraderUnavailable: () =>
    new AccountError(
      503,
      'CHECK_GRADER_UNAVAILABLE',
      'Alya can’t check written answers right now. Please try again in a moment.',
    ),
  briefingRequired: () =>
    new AccountError(409, 'BRIEFING_REQUIRED', 'Listen to Alya’s briefing for this step first.'),
  briefingNotFound: () =>
    new AccountError(404, 'BRIEFING_NOT_FOUND', 'This onboarding step has no briefing.'),
  briefingCompletionInvalid: () =>
    new AccountError(400, 'BRIEFING_COMPLETION_INVALID', 'Send completion "listened" or "read".'),
  stepNotHrVerified: () =>
    new AccountError(
      409,
      'STEP_NOT_HR_VERIFIED',
      'Only steps that HR verifies can be changed in the HR workspace.',
    ),
  stepStatusInvalid: () =>
    new AccountError(400, 'STEP_STATUS_INVALID', 'Choose a status of done or todo.'),
  firstDayInvalid: (fields) =>
    new AccountError(
      400,
      'FIRST_DAY_INVALID',
      `Check the first-day details: ${listProblems(fields) || 'send the details as an object'}.`,
      { fields },
    ),
  supportRequestInvalid: (fields) =>
    new AccountError(
      400,
      'SUPPORT_REQUEST_INVALID',
      `Check the support request: ${listProblems(fields) || 'send the request as an object'}.`,
      { fields },
    ),
  supportRequestNotFound: () =>
    new AccountError(404, 'SUPPORT_REQUEST_NOT_FOUND', 'This support request was not found.'),
  briefingTimeRequired: () =>
    new AccountError(
      400,
      'BRIEFING_TIME_REQUIRED',
      'Choose a briefing date and time before scheduling a briefing.',
    ),
  aiProficiencyInvalid: () =>
    new AccountError(
      400,
      'AI_PROFICIENCY_INVALID',
      'Choose an AI proficiency level from 1 to 10, not_sure, or skipped.',
    ),
  aiProficiencyForbidden: () =>
    new AccountError(
      403,
      'FORBIDDEN',
      'You do not have permission to access or update this AI proficiency record.',
    ),
};

// POST /api/hr/employees/autofill. Fixed messages only: provider text, file
// names and document content never reach the browser.
export const autofillErrors = {
  fileInvalid: () =>
    new AccountError(
      400,
      'AUTOFILL_FILE_INVALID',
      'This file could not be read. Upload a PDF, Word (.docx), text, Markdown, JPG or PNG file that opens without a password.',
    ),
  tooLarge: () =>
    new AccountError(413, 'AUTOFILL_FILE_TOO_LARGE', 'The file must be 5 MB or smaller.'),
  nothingFound: () =>
    new AccountError(
      422,
      'AUTOFILL_NOTHING_FOUND',
      'No employee details were found in this file. Fill in the form yourself.',
    ),
  notConfigured: () =>
    new AccountError(
      503,
      'AUTOFILL_NOT_CONFIGURED',
      'Filling in the form from a document is not set up on this server. Fill in the form yourself.',
    ),
  unavailable: () =>
    new AccountError(
      503,
      'AUTOFILL_UNAVAILABLE',
      'Filling in the form from a document is temporarily unavailable. Try again shortly or fill in the form yourself.',
    ),
  rateLimited: () =>
    new AccountError(
      429,
      'AUTOFILL_RATE_LIMITED',
      'Too many documents are being read right now. Wait a moment, then try again.',
    ),
  timeout: () =>
    new AccountError(
      504,
      'AUTOFILL_TIMEOUT',
      'Reading the document took too long. Try again, or fill in the form yourself.',
    ),
};

// /api/admin (issue #86): companies, their profiles, HR accounts and the
// audit trail. Fixed messages; names and values are never echoed.
const companyProblemText = {
  required: 'is required',
  too_long: 'is too long',
  invalid_format: 'is not in the right format',
};
export const companyErrors = {
  invalid: (fields) =>
    new AccountError(
      400,
      'COMPANY_INVALID',
      'Check the company: ' +
        (fields.length
          ? fields
              .map(
                ({ field, problem }) => `${field} ${companyProblemText[problem] || 'is invalid'}`,
              )
              .join('; ')
          : 'send a name') +
        '.',
      { fields },
    ),
  nameTaken: () =>
    new AccountError(
      409,
      'COMPANY_NAME_TAKEN',
      'A company with that name already exists. Choose a different name.',
    ),
  idTaken: () => new AccountError(409, 'COMPANY_ID_TAKEN', 'That company ID is already in use.'),
  notFound: () => new AccountError(404, 'COMPANY_NOT_FOUND', 'This company was not found.'),
  statusInvalid: () =>
    new AccountError(400, 'COMPANY_STATUS_INVALID', 'Choose a status of active or disabled.'),
  hrAccountInvalid: () =>
    new AccountError(
      400,
      'HR_ACCOUNT_INVALID',
      'Send only makeDefault (true or false). The server assigns the HR ID and the temporary password.',
    ),
  hrAccountNotFound: () =>
    new AccountError(404, 'HR_ACCOUNT_NOT_FOUND', 'This HR account was not found in this company.'),
  eventsQueryInvalid: () =>
    new AccountError(
      400,
      'EVENTS_QUERY_INVALID',
      'Use a company ID, a numeric before and a limit from 1 to 100.',
    ),
};

const profileProblemText = {
  unknown: 'is not a profile field',
  not_object: 'must be a group of fields',
  not_list: 'must be a list',
  not_text: 'must be text',
  too_long: 'is too long',
  too_many: 'has too many entries',
  invalid_characters: 'contains line breaks or control characters',
  required: 'is required',
};
export const companyProfileErrors = {
  invalid: (fields) =>
    new AccountError(
      400,
      'COMPANY_PROFILE_INVALID',
      'Check the company profile: ' +
        (fields.length
          ? fields
              .slice(0, 5)
              .map(
                ({ field, problem }) => `${field} ${profileProblemText[problem] || 'is invalid'}`,
              )
              .join('; ') + (fields.length > 5 ? '; and more' : '')
          : 'send { profile, version }') +
        '.',
      { fields },
    ),
  conflict: () =>
    new AccountError(
      409,
      'COMPANY_PROFILE_CONFLICT',
      'The company profile was changed by someone else. Reload it, then make your changes again.',
    ),
  tooLarge: () =>
    new AccountError(
      413,
      'COMPANY_PROFILE_TOO_LARGE',
      'The company profile is too large. Shorten some sections.',
    ),
};

// POST /api/admin/profile-digest: Gemini reads a company profile document.
export const digestErrors = {
  fileInvalid: () =>
    new AccountError(
      400,
      'DIGEST_FILE_INVALID',
      'This file could not be read. Upload a PDF, Word (.docx), text or Markdown file that opens without a password.',
    ),
  tooLarge: () =>
    new AccountError(413, 'DIGEST_FILE_TOO_LARGE', 'The file must be 5 MB or smaller.'),
  nothingFound: () =>
    new AccountError(
      422,
      'DIGEST_NOTHING_FOUND',
      'No company profile details were found in this document. Fill in the profile yourself.',
    ),
  notConfigured: () =>
    new AccountError(
      503,
      'DIGEST_NOT_CONFIGURED',
      'Drafting the profile from a document is not set up on this server. Fill in the profile yourself.',
    ),
  unavailable: () =>
    new AccountError(
      503,
      'DIGEST_UNAVAILABLE',
      'Drafting the profile from a document is temporarily unavailable. Try again shortly or fill in the profile yourself.',
    ),
  rateLimited: () =>
    new AccountError(
      429,
      'DIGEST_RATE_LIMITED',
      'Too many documents are being read right now. Wait a moment, then try again.',
    ),
  timeout: () =>
    new AccountError(
      504,
      'DIGEST_TIMEOUT',
      'Reading the document took too long. Try again, or fill in the profile yourself.',
    ),
};
