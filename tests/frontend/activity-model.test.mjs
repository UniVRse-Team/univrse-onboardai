import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityIdFromPath,
  activityPath,
  isAnswered,
  resolveActivity,
  unansweredIds,
} from '../../src/portal/activity-model.mjs';
import { templateWithAdditionalPolicies } from '../server/template-fixtures.mjs';
import { buildVerificationContent } from '../../server/verification-content.mjs';
import {
  publicVerificationContent,
  TOOL_ACCESS_STEP_IDS,
} from '../../server/task-verification.mjs';

const onboarding = { areas: templateWithAdditionalPolicies('employee').areas };
const content = {
  ...publicVerificationContent(buildVerificationContent()),
  toolAccessSteps: TOOL_ACCESS_STEP_IDS,
};

test('activity paths round-trip and reject anything else', () => {
  assert.equal(
    activityPath('policies.data-protection'),
    '/onboarding/activity/policies.data-protection',
  );
  assert.equal(
    activityIdFromPath('/onboarding/activity/policies.data-protection'),
    'policies.data-protection',
  );
  assert.equal(activityIdFromPath('/onboarding'), null);
  assert.equal(activityIdFromPath('/onboarding/activity/'), null);
  assert.equal(activityIdFromPath('/onboarding/activity/%E0%A4%A'), null);
});

test('each learning task resolves to the right kind of page; Documentation and unknown ids do not', () => {
  const kind = (id) => resolveActivity(id, onboarding, content)?.kind ?? null;
  assert.equal(kind('policies.data-protection'), 'policy');
  assert.equal(kind('alignment.products-customers'), 'quiz');
  assert.equal(kind('role-tools.gsheet-account'), 'access');
  assert.equal(kind('role-tools.ai-readiness-training'), 'ai');
  assert.equal(kind('role-tools.gsheet-training-sop'), 'check');
  assert.equal(kind('role-tools.responsibilities'), 'checklist');
  assert.equal(kind('team-support.support-routing'), 'quiz');
  assert.equal(kind('team-support.working-preferences'), 'prefs');
  // plain setup tasks are confirmed on the dashboard; they have no page
  assert.equal(kind('role-tools.email-signature'), null);
  assert.equal(kind('policies.company-sop-policies'), null);
  assert.equal(kind('policies.sop-internal-meeting'), null);
  assert.equal(kind('alignment.social-media-accounts'), null);
  assert.equal(kind('documentation.tax-id-documents'), null);
  assert.equal(kind('nonsense'), null);
  assert.equal(kind(''), null);
});

test('mandatory policy activities carry substantial question sets and an area title', () => {
  for (const id of [
    'policies.employee-handbook',
    'policies.workplace-conduct',
    'policies.data-protection',
    'policies.responsible-ai',
  ]) {
    const activity = resolveActivity(id, onboarding, content);
    assert.ok(activity.questions.length >= 8, id);
    assert.equal(activity.areaTitle, 'Policies & Safe Practices');
    assert.equal(activity.mandatory, true);
    assert.ok(activity.objectives.length > 0);
  }
  assert.equal(
    resolveActivity('team-support.working-preferences', onboarding, content).mandatory,
    false,
  );
});

test('answered/unanswered logic covers single, multi and match questions', () => {
  const single = { id: 's', type: 'single', options: [] };
  const multi = { id: 'm', type: 'multi', multiple: true, options: [] };
  const matchQ = { id: 'x', type: 'match', pairs: [{ id: 'a' }, { id: 'b' }], choices: [] };
  assert.equal(isAnswered(single, { s: 'a' }), true);
  assert.equal(isAnswered(single, {}), false);
  assert.equal(isAnswered(multi, { m: [] }), false);
  assert.equal(isAnswered(multi, { m: ['a'] }), true);
  assert.equal(isAnswered(matchQ, { x: { a: 'c' } }), false);
  assert.equal(isAnswered(matchQ, { x: { a: 'c', b: 'd' } }), true);
  assert.deepEqual(unansweredIds([single, multi, matchQ], { s: 'a' }), ['m', 'x']);
});
