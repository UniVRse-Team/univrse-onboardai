// The five onboarding areas HR files company documents under (issue #68), plus
// the extra category 'additional' ("Other useful guidance", not listed here).
// The ids match the onboarding template areas. Each area holds any number of
// documents. A document's title is its own, never the area's.
// The one source of truth for the order of the five areas. My Onboarding
// (server/onboarding-content.mjs re-exports it) and the HR Company
// Documentation page both follow it, so "1. Documentation" is area #1 in both.
// Browser-safe: the frontend imports this file directly.
export const areaOrder = Object.freeze([
  'documentation',
  'policies',
  'alignment',
  'role-tools',
  'team-support',
]);

const topicsById = [
  {
    id: 'alignment',
    title: 'Company Purpose & Alignment',
    description: 'Understand what the company does, its goals and how your role contributes.',
    icon: 'planet',
  },
  {
    id: 'documentation',
    title: 'Documentation',
    description: 'Complete required forms and submit documents.',
    icon: 'checklist',
  },
  {
    id: 'team-support',
    title: 'People & Workplace Support',
    description:
      'Know your teammates, who to ask for help and optionally share working preferences or support needs.',
    icon: 'people',
  },
  {
    id: 'role-tools',
    title: 'Role, Tools & AI Readiness',
    description:
      'Set up work tools, understand your responsibilities and identify suitable AI training.',
    icon: 'laptop',
  },
  {
    id: 'policies',
    title: 'Policies & Safe Practices',
    description: 'Understand company rules, privacy and responsible AI use.',
    icon: 'shield',
  },
];

export const onboardingDocumentTopics = areaOrder.map((id) =>
  topicsById.find((topic) => topic.id === id),
);

// The category ids a document can have.
export const documentCategories = [
  ...onboardingDocumentTopics.map((topic) => topic.id),
  'additional',
];

// Migration 004: the retired six topic ids and the area each moves to.
export const retiredTopicAreas = Object.freeze({
  company: 'alignment',
  handbook: 'policies',
  'first-week': 'documentation',
  role: 'role-tools',
  it: 'role-tools',
  communication: 'team-support',
});
