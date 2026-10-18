// The company profile form (contract #86 section 2): field limits, the empty
// profile, and the helpers that turn form state into the PUT body and back.
// Pure functions, so they are unit-tested without a DOM.

// kind: line = one line, para = may hold newlines.
export const textFields = [
  {
    key: 'overview',
    label: 'Overview',
    kind: 'para',
    max: 2000,
    rows: 5,
    hint: 'What the company does and who its customers are.',
  },
  { key: 'mission', label: 'Mission', kind: 'para', max: 500, rows: 3 },
  { key: 'vision', label: 'Vision', kind: 'para', max: 500, rows: 3 },
  { key: 'workingHours', label: 'Working hours', kind: 'para', max: 500, rows: 3 },
  { key: 'dressCode', label: 'Dress code', kind: 'para', max: 800, rows: 3 },
  { key: 'policiesSummary', label: 'Policies summary', kind: 'para', max: 2000, rows: 5 },
];

// Lists of objects. required: item fields that must be filled when the item is used.
export const listFields = [
  {
    key: 'values',
    label: 'Values',
    itemLabel: 'value',
    max: 10,
    required: ['name'],
    fields: [
      { key: 'name', label: 'Name', kind: 'line', max: 60 },
      { key: 'description', label: 'Description', kind: 'para', max: 300 },
    ],
  },
  {
    key: 'productsAndServices',
    label: 'Products and services',
    itemLabel: 'product or service',
    max: 15,
    required: ['name'],
    fields: [
      { key: 'name', label: 'Name', kind: 'line', max: 80 },
      { key: 'description', label: 'Description', kind: 'para', max: 400 },
    ],
  },
  {
    key: 'locations',
    label: 'Locations',
    itemLabel: 'location',
    max: 8,
    required: ['name'],
    fields: [
      { key: 'name', label: 'Name', kind: 'line', max: 80 },
      { key: 'address', label: 'Address', kind: 'para', max: 200 },
      { key: 'notes', label: 'Notes', kind: 'para', max: 200 },
    ],
  },
  {
    key: 'contacts',
    label: 'Contacts by department',
    itemLabel: 'contact',
    max: 15,
    required: ['department'],
    hint: 'Use department names and department mailboxes or channels, never a person’s name.',
    fields: [
      { key: 'department', label: 'Department', kind: 'line', max: 60 },
      { key: 'purpose', label: 'What to contact them about', kind: 'line', max: 200 },
      { key: 'channel', label: 'Channel or mailbox', kind: 'line', max: 120 },
    ],
  },
  {
    key: 'faqs',
    label: 'Frequently asked questions',
    itemLabel: 'question',
    max: 25,
    required: ['question', 'answer'],
    fields: [
      { key: 'question', label: 'Question', kind: 'line', max: 200 },
      { key: 'answer', label: 'Answer', kind: 'para', max: 600 },
    ],
  },
];

// A list of single lines.
export const lineListFields = [
  { key: 'benefits', label: 'Benefits', itemLabel: 'benefit', max: 15, itemMax: 200 },
];

export const profileKeys = [
  ...textFields.map((field) => field.key),
  ...listFields.map((field) => field.key),
  ...lineListFields.map((field) => field.key),
];

export const contactsHint = listFields.find((field) => field.key === 'contacts').hint;

export function emptyItem(listField) {
  return Object.fromEntries(listField.fields.map((field) => [field.key, '']));
}

export function emptyProfileForm() {
  const form = {};
  for (const field of textFields) form[field.key] = '';
  for (const field of listFields) form[field.key] = [];
  for (const field of lineListFields) form[field.key] = [];
  return form;
}

const asText = (value) => (typeof value === 'string' ? value : '');
const asList = (value) => (Array.isArray(value) ? value : []);

// A server profile (or a Gemini draft, whose missing fields are null) -> form state.
export function profileToForm(profile) {
  const form = emptyProfileForm();
  const source = profile && typeof profile === 'object' ? profile : {};
  for (const field of textFields) form[field.key] = asText(source[field.key]);
  for (const field of listFields)
    form[field.key] = asList(source[field.key])
      .filter((item) => item && typeof item === 'object')
      .map((item) =>
        Object.fromEntries(field.fields.map((part) => [part.key, asText(item[part.key])])),
      );
  for (const field of lineListFields)
    form[field.key] = asList(source[field.key]).map((item) => asText(item));
  return form;
}

const trim = (value) => String(value ?? '').trim();
const isBlank = (item) => Object.values(item).every((value) => trim(value) === '');

// Form state -> the body of PUT .../profile. Text is trimmed, CRLF becomes \n,
// and list items with every field empty are dropped (the server does the same).
export function formToProfile(form) {
  const profile = {};
  const clean = (value) => trim(String(value ?? '').replace(/\r\n?/g, '\n'));
  for (const field of textFields) profile[field.key] = clean(form?.[field.key]);
  for (const field of listFields)
    profile[field.key] = asList(form?.[field.key])
      .map((item) =>
        Object.fromEntries(field.fields.map((part) => [part.key, clean(item?.[part.key])])),
      )
      .filter((item) => !isBlank(item));
  for (const field of lineListFields)
    profile[field.key] = asList(form?.[field.key])
      .map((item) => clean(item))
      .filter(Boolean);
  return profile;
}

// The body of PUT .../profile: full replacement, guarded by the version read.
export const saveProfileBody = (form, version) => ({
  profile: formToProfile(form),
  version,
});

export const problemMessages = {
  unknown: 'This field is not part of the profile.',
  not_object: 'This entry is not valid.',
  not_list: 'This field must be a list.',
  not_text: 'This field must be text.',
  too_long: 'This is too long.',
  too_many: 'There are too many entries.',
  invalid_characters: 'Remove line breaks or special characters.',
  required: 'This is required.',
};

const control = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const paraControl = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

function textProblem(value, { kind, max }) {
  const text = trim(String(value ?? '').replace(/\r\n?/g, '\n'));
  if (text.length > max) return `Keep this to ${max} characters or fewer (now ${text.length}).`;
  if ((kind === 'line' ? control : paraControl).test(text))
    return problemMessages.invalid_characters;
  return '';
}

// Client-side check that mirrors the server rules. -> { 'faqs[0].answer': message }
export function validateProfileForm(form) {
  const errors = {};
  for (const field of textFields) {
    const problem = textProblem(form?.[field.key], field);
    if (problem) errors[field.key] = problem;
  }
  for (const field of listFields) {
    const items = asList(form?.[field.key]).filter((item) => !isBlank(item));
    if (items.length > field.max)
      errors[field.key] = `Keep ${field.label.toLowerCase()} to ${field.max} entries or fewer.`;
    asList(form?.[field.key]).forEach((item, index) => {
      if (isBlank(item)) return;
      for (const part of field.fields) {
        const path = `${field.key}[${index}].${part.key}`;
        if (field.required.includes(part.key) && !trim(item[part.key])) {
          errors[path] = problemMessages.required;
          continue;
        }
        const problem = textProblem(item[part.key], part);
        if (problem) errors[path] = problem;
      }
    });
  }
  for (const field of lineListFields) {
    const items = asList(form?.[field.key]).filter((item) => trim(item));
    if (items.length > field.max)
      errors[field.key] = `Keep ${field.label.toLowerCase()} to ${field.max} entries or fewer.`;
    asList(form?.[field.key]).forEach((item, index) => {
      const problem = textProblem(item, { kind: 'line', max: field.itemMax });
      if (problem) errors[`${field.key}[${index}]`] = problem;
    });
  }
  return errors;
}

// 400 COMPANY_PROFILE_INVALID { fields: [{ field, problem }] } -> { path: message }
export function serverProfileErrors(fields) {
  const errors = {};
  for (const item of Array.isArray(fields) ? fields : []) {
    if (!item?.field) continue;
    errors[item.field] = problemMessages[item.problem] || 'This value is not valid.';
  }
  return errors;
}

// The same shape for the digest's warnings: [{ field, problem }] -> readable lines.
export function warningLines(warnings) {
  return (Array.isArray(warnings) ? warnings : [])
    .filter((item) => item?.field)
    .map(
      (item) => `${fieldLabel(item.field)}: ${problemMessages[item.problem] || 'needs a check.'}`,
    );
}

// 'faqs[3].answer' -> 'Frequently asked questions, item 4, Answer'
export function fieldLabel(path) {
  const match = /^([A-Za-z]+)(?:\[(\d+)\])?(?:\.([A-Za-z]+))?$/.exec(String(path));
  if (!match) return String(path);
  const [, key, index, part] = match;
  const list = listFields.find((field) => field.key === key);
  const line = lineListFields.find((field) => field.key === key);
  const text = textFields.find((field) => field.key === key);
  const name = (list || line || text)?.label || key;
  const partLabel = list?.fields.find((field) => field.key === part)?.label;
  return [name, index === undefined ? '' : `item ${Number(index) + 1}`, partLabel || '']
    .filter(Boolean)
    .join(', ');
}

// Whether the form holds anything different from the loaded profile.
export function isProfileDirty(form, savedProfile) {
  return (
    JSON.stringify(formToProfile(form)) !==
    JSON.stringify(formToProfile(profileToForm(savedProfile)))
  );
}

// Error text for a failed save. 409 offers a reload; the rest keep the server wording.
export function saveErrorInfo(error) {
  if (error?.status === 409 || error?.code === 'COMPANY_PROFILE_CONFLICT')
    return {
      conflict: true,
      message: 'Someone else saved this profile after you opened it. Reload to see their version.',
      fields: {},
    };
  if (error?.code === 'COMPANY_PROFILE_INVALID')
    return {
      conflict: false,
      message: 'Some fields need attention. Fix the marked fields and save again.',
      fields: serverProfileErrors(error.fields),
    };
  if (error?.code === 'COMPANY_PROFILE_TOO_LARGE' || error?.status === 413)
    return {
      conflict: false,
      message: 'The profile is too large to save. Shorten some entries.',
      fields: {},
    };
  return {
    conflict: false,
    message: error?.message || 'The profile could not be saved. Please try again.',
    fields: {},
  };
}
