import { learningAreas, accessState } from './learning-area-model.mjs';

// Activities open on their own page: /onboarding/activity/<id>, inside the
// existing employee shell. The id is a task id (for example
// "policies.data-protection") or one of the two area-level activities.
export const ACTIVITY_PREFIX = '/onboarding/activity/';
export const activityPath = (id) => ACTIVITY_PREFIX + encodeURIComponent(id);
export function activityIdFromPath(path) {
  if (!path.startsWith(ACTIVITY_PREFIX)) return null;
  try {
    return decodeURIComponent(path.slice(ACTIVITY_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

export const RESPONSIBILITIES_ACTIVITY = 'role-tools.responsibilities';
export const ROUTING_ACTIVITY = 'team-support.support-routing';
const alignmentKey = {
  'products-customers': 'products',
  'mission-values': 'values',
  'org-structure': 'teams',
  'role-contribution': 'roleContribution',
};

const AREA_TITLES = {
  policies: 'Policies & Safe Practices',
  alignment: 'Company Purpose & Alignment',
  'role-tools': 'Role, Tools & AI Readiness',
  'team-support': 'People & Workplace Support',
};

// What an activity page shows, from the saved onboarding and the served content.
// kind: policy | quiz | access | ai | check | checklist | prefs.
export function resolveActivity(id, onboarding, content) {
  if (!id) return null;
  const areaOfId = id.split('.')[0];
  if (!learningAreas.includes(areaOfId)) return null;
  const area = onboarding?.areas?.find((a) => a.id === areaOfId);
  const base = { id, areaId: areaOfId, areaTitle: AREA_TITLES[areaOfId] };

  if (id === RESPONSIBILITIES_ACTIVITY)
    return {
      ...base,
      kind: 'checklist',
      title: 'Roles & Responsibilities',
      instructions: 'Confirm that you know your role and have talked through it with your manager.',
      objectives: ['Know your role and what your manager expects from you first.'],
      requirement: 'Tick every item and save. This is an acknowledgement, not an assessment.',
      mandatory: false,
    };
  if (id === ROUTING_ACTIVITY) {
    const activity = content?.supportRouting;
    return {
      ...base,
      kind: 'quiz',
      title: activity?.title || 'Find the right contact',
      instructions: activity?.instructions || '',
      objectives: activity?.objectives || [],
      requirement: activity
        ? `Answer every situation. Pass mark: ${activity.passingScore}%. You can retry.`
        : '',
      mandatory: false,
      area: 'team-support',
      activityKey: 'support-routing',
      questions: activity?.questions || [],
      passingScore: activity?.passingScore,
    };
  }

  const step = area?.steps?.find((s) => s.id === id);
  if (!step) return null;
  const common = { ...base, step, title: step.title, mandatory: step.required !== false };

  // Read-and-confirm steps (no approved quiz or activity) have no page: they are
  // confirmed from the onboarding page like any setup task.
  if (areaOfId === 'policies' && step.completion !== 'check') return null;
  if (areaOfId === 'alignment' && !alignmentKey[id.replace('alignment.', '')]) return null;
  if (areaOfId === 'policies') {
    const policy = content?.policies?.[id];
    return {
      ...common,
      kind: 'policy',
      title: policy?.title || step.title,
      instructions: step.description,
      objectives: policy?.objectives || [],
      policy,
      area: 'policies',
      activityKey: id,
      questions: policy?.quiz?.questions || [],
      passingScore: policy?.quiz?.passingScore,
      requirement: policy?.quiz
        ? `Pass the quiz (${policy.quiz.passingScore}% or more). You can retry.`
        : 'Acknowledge the policy. No approved quiz is configured for it yet.',
    };
  }
  if (areaOfId === 'alignment') {
    const slug = id.replace('alignment.', '');
    const activity = content?.alignment?.[alignmentKey[slug]];
    return {
      ...common,
      kind: 'quiz',
      instructions: activity?.instructions || step.description,
      objectives: activity?.objectives || [],
      area: 'alignment',
      activityKey: slug,
      questions: activity?.questions || [],
      passingScore: activity?.passingScore,
      notesPrompt: activity?.notesPrompt,
      requirement: activity
        ? `Answer every question. Pass mark: ${activity.passingScore}%. You can retry.`
        : '',
    };
  }
  if (areaOfId === 'role-tools') {
    if (content?.toolAccessSteps?.includes(id))
      return {
        ...common,
        kind: 'access',
        instructions: step.description,
        objectives: ['Request confirmation that you can open this tool.'],
        requirement:
          'Request confirmation. The task completes when your onboarding coordinator confirms your access.',
      };
    if (id === 'role-tools.ai-readiness-training')
      return {
        ...common,
        kind: 'ai',
        instructions: step.description,
        objectives: ['Tell us your AI experience so we can suggest suitable training.'],
        requirement: 'Save your self-assessment. There is no pass mark.',
      };
    if (step.completion === 'check')
      return {
        ...common,
        kind: 'check',
        instructions: step.description,
        objectives: ['Show you understand how to work in this tool.'],
        requirement: 'Answer the scenario correctly. You can retry.',
      };
    return null;
  }
  if (id === 'team-support.working-preferences')
    return {
      ...common,
      kind: 'prefs',
      instructions: step.description,
      objectives: [],
      requirement: 'Optional. Skipping never affects your progress.',
      mandatory: false,
    };
  return null;
}

// Task ids that open an activity page, given what the server serves.
export const hasActivityPage = (step, areaId, content) =>
  Boolean(resolveActivity(step.id, { areas: [{ id: areaId, steps: [step] }] }, content));

// Question helpers shared with the quiz runner.
export function isAnswered(question, answers) {
  const value = answers?.[question.id];
  if (question.type === 'match')
    return Boolean(value) && question.pairs.every((pair) => Boolean(value[pair.id]));
  return [].concat(value ?? []).length > 0;
}
export const unansweredIds = (questions, answers) =>
  questions.filter((question) => !isAnswered(question, answers)).map((question) => question.id);

// What the activity page says about where the task stands.
export function activityStatus(activity, records) {
  if (!activity) return '';
  if (activity.kind === 'access')
    return { done: 'Verified', awaiting: 'Awaiting verification', none: 'Not Started' }[
      accessState(activity.step, records?.roleTools?.tools?.[activity.id])
    ];
  if (activity.step?.status === 'done') return 'Completed';
  // Begun but not finished: an acknowledgement, a quiz attempt or locked answers.
  const key = `${activity.area}/${activity.activityKey}`;
  const begun =
    records?.policies?.[activity.id]?.acknowledgedAt ||
    records?.policies?.[activity.id]?.quiz?.attempts ||
    records?.alignment?.[activity.activityKey]?.attempts ||
    Object.keys(records?.sessions?.[key]?.answers || {}).length;
  return begun || activity.step?.briefed ? 'In Progress' : 'Not Started';
}
