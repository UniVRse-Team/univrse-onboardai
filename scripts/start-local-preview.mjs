import express from 'express';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  assertLocalPreview,
  lanAddresses,
  lanPreview,
  localPreviewRequest,
} from './local-preview-guard.mjs';

// Reuse the repository's isolated API test fixtures: real account routes and
// migrations, pg-mem and fake Firestore. No .env, disk database or cloud client.
// These dependencies are excluded from the production Docker image.
export async function startLocalPreview({
  env = process.env,
  port = Number(env.PREVIEW_PORT) || Number(env.PORT) || 3100,
} = {}) {
  assertLocalPreview(env);
  const { startAccountsApp, syntheticProfile } =
    await import('../tests/server/account-harness.mjs');
  const { avatarRoute } = await import('../server/avatar-route.mjs');
  const { createServer: createViteServer } = await import('vite');
  const { createMemorySubmissionFiles } = await import('../server/submission-files.mjs');
  const { previewModels, previewRetrieve } = await import('./preview-chat.mjs');
  const fixture = await startAccountsApp({
    mode: 'gemini-chat',
    models: previewModels,
    companyRetrieve: previewRetrieve,
    submissionFiles: createMemorySubmissionFiles(),
  });
  const hr = await fixture.hrBrowser();
  const { browser: employee } = await fixture.readyEmployee(hr, {
    profile: syntheticProfile('Local Preview Employee', 'Product & Engineering'),
  });
  const adminId = '11111111-2222-4333-8444-555555555555';
  await fixture.store.createAccount({
    id: adminId,
    username: 'ADMIN-0001',
    role: 'admin',
    passwordHash: await fixture.hashing.hash('admin-pass-1'),
    mustChangePassword: false,
    action: 'admin_created',
    at: fixture.clock.now(),
    companyId: null,
  });
  const admin = fixture.browser();
  await admin.signIn('ADMIN-0001', 'admin-pass-1');
  const { seedPreviewSubmissions } = await import('./seed-preview-submissions.mjs');
  await seedPreviewSubmissions(fixture, hr, employee);
  const app = express();
  app.use((req, res, next) => {
    if (!localPreviewRequest(req)) return res.status(403).send('Local preview only.');
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', async (req, res, next) => {
    // Full-page preview links select the role independently for each tab.
    const path = req.headers.referer ? new URL(req.headers.referer).pathname : '/onboarding';
    const isExplicitAdmin =
      req.query.scope === 'admin' || req.headers['x-session-scope'] === 'admin';
    const isExplicitAccount =
      req.query.scope === 'account' || req.headers['x-session-scope'] === 'account';
    const browser =
      isExplicitAdmin || path.startsWith('/admin')
        ? admin
        : isExplicitAccount || path === '/hr' || path.startsWith('/hr/')
          ? hr
          : employee;
    // Preview sessions are fixed; never invalidate them through login controls.
    if (req.path.startsWith('/auth/') && req.method !== 'GET')
      return res
        .status(409)
        .json({ error: 'Local preview uses temporary accounts. Use npm run dev to test sign-in.' });
    try {
      const headers = { cookie: browser.cookieHeader };
      for (const key of ['content-type', 'x-file-name', 'x-onboarding-area', 'x-session-scope'])
        if (req.headers[key]) headers[key] = req.headers[key];
      const response = await fetch(fixture.url + req.originalUrl, {
        method: req.method,
        headers,
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req, duplex: 'half' } : {}),
      });
      res.status(response.status);
      for (const name of [
        'content-type',
        'content-disposition',
        'content-security-policy',
        'x-content-type-options',
      ])
        if (response.headers.has(name)) res.set(name, response.headers.get(name));
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/avatars/alya/alya.glb', avatarRoute('public'));
  const server = createServer(app);
  const vite = await createViteServer({
    configFile: false,
    mode: 'development',
    optimizeDeps: { entries: ['index.html'], noDiscovery: port === 0 },
    server: {
      middlewareMode: true,
      hmr: { server },
      watch: { ignored: ['**/.cache/**', '**/agent-platform/**'] },
    },
    appType: 'spa',
    plugins: [
      {
        name: 'local-preview-banner',
        transformIndexHtml(html) {
          return html.replace(
            '</body>',
            `<nav aria-label="Local development preview" style="position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff4ce;color:#241f10;padding:8px;text-align:center;font:13px sans-serif">Local preview · sample data · resets on restart &nbsp; <a href="/onboarding">Employee</a> · <a href="/hr/univrse">HR</a> · <a href="/admin">Admin</a> · <a href="/alya">Alya</a> · <a href="/profile">Profile</a></nav></body>`,
          );
        },
      },
    ],
  });
  app.use(vite.middlewares);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, lanPreview(env) ? '0.0.0.0' : '127.0.0.1', resolve);
  });
  return {
    url: `http://localhost:${server.address().port}`,
    lanUrls: lanPreview(env)
      ? lanAddresses().map((address) => `http://${address}:${server.address().port}`)
      : [],
    close: async () => {
      await vite.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fixture.close();
      await fixture.database.pool.end();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startLocalPreview({ port: Number(process.env.PORT) || 3100 });
  console.log(
    `Local development preview: ${preview.url} (temporary sample accounts; no real databases)`,
  );
  for (const url of preview.lanUrls)
    console.log(
      `Open on a phone on the same network: ${url}\nWARNING: anyone on this network can open it and is signed in without a password. Stop it when you are done.`,
    );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await preview.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
