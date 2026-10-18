import { companyProfileErrors } from './account-errors.mjs';

// The company profile (issue #86): the facts a platform administrator keeps
// for each company (companies.profile, jsonb). Alya answers from it as cited
// reference passages ("Company profile" + the section), next to the company's
// documents. Only an administrator edits it; HR reads it. Every field is
// optional; text is trimmed; '' and [] mean empty.
//
//   line  one line, no control characters
//   para  may span lines (\n); no other control characters
const line = (max) => ({ kind: 'line', max });
const para = (max) => ({ kind: 'para', max });
const list = (max, item) => ({ kind: 'list', max, item });
const record = (fields, required = []) => ({ kind: 'record', fields, required });

export const companyProfileSchema = Object.freeze({
  overview: para(2000),
  mission: para(500),
  vision: para(500),
  values: list(10, record({ name: line(60), description: para(300) }, ['name'])),
  productsAndServices: list(15, record({ name: line(80), description: para(400) }, ['name'])),
  workingHours: para(500),
  locations: list(8, record({ name: line(80), address: para(200), notes: para(200) }, ['name'])),
  dressCode: para(800),
  benefits: list(15, line(200)),
  // Department names and department channels, never a person's name.
  contacts: list(
    15,
    record({ department: line(60), purpose: line(200), channel: line(120) }, ['department']),
  ),
  policiesSummary: para(2000),
  faqs: list(25, record({ question: line(200), answer: para(600) }, ['question', 'answer'])),
});
export const companyProfileFields = Object.freeze(Object.keys(companyProfileSchema));
// The PUT body limit (the web proxy's JSON limit is 64 KiB too).
export const companyProfileBodyLimit = '64kb';
export const profileSourceTitle = 'Company profile';

const lineControl = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const paraControl = /[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029]/;
const isObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const emptyOf = (rule) => (rule.kind === 'list' ? [] : '');
export const emptyCompanyProfile = () =>
  Object.fromEntries(companyProfileFields.map((key) => [key, emptyOf(companyProfileSchema[key])]));

// One text value: [problem] or [null, cleaned].
function checkText(value, rule) {
  if (value === undefined || value === null) return [null, ''];
  if (typeof value !== 'string') return ['not_text'];
  const text =
    rule.kind === 'para'
      ? value
          .replace(/\r\n?/g, '\n')
          .replace(/[ \t]+\n/g, '\n')
          .trim()
      : value.trim();
  if ((rule.kind === 'para' ? paraControl : lineControl).test(text)) return ['invalid_characters'];
  if ([...text].length > rule.max) return ['too_long'];
  return [null, text];
}

// Checks one field. Returns { value, problems: [{ field, problem }] }. With
// lenient (a Gemini draft), a bad value or entry is dropped and reported
// instead of failing the whole field, and a list longer than allowed is cut.
function checkField(path, value, rule, lenient) {
  const problems = [];
  if (rule.kind !== 'list') {
    const [problem, text] = checkText(value, rule);
    if (problem) return { value: '', problems: [{ field: path, problem }] };
    return { value: text, problems };
  }
  if (value === undefined || value === null) return { value: [], problems };
  if (!Array.isArray(value)) return { value: [], problems: [{ field: path, problem: 'not_list' }] };
  const out = [];
  for (const [index, item] of value.entries()) {
    const at = `${path}[${index}]`;
    if (rule.item.kind !== 'record') {
      const [problem, text] = checkText(item, rule.item);
      if (problem) problems.push({ field: at, problem });
      else if (text) out.push(text);
      continue;
    }
    if (!isObject(item)) {
      problems.push({ field: at, problem: 'not_object' });
      continue;
    }
    const entry = {},
      entryProblems = [];
    for (const key of Object.keys(item))
      if (!Object.hasOwn(rule.item.fields, key))
        entryProblems.push({ field: `${at}.${key}`, problem: 'unknown' });
    for (const [key, fieldRule] of Object.entries(rule.item.fields)) {
      const [problem, text] = checkText(item[key], fieldRule);
      if (problem) entryProblems.push({ field: `${at}.${key}`, problem });
      entry[key] = problem ? '' : text;
    }
    // An entry with every field empty is dropped, not an error.
    if (Object.values(entry).every((text) => !text) && !entryProblems.length) continue;
    for (const key of rule.item.required)
      if (!entry[key] && !entryProblems.some((p) => p.field === `${at}.${key}`))
        entryProblems.push({ field: `${at}.${key}`, problem: 'required' });
    problems.push(...entryProblems);
    if (!entryProblems.length) out.push(entry);
  }
  if (out.length > rule.max) {
    problems.push({ field: path, problem: 'too_many' });
    if (lenient) out.length = rule.max;
  }
  return { value: out, problems };
}

// PUT /api/admin/companies/:id/profile: the stored form (every field present)
// or 400 COMPANY_PROFILE_INVALID with details.fields.
export function validateCompanyProfile(input) {
  if (!isObject(input))
    throw companyProfileErrors.invalid([{ field: 'profile', problem: 'not_object' }]);
  const problems = [];
  for (const key of Object.keys(input))
    if (!Object.hasOwn(companyProfileSchema, key))
      problems.push({ field: key, problem: 'unknown' });
  const profile = {};
  for (const [key, rule] of Object.entries(companyProfileSchema)) {
    const checked = checkField(key, input[key], rule, false);
    profile[key] = checked.value;
    problems.push(...checked.problems);
  }
  if (problems.length) throw companyProfileErrors.invalid(problems);
  return profile;
}

// A Gemini draft (or anything not trusted to be valid) as a full profile:
// unknown keys and wrong types are dropped, bad values become warnings.
// Returns { profile, filled, warnings }.
export function readDraftProfile(answer) {
  const source = isObject(answer) ? answer : {};
  const profile = {},
    filled = [],
    warnings = [];
  for (const [key, rule] of Object.entries(companyProfileSchema)) {
    const checked = checkField(key, source[key], rule, true);
    profile[key] = checked.value;
    warnings.push(...checked.problems.filter((p) => p.problem !== 'unknown'));
    if (rule.kind === 'list' ? checked.value.length : checked.value) filled.push(key);
  }
  return { profile, filled, warnings };
}

// A stored profile as the API returns it: every field present.
export function presentCompanyProfile(stored) {
  return readDraftProfile(stored).profile;
}

export const isEmptyProfile = (profile) =>
  companyProfileFields.every((key) => {
    const value = profile?.[key];
    return Array.isArray(value) ? !value.length : !value;
  });

// --- Reference passages for Alya ---------------------------------------------

// Each section: its heading, the words that point to it, and its text.
const bullet = (items) => items.map((item) => `- ${item}`).join('\n');
const sections = [
  {
    key: 'overview',
    heading: 'Overview',
    aliases:
      'company business background about overview history founded industry customers clients does organisation organization',
    text: (p) => p.overview,
  },
  {
    key: 'missionVision',
    heading: 'Mission and vision',
    aliases: 'mission vision purpose goal goals aim aims stand stands',
    text: (p) =>
      [p.mission && `Mission: ${p.mission}`, p.vision && `Vision: ${p.vision}`]
        .filter(Boolean)
        .join('\n'),
  },
  {
    key: 'values',
    heading: 'Values',
    aliases: 'values value culture principles principle believe beliefs',
    text: (p) =>
      bullet(p.values.map((v) => (v.description ? `${v.name}: ${v.description}` : v.name))),
  },
  {
    key: 'productsAndServices',
    heading: 'Products and services',
    aliases:
      'product products service services offer offers offering sell sells build builds platform app apps solution solutions',
    text: (p) =>
      bullet(
        p.productsAndServices.map((v) => (v.description ? `${v.name}: ${v.description}` : v.name)),
      ),
  },
  {
    key: 'workingHours',
    heading: 'Working hours',
    aliases:
      'hours hour time times start starts finish end schedule working work late lunch break shift shifts days weekend',
    text: (p) => p.workingHours,
  },
  {
    key: 'locations',
    heading: 'Locations',
    aliases:
      'office offices location locations address where located branch site building parking directions',
    text: (p) =>
      bullet(
        p.locations.map((v) =>
          [v.name, v.address && `: ${v.address}`, v.notes && ` (${v.notes})`]
            .filter(Boolean)
            .join(''),
        ),
      ),
  },
  {
    key: 'dressCode',
    heading: 'Dress code',
    aliases:
      'dress wear wearing clothing clothes attire shirt tshirt outfit shoes uniform jeans casual formal',
    text: (p) => p.dressCode,
  },
  {
    key: 'benefits',
    heading: 'Benefits',
    aliases:
      'benefit benefits leave holiday holidays insurance medical perks perk allowance bonus claim claims',
    text: (p) => bullet(p.benefits),
  },
  {
    key: 'contacts',
    heading: 'Contacts by department',
    aliases: 'contact contacts who ask email help support reach department departments team phone',
    text: (p) =>
      bullet(
        p.contacts.map((v) =>
          [v.department, v.purpose && `: ${v.purpose}`, v.channel && ` (${v.channel})`]
            .filter(Boolean)
            .join(''),
        ),
      ),
  },
  {
    key: 'policiesSummary',
    heading: 'Policies summary',
    aliases:
      'policy policies rule rules conduct privacy data security handbook compliance confidential',
    text: (p) => p.policiesSummary,
  },
];

const stop = new Set(
  'the and are can for from has have how into its our out tell that the their them then there this was what when where which who why will with would you your about please'.split(
    ' ',
  ),
);
const wordsOf = (value) =>
  new Set(
    (
      String(value || '')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) || []
    ).filter((word) => word.length > 2 && !stop.has(word)),
  );

// Every non-empty section (and each FAQ) of a profile as a candidate passage,
// in table order: { heading, text, aliases: Set, words: Set }.
export function profileCandidates(stored) {
  const profile = presentCompanyProfile(stored);
  const out = [];
  for (const section of sections) {
    const text = section.text(profile);
    if (text)
      out.push({
        key: section.key,
        heading: section.heading,
        text,
        aliases: wordsOf(section.aliases),
        words: wordsOf(text),
      });
  }
  for (const faq of profile.faqs)
    out.push({
      key: 'faq',
      heading: `FAQ: ${[...faq.question].slice(0, 100).join('')}`,
      text: `Q: ${faq.question}\nA: ${faq.answer}`,
      aliases: wordsOf(faq.question),
      words: wordsOf(faq.answer),
    });
  return out;
}

// The profile passages for one query: the Overview whenever the profile has
// one, then up to `extra` other sections by score (query words that point to
// the section count 3, words found in its text 1), ties in table order.
// Deterministic: the same query always gives the same passages.
export function selectProfilePassages(candidates, query, { extra = 2 } = {}) {
  const wanted = wordsOf(query);
  const score = (candidate) => {
    let total = 0;
    for (const word of wanted) {
      if (candidate.aliases.has(word)) total += 3;
      else if (candidate.words.has(word)) total += 1;
    }
    return total;
  };
  const overview = candidates.find((c) => c.key === 'overview');
  const others = candidates
    .filter((c) => c.key !== 'overview')
    .map((candidate, order) => ({ candidate, order, score: score(candidate) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, extra)
    .map((item) => item.candidate);
  return [...(overview ? [overview] : []), ...others].map(({ heading, text }) => ({
    title: profileSourceTitle,
    heading,
    text,
  }));
}
