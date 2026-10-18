// The web service in front of the api (#57) with this branch's routes: the
// proxy has no path allow-list, so the journey, briefing, check, agent-action
// and HR routes reach the api through it, and /api/voice keeps its audio/wav
// body and X-Alya-Voice header. The web proxy signs with a stub ID token
// provider; pg-mem, the in-memory Firestore fake and synthetic people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAccountsApp } from './account-harness.mjs';
import { createWebApp } from '../../server/web-app.mjs';
import { wavFromPcm } from '../../server/gemini-voice.mjs';

const clip = wavFromPcm(Buffer.alloc(4800));

test('through the web proxy: journey, briefing, check, agent-action, HR and voice routes', async () => {
  const app = await startAccountsApp({
    sharedVoice: { render: async () => clip },
    geminiVoice: {
      header: 'gemini-sulafat',
      name: 'Alya · Sulafat (Gemini)',
      render: async () => clip,
    },
  });
  const distDir = await mkdtemp(join(tmpdir(), 'web-proxy-'));
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>OnboardAi</title>');
  const audiences = [];
  const web = createWebApp({
    apiUrl: app.url,
    distDir,
    env: {},
    idTokenProvider: async (audience) => {
      audiences.push(audience);
      return 'web-to-api-token';
    },
  }).listen(0, '127.0.0.1');
  await once(web, 'listening');
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  try {
    const hr = await app.hrBrowser();
    const { employee, browser } = await app.readyEmployee(hr);
    // The same sessions, now through the web origin.
    const viaWeb = (direct) => Object.assign(direct.copy(), { url: webUrl });
    const me = viaWeb(browser);
    const hrWeb = viaWeb(hr);

    const onboarding = await me.get('/api/me/onboarding');
    assert.equal(onboarding.status, 200);
    const handbook = onboarding.body.areas
      .flatMap((a) => a.steps)
      .find((s) => s.id === 'policies.employee-handbook');
    assert.deepEqual([handbook.briefingRequired, handbook.briefed], [true, false]);
    const check = await me.get('/api/me/onboarding/steps/policies.employee-handbook/check');
    assert.deepEqual([check.status, check.body.code], [409, 'BRIEFING_REQUIRED']);
    const briefed = await me.post('/api/me/onboarding/steps/policies.employee-handbook/briefing', {
      completion: 'listened',
    });
    assert.equal(briefed.status, 200);
    assert.equal(
      (await me.get('/api/me/onboarding/steps/policies.employee-handbook/check')).status,
      200,
    );
    assert.equal((await me.get('/api/me/ai-proficiency')).status, 200);
    assert.equal((await me.get('/api/me/quick-questions')).status, 200);
    assert.equal((await me.get('/api/me/first-day')).status, 200);
    assert.equal((await me.get('/api/me/support-requests')).status, 200);
    const action = await me.post('/api/me/agent-actions/00000000-0000-4000-8000-000000000000', {
      decision: 'approve',
    });
    assert.deepEqual([action.status, action.body.code], [409, 'ACTION_NOT_PENDING']);

    for (const path of [
      '/api/hr/support-requests',
      '/api/hr/knowledge-gaps',
      '/api/hr/team-insights',
      `/api/hr/employees/${employee.account.id}/onboarding`,
      `/api/hr/employees/${employee.account.id}/ai-proficiency`,
      `/api/hr/employees/${employee.account.id}/first-day`,
    ])
      assert.equal((await hrWeb.get(path)).status, 200, path);

    // The voice: audio/wav, the same bytes and X-Alya-Voice, which /api/config names.
    const spoken = await fetch(`${webUrl}/api/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: me.cookieHeader },
      body: JSON.stringify({ text: 'Welcome to UniVRse.', rate: 1 }),
    });
    assert.equal(spoken.status, 200);
    assert.equal(spoken.headers.get('content-type'), 'audio/wav');
    assert.equal(spoken.headers.get('x-alya-voice'), 'gemini-sulafat');
    assert.deepEqual(Buffer.from(await spoken.arrayBuffer()), clip);
    assert.equal((await me.get('/api/config')).body.voice.id, 'gemini-sulafat');
    // Every proxied request was signed for the api origin.
    assert.ok(audiences.length >= 15 && audiences.every((a) => a === app.url));
  } finally {
    await new Promise((resolve) => web.close(resolve));
    await app.close();
  }
});
