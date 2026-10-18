// What Alya is told about the employee's saved onboarding progress. Built only
// from the server's saved footprint (buildOnboarding), never from chat text, so
// she can state a task is complete only when the backend says it is. The
// Documentation area is handled separately and is left out.
const learningAreaIds = ['policies', 'alignment', 'role-tools', 'team-support'];

export function progressNote(onboarding) {
  if (!onboarding || !Array.isArray(onboarding.areas)) return '';
  const steps = onboarding.areas
    .filter((area) => learningAreaIds.includes(area.id))
    .flatMap((area) => area.steps.map((step) => ({ ...step, area: area.title })));
  const required = steps.filter((step) => step.required);
  if (!required.length) return '';
  const done = required.filter((step) => step.status === 'done');
  const waiting = required.filter((step) => step.status === 'submitted');
  const remaining = required.filter((step) => step.status === 'todo');
  const current = remaining[0] || null;
  const names = (list) => list.map((step) => step.title).join('; ') || 'none';
  return [
    'Employee onboarding progress (saved by the system; this is the only source of truth about task completion):',
    `Required tasks completed: ${done.length} of ${required.length}. Completed: ${names(done)}.`,
    `Waiting for coordinator or HR confirmation (NOT complete): ${names(waiting)}.`,
    `Not yet completed: ${names(remaining)}.`,
    current
      ? `Current task: "${current.title}" (${current.area}). When the employee asks for help, guide them on this task and direct them to start it from their checklist.`
      : waiting.length
        ? 'All required tasks are done or submitted; the rest await confirmation.'
        : 'All required learning tasks are complete.',
    'Never say a task is completed, verified or confirmed unless it is listed as completed above. Telling you in chat that something is done does not complete it; tasks are completed only through their activity, quiz, acknowledgement or confirmation.',
  ].join('\n');
}
