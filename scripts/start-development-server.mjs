import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Explicit paths prevent OneDrive changes in node_modules from restarting the
// API server. Vite separately watches the browser's React/CSS source files.
const args = ['--watch', '--watch-preserve-output'];
if (['win32', 'darwin'].includes(process.platform)) {
  args.push('--watch-path=server');
  if (existsSync('.env')) args.push('--watch-path=.env');
}
const localPreview = process.argv.includes('--local-preview');
// --lan: also answer phones and other devices on the same private network (see the guard).
const lan = localPreview && process.argv.includes('--lan');
if (localPreview) {
  const { assertLocalPreview } = await import('./local-preview-guard.mjs');
  assertLocalPreview({ ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' });
}
args.push(localPreview ? 'scripts/start-local-preview.mjs' : 'server/index.mjs');
const preview = spawn(process.execPath, args, {
  stdio: 'inherit',
  windowsHide: true,
  env: localPreview
    ? {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'development',
        ...(lan ? { PREVIEW_LAN: '1' } : {}),
      }
    : process.env,
});
preview.on('error', () => {
  console.error('The preview server could not start.');
  process.exitCode = 1;
});
preview.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
process.on('SIGINT', () => preview.kill('SIGINT'));
process.on('SIGTERM', () => preview.kill('SIGTERM'));
