// Templates for tests of features that need steps the current checklist no longer
// lists (the written policy checks, the company matching activity): the built-in
// template plus those steps.
import {
  additionalAlignmentSteps,
  additionalPolicySteps,
  builtInTemplate,
} from '../../server/onboarding-content.mjs';

export function templateWithAdditionalPolicies(track = 'employee') {
  const template = builtInTemplate(track);
  const area = (id) => template.areas.find((item) => item.id === id);
  area('policies').steps.push(...structuredClone(additionalPolicySteps));
  area('alignment').steps.push(...structuredClone(additionalAlignmentSteps));
  return template;
}
