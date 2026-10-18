import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

test('index.html references the favicon', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.match(
    html,
    /<link\s+rel=["']icon["']\s+type=["']image\/png["']\s+href=["']\/favicon\.png["']\s*\/?>/,
  );
});

test('favicon files exist in public/ and are non-empty', async () => {
  const pngStat = await stat('public/favicon.png');
  assert.ok(pngStat.size > 0, 'public/favicon.png must not be empty');

  const icoStat = await stat('public/favicon.ico');
  assert.ok(icoStat.size > 0, 'public/favicon.ico must not be empty');
});
