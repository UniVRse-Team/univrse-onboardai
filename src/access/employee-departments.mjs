// Department choices and the pieces of the "create employee" flow that need no
// DOM, so they can be unit-tested. The department list comes from the API
// (GET /api/hr/departments): [{ id, name, prefix, archived, exampleId, employees }].

export const departmentPlaceholder = 'Choose department';
export const departmentRequiredMessage = 'Choose a department.';
export const autoIdNote =
  'The Employee ID and a temporary password are created automatically from the department.';

const norm = (value) => String(value ?? '').trim();
const list = (departments) => (Array.isArray(departments) ? departments : []);

export function activeDepartments(departments) {
  return list(departments).filter((department) => !department.archived);
}

// New hires need an active department.
export function isKnownDepartment(departments, value) {
  return activeDepartments(departments).some((department) => department.name === norm(value));
}

// Options for the Department <select>: the active departments. `current` is the
// stored value of an employee being edited: when it is not active (archived or
// legacy text), it comes first as "<text> (current)" so HR can keep it.
// -> [{ value, label, legacy? }]
export function departmentOptions(departments, current = '') {
  const options = activeDepartments(departments).map(({ name }) => ({ value: name, label: name }));
  const stored = norm(current);
  if (stored && !isKnownDepartment(departments, stored))
    options.unshift({ value: stored, label: `${stored} (current)`, legacy: true });
  return options;
}

// The value the <select> should show: '' (placeholder) when nothing usable.
export function selectedDepartment(departments, value, current = '') {
  const chosen = norm(value);
  return departmentOptions(departments, current).some((option) => option.value === chosen)
    ? chosen
    : '';
}

export const emptyDepartmentsMessage = 'Add a department in Settings first';

// Client check for the add form; the server re-checks. -> message or null
export function departmentProblem(form, departments) {
  if (Array.isArray(departments) && departments.length === 0) return emptyDepartmentsMessage;
  return isKnownDepartment(departments, form?.job?.department) ? null : departmentRequiredMessage;
}

// "IDs look like PE-0001" for the chosen department, '' when none chosen.
export function idFormatHint(departments, department) {
  if (Array.isArray(departments) && departments.length === 0) return emptyDepartmentsMessage;
  const match = list(departments).find((item) => item.name === norm(department));
  return match ? `IDs look like ${match.prefix}-0001` : '';
}

// The create request carries the profile only: the server assigns ID and password.
export function createEmployeeBody(profile) {
  return { profile };
}

export function copyBothText({ username, temporaryPassword }) {
  return `Employee ID: ${username}\nTemporary password: ${temporaryPassword}`;
}

export const manualCopyMessage = 'Press ⌘C / Ctrl+C to copy';

// Tries the async clipboard; falls back to "select the text" when it is missing
// or refuses. -> { copied: boolean, fallback: boolean }
export async function copyToClipboard(text, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard || typeof clipboard.writeText !== 'function')
    return { copied: false, fallback: true };
  try {
    await clipboard.writeText(text);
    return { copied: true, fallback: false };
  } catch {
    return { copied: false, fallback: true };
  }
}

export function copyStatusMessage(what, result) {
  return result.copied ? `Copied ${what}` : manualCopyMessage;
}
