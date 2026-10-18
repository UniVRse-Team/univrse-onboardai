export const learningAreas = ['policies', 'alignment', 'role-tools', 'team-support'];
export function learningSummary(area) {
  const required = area.steps.filter((step) => step.required !== false);
  const done = required.filter((step) => step.status === 'done').length;
  return {
    done,
    total: required.length,
    next: required.find((step) => step.status !== 'done'),
    action:
      done === required.length
        ? 'Review'
        : area.steps.some((step) => step.briefed || step.status !== 'todo')
          ? 'Continue'
          : 'Start',
  };
}
export const learningStatus = (step) =>
  step.status === 'done'
    ? 'Completed'
    : step.briefed || step.status === 'submitted'
      ? 'In Progress'
      : 'Not Started';
export function continueLearning(areas) {
  return areas
    .filter((area) => learningAreas.includes(area.id))
    .flatMap((area) => area.steps)
    .find((step) => step.required !== false && step.status !== 'done');
}
export function focusLearningStep(id) {
  const task = document.getElementById('learning-' + id);
  if (!task) return;
  const area = task.closest('.learning-area') || task.closest('details');
  if (area) area.open = true;
  if (task.tagName === 'DETAILS') {
    task.open = true;
    task.querySelector('summary').focus();
  } else task.focus();
  task.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
// Only URLs supplied in the existing task content are offered; never construct company links.
// The label of the link to a policy's full document: the handbook has its own
// wording; the link itself only exists when an approved document URL is configured.
export const policyDocumentLabel = (stepId, document) =>
  stepId === 'policies.employee-handbook' ? 'View Employee Handbook' : `Open ${document.title} ↗`;

// A task's description without its links (they are shown as buttons instead).
export const descriptionText = (step) =>
  (step.description || '')
    .replace(/\s*https:\/\/[^\s)<>]+/g, '')
    .replace(/\s+\(\)/g, '')
    .trim();

// The name of a task's resource button.
export function resourceLabel(step, url) {
  if (step.id === 'documentation.employee-information-form') return 'Download the form ↗';
  return url.startsWith('https://drive.google.com/')
    ? 'Open the document ↗'
    : 'Open assigned resource ↗';
}

export function taskResources(step) {
  return [...new Set((step.description || '').match(/https:\/\/[^\s)<>]+/g) || [])];
}

// How a task is verified, in the employee's words: what finishes it, whether it
// is mandatory, what happens when it is not passed, and what is saved. The
// methods match the server (server/task-verification-routes.mjs).
const guides = {
  policy: {
    method: 'Handbook reading + short quiz',
    toComplete: 'Read the handbook (optional link above), then pass the quiz at the pass mark.',
    ifStuck: 'Read the notes on the questions you missed and retry as often as you need.',
    saved: 'Each quiz attempt, your score and the date you passed.',
  },
  matching: {
    method: 'Matching activity',
    toComplete: 'Match every item correctly.',
    ifStuck: 'Re-read the summary above and try again.',
    saved: 'Each attempt and the date you passed.',
  },
  knowledge: {
    method: 'Short knowledge check',
    toComplete: 'Answer the questions and reach the pass mark.',
    ifStuck: 'Read the notes on missed questions and retry as often as you need.',
    saved: 'Each attempt, your score and the date you passed.',
  },
  access: {
    method: 'Coordinator confirmation',
    toComplete:
      'Request confirmation. This task completes when your onboarding coordinator confirms you have access.',
    ifStuck: 'If you cannot open the tool, ask your onboarding coordinator for the invitation.',
    saved: 'Your request and the coordinator’s confirmation.',
  },
  scenario: {
    method: 'Scenario check',
    toComplete: 'Answer the scenario correctly.',
    ifStuck: 'Read the explanation and try again.',
    saved: 'Completion once you pass.',
  },
  assessment: {
    method: 'Self-assessment (not pass/fail)',
    toComplete:
      'Save your self-assessment. The practice exercise is optional and recorded separately.',
    ifStuck: 'Choose “Not sure yet” if you cannot rate yourself. Nothing here is graded.',
    saved: 'Your rating, your learning path and, if you confirm it, the practice exercise.',
  },
  self: {
    method: 'Self-reported practical task',
    toComplete: 'Do the task, then confirm it. This is your own confirmation, not a system check.',
    ifStuck: 'Ask your onboarding coordinator or manager for help.',
    saved: 'Your confirmation and its date.',
  },
  optional: {
    method: 'Optional',
    toComplete: 'Nothing is required. Skip it if you prefer.',
    ifStuck: 'Nothing is lost if you skip.',
    saved: 'Nothing is saved for this activity.',
  },
};

// The alignment steps that have a server-side activity (server/task-verification.mjs).
const alignmentActivitySteps = [
  'alignment.products-customers',
  'alignment.mission-values',
  'alignment.org-structure',
  'alignment.role-contribution',
];

export function verificationGuide(step, areaId, accessStepIds = []) {
  const mandatory = step.required !== false;
  let kind = 'self';
  if (step.id === 'role-tools.ai-readiness-training') kind = 'assessment';
  else if (!mandatory) kind = 'optional';
  // Policies and alignment steps with an approved activity are verified by it; the
  // others (read this, add that) are confirmed by the employee like setup tasks.
  else if (areaId === 'policies' && step.completion === 'check') kind = 'policy';
  else if (areaId === 'alignment' && alignmentActivitySteps.includes(step.id))
    kind = step.id === 'alignment.products-customers' ? 'matching' : 'knowledge';
  else if (accessStepIds.includes(step.id)) kind = 'access';
  else if (step.completion === 'check') kind = 'scenario';
  return { kind, mandatory, ...guides[kind] };
}

// Where an access request stands: 'done' | 'awaiting' | 'none'.
export function accessState(step, record) {
  if (step.status === 'done' || record?.status === 'confirmed') return 'done';
  return record?.status === 'awaiting_confirmation' ? 'awaiting' : 'none';
}

// The checklist beside Alya: the same steps and statuses as the onboarding
// section (never a second list). Only required steps are counted; a step is
// "done" only when the server says so, never because its section was opened.
export function checklistModel(onboarding, { accessStepIds = [], tools = {} } = {}) {
  // All five areas, Documentation included, so Alya's list is the same list and the
  // same saved progress as the My onboarding page.
  const groups = (onboarding?.areas || [])
    .filter((area) => area.id === 'documentation' || learningAreas.includes(area.id))
    .map((area) => {
      const tasks = area.steps.map((step) => ({
        id: step.id,
        title: step.title,
        required: step.required !== false,
        done: step.status === 'done',
        started: step.status === 'submitted' || Boolean(step.briefed),
        // Submitted or awaiting a coordinator: nothing more for the employee to do yet.
        waiting:
          step.status === 'submitted' ||
          (accessStepIds.includes(step.id) && accessState(step, tools[step.id]) === 'awaiting'),
        state: taskStatusLabel(step, area.id, accessStepIds, tools[step.id]),
      }));
      const required = tasks.filter((task) => task.required);
      return {
        id: area.id,
        title: area.title,
        icon: area.icon,
        tasks,
        done: required.filter((task) => task.done).length,
        total: required.length,
      };
    });
  const done = groups.reduce((sum, group) => sum + group.done, 0);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  // The current task: the first required task, in checklist order, that the
  // employee can still act on. Tasks waiting on someone else are skipped, not
  // counted as done. Optional tasks are never current.
  const all = groups.flatMap((group) => group.tasks);
  const current = all.find((task) => task.required && !task.done && !task.waiting) || null;
  const waiting = all.filter((task) => task.required && !task.done && task.waiting).length;
  for (const task of all) task.current = task === current;
  return {
    groups,
    done,
    total,
    // The overall percent is the server's own, as on the My onboarding page.
    percent: Number.isFinite(onboarding?.percent)
      ? onboarding.percent
      : total
        ? Math.round((done / total) * 100)
        : 0,
    current,
    waiting,
    // Genuine completion: every required task is done on the server.
    complete: total > 0 && done === total,
  };
}

// Clicking a checklist task hands its id to the onboarding page, which opens it.
export const focusStepKey = 'onboarding-focus-step';

// The honest status of a task. Access to a tool is "Verified" only after the
// coordinator confirms it; a self-reported setup task is "Employee-confirmed".
export function taskStatusLabel(step, areaId, accessStepIds = [], toolRecord) {
  if (areaId === 'role-tools' && accessStepIds.includes(step.id)) {
    const state = accessState(step, toolRecord);
    if (state === 'done') return 'Verified';
    if (state === 'awaiting') return 'Awaiting verification';
    return step.briefed ? 'In Progress' : 'Not Started';
  }
  if (
    step.status === 'done' &&
    step.completion === 'self' &&
    (areaId === 'role-tools' || areaId === 'team-support') &&
    step.id !== 'role-tools.ai-readiness-training'
  )
    return 'Employee-confirmed';
  return learningStatus(step);
}

// Where a quiz stands, from saved records only: the passed attempt record, the
// attempt in progress (answers already locked, saved as a session) and the last
// recorded attempt. Temporary screen state never enters here.
export function quizStage({ record, session } = {}) {
  if (record?.passed) return 'passed';
  if (Object.keys(session?.answers || {}).length > 0) return 'in-progress';
  if (record?.attempts > 0) return 'failed';
  return 'not-started';
}
const quizStatusText = {
  passed: 'Passed',
  'in-progress': 'In progress',
  failed: 'Not passed yet',
  'not-started': 'Not started',
};

// The one primary button of a task: always the next required action, named for
// the activity it launches. mode "open" opens the activity page; mode "confirm"
// records an employee-confirmed setup task. null = nothing to do (finished, or
// waiting on someone else). `quiz` is a quizStage() value from the saved records.
export function primaryAction(
  step,
  areaId,
  { accessStepIds = [], hasQuiz = false, acknowledged = false, quiz = 'not-started', tool } = {},
) {
  const kind = verificationGuide(step, areaId, accessStepIds).kind;
  const done = step.status === 'done';
  const quizLabel = (noun) =>
    ({
      'not-started': 'Start ' + noun,
      'in-progress': 'Continue ' + noun,
      failed: 'Retry ' + noun,
      passed: 'Start ' + noun,
    })[quiz];
  if (kind === 'policy') {
    if (done) return { label: 'Review', mode: 'open', quiet: true };
    // A policy with an approved quiz is tested by the quiz; one without it is
    // acknowledged. The full document is a separate link beside the button.
    if (!hasQuiz) return { label: 'Read and Confirm Acknowledgement', mode: 'open' };
    return { label: quizLabel('Quiz'), mode: 'open' };
  }
  if (kind === 'matching' || kind === 'knowledge') {
    if (done) return { label: 'Review', mode: 'open', quiet: true };
    const noun =
      kind === 'matching' || step.id === 'alignment.role-contribution' ? 'Activity' : 'Quiz';
    return { label: quizLabel(noun), mode: 'open' };
  }
  if (kind === 'access') {
    return accessState(step, tool) === 'none'
      ? { label: 'Request Access Verification', mode: 'open' }
      : null;
  }
  if (kind === 'assessment')
    return {
      label: done ? 'Review Self-Assessment' : 'Start Self-Assessment',
      mode: 'open',
      quiet: done,
    };
  if (kind === 'scenario') return done ? null : { label: 'Start Quiz', mode: 'open' };
  if (kind === 'optional')
    return step.id === 'team-support.working-preferences'
      ? { label: 'Open Optional Form', mode: 'open', quiet: true }
      : done
        ? null
        : { label: 'Confirm Setup', mode: 'confirm', quiet: true };
  // Read-and-confirm tasks are confirmed by the employee, in their own words.
  if (areaId === 'policies')
    return done ? null : { label: 'Confirm I Have Read This', mode: 'confirm' };
  return done ? null : { label: 'Confirm Setup', mode: 'confirm' };
}

// The real cause of a failed load, in plain words, never a generic message.
export function describeLoadError(e) {
  if (e?.status === 404 || e?.code === 'NOT_FOUND')
    return 'The verification activities could not be loaded: this server does not have the verification routes. Restart the server so it runs the current code.';
  if (e?.status === 401 || e?.status === 403)
    return 'The verification activities could not be loaded because your session is not allowed to read them. Sign in again.';
  if (e?.status === 503)
    return (
      e.message || 'The verification activities could not be loaded because storage is unavailable.'
    );
  if (!e?.status)
    return 'The verification activities could not be loaded: the server could not be reached. Check your connection.';
  return `The verification activities could not be loaded (${e.code || e.status}): ${e.message}`;
}
