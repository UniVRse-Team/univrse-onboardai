// #51: Alya proposes checklist changes through the ADK agent; nothing changes until Approve.
// Run: BASE_URL=http://127.0.0.1:3130 HR_ID=... HR_PASSWORD=... node --test tests/e2e/checklist-agent.e2e.mjs
// Needs the app with CHECKLIST_AGENT_URL set and the agent running (npm run checklist-agent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, ask } from './qa-lib.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:3130';
const hrId = process.env.HR_ID;
const hrPassword = process.env.HR_PASSWORD;
const skip = !hrId || !hrPassword ? 'HR_ID and HR_PASSWORD are not set' : false;
const log = (...a) => console.log(...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));

async function newEmployee(hr, fullName) {
  const dept = (await hr.get('/api/hr/departments')).json.departments.find((d) => !d.archived).name;
  const startDate = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const r = await hr.post('/api/hr/employees', {
    profile: { job: { fullName, department: dept, startDate, track: 'employee' } },
  });
  assert.equal(r.status, 201);
  const c = client(base);
  const temp = r.json.temporaryPassword;
  const { username } = r.json.employee.account;
  await c.post('/api/auth/sign-in', { username, password: temp });
  const password = `Qa-${Math.random().toString(36).slice(2)}-Pass1!`;
  assert.equal(
    (await c.post('/api/auth/password', { currentPassword: temp, newPassword: password })).status,
    200,
  );
  return { c, id: r.json.employee.account.id };
}
const stepStatus = async (c, id) => {
  const o = (await c.get('/api/me/onboarding')).json;
  for (const a of o.areas) for (const s of a.steps) if (s.id === id) return { s: s.status, o };
};

test('#51 propose, approve, decline, submitted, policy, cross-account', { skip }, async () => {
  const hr = client(base);
  assert.equal(
    (await hr.post('/api/auth/sign-in', { username: hrId, password: hrPassword })).status,
    200,
  );
  const a = await newEmployee(hr, 'Qa Agent A');
  const b = await newEmployee(hr, 'Qa Agent B');

  const brief = async (id) =>
    assert.equal(
      (await a.c.post(`/api/me/onboarding/steps/${id}/briefing`, { completion: 'listened' }))
        .status,
      200,
    );

  // 0. #63: before the buddy briefing Alya points to it and marks nothing
  let r = await ask(a.c, "I've met my buddy");
  assert.equal(r.status, 200);
  assert.ok(!r.json.proposedAction, 'no proposal before the briefing');
  assert.match(r.json.answer, /briefing/i);
  assert.equal((await stepStatus(a.c, 'team-support.meet-buddy')).s, 'todo');

  // 1. buddy
  await brief('team-support.meet-buddy');
  r = await ask(a.c, "I've met my buddy today");
  log('buddy', r.status, r.json);
  assert.equal(r.status, 200);
  const p1 = r.json.proposedAction;
  assert.ok(p1, 'proposal');
  assert.equal(p1.stepId, 'team-support.meet-buddy');
  assert.equal(p1.newStatus, 'done');
  assert.equal((await stepStatus(a.c, p1.stepId)).s, 'todo', 'unchanged before approve');
  const approve = await a.c.post(`/api/me/agent-actions/${p1.id}`, { decision: 'approve' });
  log('approve', approve.status, approve.json);
  assert.equal(approve.status, 200);
  assert.equal((await stepStatus(a.c, p1.stepId)).s, 'done');
  const again = await a.c.post(`/api/me/agent-actions/${p1.id}`, { decision: 'approve' });
  assert.equal(again.status, 409, 'cannot approve twice');

  // 2. decline then approve later
  await brief('team-support.meet-manager');
  r = await ask(a.c, "I've met my manager");
  const p2 = r.json.proposedAction;
  log('manager', r.status, r.json);
  assert.ok(p2);
  const dec = await a.c.post(`/api/me/agent-actions/${p2.id}`, { decision: 'decline' });
  log('decline', dec.status, dec.json);
  assert.equal(dec.status, 200);
  assert.equal((await stepStatus(a.c, p2.stepId)).s, 'todo');
  const late = await a.c.post(`/api/me/agent-actions/${p2.id}`, { decision: 'approve' });
  log('late approve', late.status, late.json);
  assert.equal(late.status, 409);
  assert.equal((await stepStatus(a.c, p2.stepId)).s, 'todo', 'still todo');

  // 3. contract -> submitted
  await brief('documentation.tax-id-documents');
  r = await ask(a.c, 'I signed my contract');
  const p3 = r.json.proposedAction;
  log('contract', r.status, r.json);
  assert.ok(p3);
  assert.equal(p3.newStatus, 'submitted');
  assert.equal((await stepStatus(a.c, p3.stepId)).s, 'todo');
  const ap3 = await a.c.post(`/api/me/agent-actions/${p3.id}`, { decision: 'approve' });
  log('contract approve', ap3.status, ap3.json);
  assert.equal(ap3.status, 200);
  const st = await stepStatus(a.c, p3.stepId);
  assert.equal(st.s, 'submitted');
  assert.ok(st.o.waitingOnHr >= 1);

  // 4. policy step: nothing marked
  r = await ask(a.c, 'I finished the privacy and data handling policy');
  log('policy', r.status, r.json);
  assert.equal(r.status, 200);
  assert.ok(!r.json.proposedAction, 'no proposal for a check step');
  assert.equal((await stepStatus(a.c, 'policies.data-protection')).s, 'todo');

  // 5. another account cannot approve
  await brief('role-tools.laptop-accounts');
  r = await ask(a.c, "I've set up my laptop and accounts");
  const p5 = r.json.proposedAction;
  log('laptop', r.status, r.json);
  assert.ok(p5);
  const cross = await b.c.post(`/api/me/agent-actions/${p5.id}`, { decision: 'approve' });
  log('cross', cross.status, cross.json);
  assert.ok([404, 409].includes(cross.status));
  assert.equal((await stepStatus(a.c, p5.stepId)).s, 'todo');
  const hrTry = await hr.post(`/api/me/agent-actions/${p5.id}`, { decision: 'approve' });
  log('hr', hrTry.status, hrTry.json);
  assert.ok([403, 404, 409].includes(hrTry.status));
  // owner can still approve afterwards
  const own = await a.c.post(`/api/me/agent-actions/${p5.id}`, { decision: 'approve' });
  assert.equal(own.status, 200);
  assert.equal((await stepStatus(a.c, p5.stepId)).s, 'done');

  // 6. F5: a policy check the employee already PASSED replies fast, "already done"
  const hb = 'policies.employee-handbook';
  await brief(hb);
  const qs = (await a.c.get(`/api/me/onboarding/steps/${hb}/check`)).json;
  for (const o of qs.options) {
    const pr = await a.c.post(`/api/me/onboarding/steps/${hb}/check`, { optionId: o.id });
    if (pr.json?.correct) break;
  }
  assert.equal((await stepStatus(a.c, hb)).s, 'done');
  const t0 = Date.now();
  r = await ask(a.c, "I've read the employee handbook");
  const took = Date.now() - t0;
  log('already passed', r.status, took, r.json);
  assert.equal(r.status, 200);
  assert.ok(took < 45000, `took ${took} ms`);
  assert.ok(!r.json.proposedAction);
  assert.doesNotMatch(r.json.answer, /couldn.t update/i);
  assert.match(r.json.answer, /already|done|passed|complete/i);
});
