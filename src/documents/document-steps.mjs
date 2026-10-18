// What a Documentation task shows, from saved data only. A task is complete once
// its required document has been saved; opening or clicking it counts for nothing.
// The employee list shows only Not Started / In Progress / Completed. In Progress
// is only the employee having the upload open on screen; nothing is saved by it. HR's
// review of a submission is separate and never appears here or changes progress.
export function latestFor(submissions, stepId) {
  return submissions
    .filter((item) => item.stepId === stepId)
    .reduce((a, b) => (!a || b.submittedAt > a.submittedAt ? b : a), null);
}

export function documentStepState(step, submissions, started = false) {
  const latest = latestFor(submissions, step.id);
  // The saved step is the authority; a saved document also counts while the
  // step's own record is catching up.
  const done = step.status === 'done' || Boolean(latest);
  return {
    key: done ? 'done' : started ? 'progress' : 'todo',
    label: done ? 'Completed' : started ? 'In Progress' : 'Not Started',
    action: done ? null : started ? 'Continue' : 'Start',
    done,
    latest,
  };
}

// Every required task in order, with the one to do next and the ones that wait
// for it: tasks open one at a time, from the first to the last.
export function documentTasks(steps, submissions) {
  const required = steps.filter((step) => step.required !== false);
  let nextFound = false;
  return required.map((step) => {
    const state = documentStepState(step, submissions);
    const isNext = !state.done && !nextFound;
    if (isNext) nextFound = true;
    return { step, ...state, isNext, locked: !state.done && !isNext };
  });
}

// The section: required tasks completed out of the real required count.
export function documentSectionStatus(steps, submissions) {
  const tasks = documentTasks(steps, submissions);
  const completed = tasks.filter((task) => task.done).length;
  const next = tasks.find((task) => task.isNext) || null;
  const finished = tasks.length > 0 && completed === tasks.length;
  return {
    completedCount: completed,
    total: tasks.length,
    percent: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
    completed: finished,
    nextStepId: next?.step.id || null,
    text: finished
      ? 'All required tasks completed'
      : `${completed} of ${tasks.length} required tasks completed`,
    completionMessage: finished
      ? 'Documentation complete. You have finished every required task.'
      : '',
  };
}
