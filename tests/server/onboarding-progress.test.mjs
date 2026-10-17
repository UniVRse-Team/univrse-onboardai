// The onboarding footprint rules (issue #47) and chip selection (issue #50):
// pure functions only, no storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaOrder,
  builtInQuickQuestions,
  builtInTemplate,
  checklistTitle,
  contractTitle,
  handbookTitle,
  orientationTitle,
  peopleSupportTitle,
  roleToolsTitle,
  templateVersion,
  trackOf,
  tracks,
} from '../../server/onboarding-content.mjs';
import {
  StepRuleError,
  addDays,
  buildOnboarding,
  companyDay,
  employeeComplete,
  employeeReopen,
  findStep,
  hrSetStatus,
  selectChips,
  validChips,
  validTemplate,
} from '../../server/onboarding-progress.mjs';

const stepIds = (template) => template.areas.flatMap((area) => area.steps.map((step) => step.id));
const progressOf = (entries) => ({
  accountId: 'synthetic',
  steps: Object.fromEntries(
    Object.entries(entries).map(([id, status]) => [
      id,
      { status, updatedAt: '2026-10-15T01:00:00.000Z', source: 'employee', actorId: 'x' },
    ]),
  ),
});

const areaTitles = {
  documentation: ['📄', 'Documentation', 'Complete required forms and submit documents.'],
  policies: [
    '🛡️',
    'Policies & Safe Practices',
    'Understand company rules, privacy and responsible AI use.',
  ],
  alignment: [
    '🎯',
    'Company Purpose & Alignment',
    'Understand what the company does, its goals and how your role contributes.',
  ],
  'role-tools': [
    '🛠️',
    'Role, Tools & AI Readiness',
    'Set up work tools, understand your responsibilities and identify suitable AI training.',
  ],
  'team-support': [
    '🤝',
    'People & Workplace Support',
    'Know your teammates, who to ask for help and optionally share working preferences or support needs.',
  ],
};
const requiredIds = (template) =>
  template.areas.flatMap((area) => area.steps.filter((s) => s.required).map((s) => s.id));
const expectedRequiredByArea = {
  documentation: 4,
  policies: 4,
  alignment: 4,
  'role-tools': 11,
  'team-support': 4,
};

test('every built-in template is valid: the user’s areas, 11 required role-tools steps, 4 required steps in other areas, a check on each check step', () => {
  for (const track of tracks) {
    const template = builtInTemplate(track);
    assert.deepEqual(validTemplate(template, track), template, track);
    assert.equal(template.threshold, 70);
    assert.deepEqual(
      template.areas.map((area) => area.id),
      areaOrder,
    );
    for (const area of template.areas) {
      assert.deepEqual([area.icon, area.title, area.description], areaTitles[area.id]);
      assert.equal(
        area.steps.filter((step) => step.required).length,
        expectedRequiredByArea[area.id],
        `${track} ${area.id}`,
      );
      for (const step of area.steps) {
        assert.match(step.id, new RegExp(`^${area.id}\\.[a-z0-9-]+$`));
        assert.equal(typeof step.required, 'boolean');
        assert.ok(step.askAlya && step.askAlya.endsWith('?'), step.id);
        assert.equal(Boolean(step.check), step.completion === 'check', step.id);
      }
    }
    assert.ok(template.areas[0].steps.every((step) => step.completion === 'hr_verify'));
    assert.ok(template.areas[1].steps.every((step) => step.completion === 'check'));
    assert.ok(template.areas[2].steps.every((step) => step.completion === 'self'));
    assert.equal(template.version, templateVersion);
    assert.equal(templateVersion, 3);
    // v1.4: company rules and conduct are choice checks; data protection and
    // responsible AI are written checks with a rubric.
    assert.deepEqual(
      template.areas[1].steps.map((step) => [step.id, step.check.type]),
      [
        ['policies.employee-handbook', 'choice'],
        ['policies.workplace-conduct', 'choice'],
        ['policies.data-protection', 'written'],
        ['policies.responsible-ai', 'written'],
      ],
    );
    for (const step of template.areas.flatMap((a) => a.steps).filter((s) => s.check)) {
      assert.ok(
        [handbookTitle, roleToolsTitle, peopleSupportTitle].includes(step.check.sourceTitle),
        step.id,
      );
      if (step.check.type === 'choice')
        assert.ok(step.check.options.some((o) => o.id === step.check.correctOptionId));
      else {
        const { keyPoints, mustNot, modelAnswer, explanation, maxLength } = step.check;
        assert.ok(keyPoints.length >= 2 && keyPoints.length <= 3, step.id);
        assert.ok(mustNot.length >= 1 && mustNot.length <= 2, step.id);
        assert.ok(modelAnswer.length > 40 && explanation.length > 40 && maxLength === 600);
        assert.equal(new Set([...keyPoints, ...mustNot].map((k) => k.id)).size, 4);
      }
    }
    // v1.5: every required step has Alya's briefing, plain and short enough to
    // read aloud; the optional step has none.
    const titles = [
      handbookTitle,
      checklistTitle,
      orientationTitle,
      contractTitle,
      roleToolsTitle,
      peopleSupportTitle,
      null,
    ];
    for (const step of template.areas.flatMap((a) => a.steps)) {
      if (!step.required) {
        assert.equal(step.briefing, null, step.id);
        continue;
      }
      const { text, sourceTitle } = step.briefing;
      assert.deepEqual(Object.keys(step.briefing), ['text', 'sourceTitle'], step.id);
      assert.ok(titles.includes(sourceTitle), step.id);
      assert.ok(text.length <= 400, `${track} ${step.id}: ${text.length}`);
      const sentences = text.split(/(?<=[.!?])\s+/);
      assert.ok(sentences.length >= 2 && sentences.length <= 4, `${track} ${step.id}`);
      assert.doesNotMatch(text, /https?:|www\.|@|\n|^\s*[-•*#]|[#*•]/, step.id);
    }
    assert.equal(findStep(template, 'role-tools.gsheet-training-sop').step.completion, 'check');
    assert.equal(findStep(template, 'role-tools.gsheet-daily-updates').step.completion, 'check');
    assert.equal(
      findStep(template, 'role-tools.ai-readiness-training').step.askAlya,
      'How does the AI proficiency self-assessment work, and what training should I complete?',
    );
    assert.equal(findStep(template, 'policies.responsible-ai').step.completion, 'check');
    // One optional step: working preferences or support needs.
    assert.deepEqual(
      template.areas.flatMap((a) => a.steps.filter((s) => !s.required).map((s) => s.id)),
      ['team-support.working-preferences'],
    );
  }
  // Interns share the employee ids with intern wording; contractors substitute confidentiality-agreement.
  assert.equal(stepIds(builtInTemplate('employee')).length, 28);
  assert.deepEqual(stepIds(builtInTemplate('intern')), stepIds(builtInTemplate('employee')));
  assert.equal(requiredIds(builtInTemplate('contractor')).length, 27);
  assert.deepEqual(
    stepIds(builtInTemplate('contractor')).filter((id) => !stepIds(builtInTemplate()).includes(id)),
    ['documentation.confidentiality-agreement'],
  );
  assert.equal(
    findStep(builtInTemplate('intern'), 'documentation.contract').step.title,
    'Sign your internship agreement',
  );
  assert.equal(
    findStep(builtInTemplate('contractor'), 'documentation.contract').step.title,
    'Sign your service agreement',
  );
  // A missing or unknown track is employee.
  assert.equal(trackOf(null), 'employee');
  assert.equal(trackOf({ job: { track: '' } }), 'employee');
  assert.equal(trackOf({ job: { track: 'intern' } }), 'intern');
  assert.equal(builtInTemplate('nonsense').track, 'employee');
});

test('choice checks do not give the answer away: opaque option ids, varied positions, similar lengths', () => {
  for (const track of tracks) {
    const checks = builtInTemplate(track)
      .areas.flatMap((area) => area.steps.map((step) => step.check))
      .filter((check) => check && check.type === 'choice');
    assert.equal(checks.length, 5);
    // Option ids are opaque: never a letter or a number that names a position.
    for (const check of checks)
      for (const option of check.options)
        assert.match(option.id, /^(?=.*\d)(?=.*[a-z])[a-z0-9]{4}$/);
    // The right answer is read from the content, never assumed; the API also
    // shuffles the options on every request.
    const positions = checks.map((check) =>
      check.options.findIndex((option) => option.id === check.correctOptionId),
    );
    assert.ok(new Set(positions).size >= 2, track);
    let correctIsLongest = 0;
    for (const check of checks) {
      const lengths = check.options.map((option) => option.text.length);
      assert.ok(Math.max(...lengths) / Math.min(...lengths) <= 1.25, check.scenario);
      const correct = check.options.find((o) => o.id === check.correctOptionId).text.length;
      if (correct === Math.max(...lengths)) correctIsLongest++;
    }
    assert.ok(correctIsLongest < checks.length, 'the correct option is not always the longest');
  }
});

test('a malformed stored template is rejected so the built-in one is used', () => {
  const good = builtInTemplate('employee');
  const firstArea = (change) => ({
    ...good,
    areas: good.areas.map((a, i) => (i ? a : change(a))),
  });
  const broken = [
    null,
    { areas: [] },
    { areas: [...good.areas].reverse() },
    firstArea((a) => ({ ...a, steps: [] })),
    // Only optional steps: nothing to count.
    firstArea((a) => ({ ...a, steps: a.steps.map((s) => ({ ...s, required: false })) })),
    firstArea((a) => ({ ...a, steps: [{ ...a.steps[0], required: 'yes' }] })),
    {
      areas: good.areas.map((a, i) =>
        i === 1 ? { ...a, steps: a.steps.map(({ check, ...s }) => s) } : a,
      ),
    },
    firstArea((a) => ({ ...a, steps: [{ ...a.steps[0], completion: 'auto' }] })),
    firstArea((a) => ({ ...a, steps: [{ ...a.steps[0], id: 'policies.contract' }] })),
    { areas: good.areas.map((a) => ({ ...a, steps: [...a.steps, a.steps[0]] })) },
  ];
  for (const doc of broken) assert.equal(validTemplate(doc, 'employee'), null);
  // Defaults: required true, threshold 70, icon ''.
  const loose = validTemplate(
    {
      areas: good.areas.map(({ icon, ...a }) => ({
        ...a,
        steps: a.steps.map(({ required, ...s }) => s),
      })),
    },
    'employee',
  );
  assert.equal(loose.threshold, 70);
  assert.equal(loose.areas[0].icon, '');
  assert.ok(loose.areas.every((a) => a.steps.every((s) => s.required)));
});

test('progress maths: a new employee is at 0% with the first Documentation step next', () => {
  const template = builtInTemplate('employee');
  const view = buildOnboarding(template, null);
  assert.equal(view.track, 'employee');
  assert.deepEqual(
    [view.percent, view.threshold, view.complete, view.waitingOnHr],
    [0, 70, false, 0],
  );
  assert.deepEqual(view.nextStep, {
    id: 'documentation.contract',
    title: 'Sign your employment contract',
    areaId: 'documentation',
    areaTitle: 'Documentation',
    completion: 'hr_verify',
    askAlya: 'How do I sign my employment contract?',
  });
  assert.deepEqual(Object.keys(view.areas[0]), [
    'id',
    'icon',
    'title',
    'description',
    'percent',
    'done',
    'total',
    'meetsThreshold',
    'steps',
  ]);
  assert.deepEqual(Object.keys(view.areas[0].steps[0]), [
    'id',
    'title',
    'description',
    'required',
    'completion',
    'askAlya',
    'hasCheck',
    'briefing',
    'briefingRequired',
    'briefed',
    'status',
    'updatedAt',
    'source',
  ]);
  assert.equal(view.areas[1].steps[0].hasCheck, true);
  // v1.5: every required step needs its briefing, none is briefed yet.
  const all = view.areas.flatMap((a) => a.steps);
  assert.ok(all.filter((s) => s.required).every((s) => s.briefingRequired && !s.briefed));
  const optional = all.find((s) => !s.required);
  assert.deepEqual([optional.briefing, optional.briefingRequired], [null, false]);
  assert.deepEqual(Object.keys(view.areas[0].steps[0].briefing), ['text', 'sourceTitle']);
  assert.deepEqual(
    view.areas.map((a) => [a.done, a.total, a.meetsThreshold]),
    [
      [0, 4, false],
      [0, 4, false],
      [0, 4, false],
      [0, 11, false],
      [0, 4, false],
    ],
  );
  // No check answer or rubric in the view.
  for (const secret of ['correctOptionId', 'keyPoints', 'mustNot', 'modelAnswer'])
    assert.ok(!JSON.stringify(view).includes(secret), secret);
  // A record with only briefedAt is still todo, and briefed.
  const briefedOnly = buildOnboarding(template, {
    steps: {
      'documentation.contract': { briefedAt: '2026-10-15T01:00:00.000Z', briefedBy: 'read' },
    },
  });
  assert.deepEqual(
    [briefedOnly.areas[0].steps[0].status, briefedOnly.areas[0].steps[0].briefed],
    ['todo', true],
  );
  assert.equal(briefedOnly.nextStep.id, 'documentation.contract');
});

test('progress maths: area percents count required steps only; submitted steps wait on HR', () => {
  const template = builtInTemplate('employee');
  let view = buildOnboarding(template, progressOf({ 'alignment.mission-values': 'done' }));
  assert.deepEqual(
    view.areas.map((a) => [a.id, a.done, a.total, a.percent]),
    [
      ['documentation', 0, 4, 0],
      ['policies', 0, 4, 0],
      ['alignment', 1, 4, 25],
      ['role-tools', 0, 11, 0],
      ['team-support', 0, 4, 0],
    ],
  );
  assert.equal(view.percent, 5);
  view = buildOnboarding(
    template,
    progressOf({ 'documentation.contract': 'submitted', 'alignment.mission-values': 'done' }),
  );
  assert.equal(view.waitingOnHr, 1);
  assert.equal(view.percent, 5);
  assert.equal(view.nextStep.id, 'documentation.personal-bank-details');
  assert.equal(view.areas[0].steps[0].status, 'submitted');
  assert.equal(view.areas[0].steps[0].updatedAt, '2026-10-15T01:00:00.000Z');
  assert.equal(view.areas[0].steps[0].source, 'employee');
  // Unknown step ids and unknown statuses are ignored.
  view = buildOnboarding(
    template,
    progressOf({ 'documentation.nonsense': 'done', 'documentation.contract': 'approved' }),
  );
  assert.equal(view.percent, 0);
  assert.equal(view.areas[0].steps[0].status, 'todo');
  // Everything required: 100%; the optional step is not needed.
  const all = Object.fromEntries(requiredIds(template).map((id) => [id, 'done']));
  view = buildOnboarding(template, progressOf(all));
  assert.deepEqual([view.percent, view.complete, view.nextStep], [100, true, null]);
  assert.equal(view.areas[4].steps.at(-1).status, 'todo');
});

test('the 70% rule: 3 of 4 (8 of 11 in role-tools) in every area is complete; 1 fewer in any area is not', () => {
  for (const track of tracks) {
    const template = builtInTemplate(track);
    const minForArea = (area) => {
      const req = area.steps.filter((s) => s.required);
      return Math.ceil((req.length * 70) / 100);
    };
    const atThreshold = Object.fromEntries(
      template.areas.flatMap((area) =>
        area.steps
          .filter((s) => s.required)
          .slice(0, minForArea(area))
          .map((s) => [s.id, 'done']),
      ),
    );
    let view = buildOnboarding(template, progressOf(atThreshold));
    assert.ok(
      view.areas.every((a) => a.meetsThreshold),
      track,
    );
    assert.equal(view.complete, true, track);
    // The last required step of each area is still todo: the first one is next.
    assert.equal(view.nextStep.id, template.areas[0].steps[3].id, track);
    for (const area of template.areas) {
      const fewer = { ...atThreshold };
      const count = minForArea(area);
      delete fewer[area.steps.filter((s) => s.required)[count - 1].id];
      view = buildOnboarding(template, progressOf(fewer));
      const below = view.areas.find((a) => a.id === area.id);
      assert.equal(below.meetsThreshold, false, `${track} ${area.id}`);
      assert.equal(view.complete, false, `${track} ${area.id}`);
      // The next step is in the area below the threshold.
      assert.equal(view.nextStep.areaId, area.id, `${track} ${area.id}`);
    }
    // A submitted step is not done: 2 done + 1 submitted is below the threshold.
    const pending = { ...atThreshold, [template.areas[0].steps[2].id]: 'submitted' };
    view = buildOnboarding(template, progressOf(pending));
    assert.deepEqual([view.areas[0].meetsThreshold, view.complete], [false, false]);
  }
});

test('optional steps never change percent, meetsThreshold, complete or the next step', () => {
  const template = builtInTemplate('employee');
  const optional = 'team-support.working-preferences';
  for (const base of [{}, { 'alignment.mission-values': 'done' }]) {
    const without = buildOnboarding(template, progressOf(base));
    const withIt = buildOnboarding(template, progressOf({ ...base, [optional]: 'done' }));
    const strip = (view) => ({
      ...view,
      areas: view.areas.map((a) => ({ ...a, steps: a.steps.filter((s) => s.id !== optional) })),
    });
    assert.deepEqual(strip(withIt), strip(without));
    assert.equal(withIt.areas[4].steps.at(-1).status, 'done');
  }
  // Even when everything required is done but the optional step, the
  // optional step is never the next step.
  const all = Object.fromEntries(requiredIds(template).map((id) => [id, 'done']));
  assert.equal(buildOnboarding(template, progressOf(all)).nextStep, null);
});

test('next step: the first area below the threshold that has a todo step, else any required todo', () => {
  const template = builtInTemplate('employee');
  const ids = (areaId) =>
    template.areas
      .find((a) => a.id === areaId)
      .steps.filter((s) => s.required)
      .map((s) => s.id);
  const done = (list) => Object.fromEntries(list.map((id) => [id, 'done']));
  // Documentation meets the threshold (3 of 4) and policies does not: next is
  // in policies, although documentation still has a todo step.
  let view = buildOnboarding(template, progressOf(done(ids('documentation').slice(0, 3))));
  assert.equal(view.nextStep.id, 'policies.employee-handbook');
  // Policies below the threshold but its remaining steps all wait on HR (no
  // todo there): the next area below the threshold with a todo step.
  const policies = ids('policies');
  view = buildOnboarding(
    template,
    progressOf({
      ...done(ids('documentation').slice(0, 3)),
      [policies[0]]: 'done',
      [policies[1]]: 'submitted',
      [policies[2]]: 'submitted',
      [policies[3]]: 'submitted',
    }),
  );
  assert.equal(view.nextStep.id, 'alignment.products-customers');
  // Every area at the threshold: the first required todo step anywhere.
  const every = Object.fromEntries(
    template.areas.flatMap((a) =>
      a.steps
        .filter((s) => s.required)
        .slice(1)
        .map((s) => [s.id, 'done']),
    ),
  );
  view = buildOnboarding(template, progressOf(every));
  assert.equal(view.complete, true);
  assert.equal(view.nextStep.id, 'documentation.contract');
  // The first one submitted: the next todo step anywhere.
  view = buildOnboarding(template, progressOf({ ...every, 'documentation.contract': 'submitted' }));
  assert.equal(view.nextStep.id, 'policies.employee-handbook');
  // Every remaining required step submitted: null.
  const rest = Object.fromEntries(
    template.areas.map((a) => [a.steps.find((s) => s.required).id, 'submitted']),
  );
  view = buildOnboarding(template, progressOf({ ...every, ...rest }));
  assert.equal(view.nextStep, null);
});

test('completion rules: self, hr_verify, check and optional steps', () => {
  const template = builtInTemplate('employee');
  const self = findStep(template, 'alignment.mission-values').step;
  const verify = findStep(template, 'documentation.contract').step;
  const check = findStep(template, 'policies.workplace-conduct').step;
  const optional = findStep(template, 'team-support.working-preferences').step;
  const done = { status: 'done', source: 'employee' };
  const submitted = { status: 'submitted', source: 'employee' };
  const rule = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof StepRuleError);
      return error.rule;
    }
    return null;
  };
  // complete: a required step needs its briefing first (v1.5)
  const briefed = { briefedAt: '2026-10-15T01:00:00.000Z', briefedBy: 'listened' };
  assert.equal(
    rule(() => employeeComplete(self, null)),
    'BRIEFING_REQUIRED',
  );
  assert.equal(
    rule(() => employeeComplete(verify, null)),
    'BRIEFING_REQUIRED',
  );
  assert.deepEqual(employeeComplete(self, null, briefed), { status: 'done' });
  assert.deepEqual(employeeComplete(verify, null, briefed), { status: 'submitted' });
  // A step done before briefings existed stays as it is.
  assert.equal(employeeComplete(self, done), done);
  assert.equal(
    rule(() => employeeComplete(check, null)),
    'CHECK_REQUIRED',
  );
  assert.equal(employeeComplete(check, done), done); // passed already
  assert.equal(employeeComplete(verify, done), done); // HR verified: unchanged
  assert.equal(employeeComplete(verify, submitted), submitted);
  assert.deepEqual(employeeComplete(optional, null), { status: 'done' });
  // An optional step completes like a self step whatever its completion type.
  assert.deepEqual(employeeComplete({ ...verify, required: false }, null), { status: 'done' });
  // reopen
  assert.equal(employeeReopen(self, done), null);
  assert.equal(employeeReopen(verify, submitted), null);
  assert.equal(employeeReopen(self, null), null);
  assert.equal(employeeReopen(optional, done), null);
  assert.equal(
    rule(() => employeeReopen(verify, { status: 'done', source: 'hr' })),
    'STEP_LOCKED',
  );
  assert.equal(
    rule(() => employeeReopen(check, done)),
    'STEP_LOCKED',
  );
  // HR: required hr_verify steps only.
  assert.deepEqual(hrSetStatus(verify, submitted, 'done'), { status: 'done' });
  assert.deepEqual(hrSetStatus(verify, null, 'done'), { status: 'done' });
  assert.equal(hrSetStatus(verify, done, 'done'), done);
  assert.equal(hrSetStatus(verify, done, 'todo'), null);
  assert.equal(
    rule(() => hrSetStatus(self, null, 'done')),
    'STEP_NOT_HR_VERIFIED',
  );
  assert.equal(
    rule(() => hrSetStatus(check, null, 'done')),
    'STEP_NOT_HR_VERIFIED',
  );
  assert.equal(
    rule(() => hrSetStatus(optional, null, 'done')),
    'STEP_NOT_HR_VERIFIED',
  );
});

test('chips: the next-step chip first, personal chips up to the day after the start date, then knowledge', () => {
  const chips = builtInQuickQuestions().employee;
  const fresh = buildOnboarding(builtInTemplate('employee'), null);
  const ids = (list) => list.map((chip) => chip.id);
  const pick = (startDate, today, onboarding = fresh) =>
    selectChips({ onboarding, chips, startDate, today });
  // Before, on and the day after the start date: personal chips.
  for (const today of ['2026-10-15', '2026-11-02', '2026-11-03'])
    assert.deepEqual(ids(pick('2026-11-02', today)), [
      'step:documentation.contract',
      'day-one-arrival',
      'day-one-host',
    ]);
  // Two days after: knowledge chips.
  assert.deepEqual(ids(pick('2026-11-02', '2026-11-04')), [
    'step:documentation.contract',
    'company-background',
    'working-hours',
  ]);
  // No start date: personal.
  assert.deepEqual(ids(pick(null, '2027-01-01')).slice(1), ['day-one-arrival', 'day-one-host']);
  // The step chip asks the step's question and names the step.
  assert.deepEqual(pick(null, '2026-10-15')[0], {
    id: 'step:documentation.contract',
    label: 'How do I sign my employment contract?',
    question: 'How do I sign my employment contract?',
    kind: 'knowledge',
    stepId: 'documentation.contract',
  });
  assert.deepEqual(pick(null, '2026-10-15')[1], {
    id: 'day-one-arrival',
    label: 'Where and what time do I report on day 1?',
    question: 'Where and what time do I report on day 1?',
    kind: 'personal',
    stepId: null,
  });
  // No next step (all done or submitted): three general chips, filled from the other kind.
  const finished = { ...fresh, nextStep: null };
  assert.deepEqual(ids(pick('2026-11-02', '2026-10-15', finished)), [
    'day-one-arrival',
    'day-one-host',
    'company-background',
  ]);
  assert.deepEqual(ids(pick('2026-11-02', '2026-12-01', finished)), [
    'company-background',
    'working-hours',
    'dress-code',
  ]);
  // A next step without a question gets no chip.
  const silent = { ...fresh, nextStep: { ...fresh.nextStep, askAlya: null } };
  assert.deepEqual(ids(pick(null, '2026-10-15', silent)), [
    'day-one-arrival',
    'day-one-host',
    'company-background',
  ]);
  // Days are the company's calendar days (Malaysia, UTC+8).
  assert.equal(companyDay(new Date('2026-11-02T15:59:59Z')), '2026-11-02');
  assert.equal(companyDay(new Date('2026-11-02T16:00:00Z')), '2026-11-03');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('stored chip lists are checked: unknown kinds, personal chips without a type and step ids are refused', () => {
  const chips = builtInQuickQuestions().intern;
  assert.deepEqual(validChips(chips), chips);
  for (const list of [
    null,
    [{ ...chips[0], kind: 'other' }],
    [{ ...chips[3], personal: undefined }],
    [{ ...chips[0], id: 'step:documentation.contract' }],
    [chips[0], chips[0]],
  ])
    assert.equal(validChips(list), null);
});

test('AI proficiency self-assessment: deterministic path mapping, step status sync, and non-destructive editing', async () => {
  const {
    AI_READINESS_STEP_ID,
    aiLevelDescriptions,
    applyAiAssessment,
    applyAiTrainingCompleted,
    assertAiProficiencyAccess,
    learningPathFor,
    parseChatAiAssessment,
    presentAiProficiency,
    validateAiAssessmentInput,
  } = await import('../../server/ai-proficiency.mjs');
  const template = builtInTemplate('employee');

  // 1. Default unanswered state
  const freshView = buildOnboarding(template, null);
  assert.equal(freshView.aiProficiency.status, 'unanswered');
  assert.equal(freshView.aiProficiency.level, null);
  assert.equal(freshView.aiProficiency.learningPathId, 'beginner');
  assert.equal(freshView.aiProficiency.trainingCompleted, false);
  const aiStep = (view) =>
    view.areas.find((a) => a.id === 'role-tools').steps.find((s) => s.id === AI_READINESS_STEP_ID);
  assert.equal(aiStep(freshView).status, 'todo');

  // 2. Deterministic path mapping across all levels (1-10), not_sure, and skipped
  assert.equal(Object.keys(aiLevelDescriptions).length, 10);
  for (const level of [1, 2, 3]) assert.equal(learningPathFor('assessed', level), 'beginner');
  for (const level of [4, 5, 6]) assert.equal(learningPathFor('assessed', level), 'intermediate');
  for (const level of [7, 8, 9, 10]) assert.equal(learningPathFor('assessed', level), 'advanced');
  assert.equal(learningPathFor('not_sure', null), 'beginner');
  assert.equal(learningPathFor('skipped', null), 'beginner');

  // 3. A submitted rating completes the step (it is a training-needs survey, not an exam);
  // skipping (not_sure) does not, and the practice exercise stays separately recorded.
  const assessedL5 = applyAiAssessment(
    null,
    validateAiAssessmentInput({ status: 'assessed', level: 5 }),
    '2026-10-17T01:00:00.000Z',
  );
  assert.equal(assessedL5.learningPathId, 'intermediate');
  assert.equal(assessedL5.trainingCompleted, false);
  const viewAfterRating = buildOnboarding(template, {
    accountId: 'synthetic',
    aiProficiency: assessedL5,
    steps: {
      [AI_READINESS_STEP_ID]: { status: 'done', updatedAt: '2026-10-17T01:00:00.000Z' },
    },
  });
  assert.equal(aiStep(viewAfterRating).status, 'done');
  const skipped = buildOnboarding(template, {
    accountId: 'synthetic',
    aiProficiency: applyAiAssessment(
      null,
      validateAiAssessmentInput({ status: 'not_sure' }),
      '2026-10-17T01:00:00.000Z',
    ),
    steps: {},
  });
  assert.equal(aiStep(skipped).status, 'todo');

  // 4. Completing training sets trainingCompleted = true and transitions step to 'done'
  const trained = applyAiTrainingCompleted(assessedL5, '2026-10-17T02:00:00.000Z');
  assert.equal(trained.trainingCompleted, true);
  const viewAfterTraining = buildOnboarding(template, {
    accountId: 'synthetic',
    aiProficiency: trained,
    steps: {},
  });
  assert.equal(aiStep(viewAfterTraining).status, 'done');

  // 5. Non-destructive editing: changing level or skipping after trainingCompleted === true
  // updates learningPathId and updatedAt while keeping trainingCompleted === true and step 'done'
  const updatedL9 = applyAiAssessment(
    trained,
    validateAiAssessmentInput({ status: 'assessed', level: 9 }),
    '2026-10-17T03:00:00.000Z',
  );
  assert.equal(updatedL9.level, 9);
  assert.equal(updatedL9.learningPathId, 'advanced');
  assert.equal(updatedL9.trainingCompleted, true);
  assert.equal(updatedL9.trainingCompletedAt, '2026-10-17T02:00:00.000Z');
  assert.equal(updatedL9.updatedAt, '2026-10-17T03:00:00.000Z');
  const viewAfterEdit = buildOnboarding(template, {
    accountId: 'synthetic',
    aiProficiency: updatedL9,
    steps: {},
  });
  assert.equal(aiStep(viewAfterEdit).status, 'done');
  assert.equal(presentAiProficiency(updatedL9).learningPath.id, 'advanced');

  // 6. Access control rejects cross-user and cross-company requests with 403
  assert.throws(
    () => assertAiProficiencyAccess({ id: 'user-a', companyId: 'univrse' }, { userId: 'user-b' }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
  );
  assert.throws(
    () =>
      assertAiProficiencyAccess({ id: 'user-a', companyId: 'univrse' }, { companyId: 'other-co' }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
  );

  // 7. Chat self-assessment parser distinguishes rating/skip from practice task completion
  assert.deepEqual(parseChatAiAssessment('I set my AI proficiency level to 6'), {
    status: 'assessed',
    level: 6,
  });
  assert.deepEqual(parseChatAiAssessment('I skipped the AI proficiency assessment'), {
    status: 'skipped',
    level: null,
  });
  assert.deepEqual(parseChatAiAssessment("I'm not sure about my AI proficiency level"), {
    status: 'not_sure',
    level: null,
  });
  assert.equal(parseChatAiAssessment('I completed the AI readiness practice task'), null);
});
