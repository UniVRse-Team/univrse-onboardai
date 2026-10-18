import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeFirestore } from './fake-firestore.mjs';
import { up as rebrandLunaDigital } from '../../server/migrations/firestore/013_rebrand_luna_digital.mjs';
import { DEFAULT_COMPANY_ID } from '../../server/companies.mjs';
import { createTestDatabase } from './test-database.mjs';
import { migrationsDirectory } from '../../server/database-migrations.mjs';

test('migration 013 updates univrse and luna-didital companyId to luna-digital across collections', async () => {
  const firestore = new FakeFirestore();

  firestore.write('employeeProfiles/p1', { name: 'Alice', companyId: 'univrse' });
  firestore.write('employeeProfiles/p2', { name: 'Bob', companyId: 'other-co' });
  firestore.write('employeeProfiles/p3', { name: 'Charlie', companyId: 'luna-didital' });
  firestore.write('companyDocuments/d1', { title: 'Doc 1', companyId: 'univrse' });
  firestore.write('supportRequests/s1', { issue: 'Help', companyId: 'univrse' });
  firestore.write('knowledgeGaps/g1', { question: 'Where is lunch?', companyId: 'univrse' });
  firestore.write('employeeDocumentSubmissions/sub1', { file: 'a.pdf', companyId: 'univrse' });
  firestore.write('employeeImports/imp1', { count: 5, companyId: 'univrse' });

  const logs = [];
  await rebrandLunaDigital({ firestore, log: (msg) => logs.push(msg) });

  assert.equal(firestore.read('employeeProfiles/p1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('employeeProfiles/p2').companyId, 'other-co');
  assert.equal(firestore.read('employeeProfiles/p3').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('companyDocuments/d1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('supportRequests/s1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('knowledgeGaps/g1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('employeeDocumentSubmissions/sub1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('employeeImports/imp1').companyId, DEFAULT_COMPANY_ID);

  assert.ok(logs[0].includes('employeeProfiles updated 2/3'));
  assert.ok(logs[0].includes('companyDocuments updated 1/1'));
  assert.ok(logs[0].includes('supportRequests updated 1/1'));
});

test('SQL migration 006 successfully handles pre-existing Luna Digital name and re-runs idempotently', async () => {
  const database = await createTestDatabase();
  const sql006 = readFileSync(join(migrationsDirectory, '006_company_luna_digital.sql'), 'utf8');

  // Verify initial state after all migrations
  const initialCompany = await database.rows('SELECT id, name FROM companies WHERE id = $1', [
    'luna-digital',
  ]);
  assert.equal(initialCompany.length, 1);
  assert.equal(initialCompany[0].name, 'Luna Digital');

  // Simulate staging scenario:
  // A legacy tenant 'luna-didital' already has name 'Luna Digital'
  await database.pool.query(
    `INSERT INTO companies (id, name, status) VALUES ('luna-didital', 'Luna Digital (temp)', 'active')`,
  );
  // Temporarily change name to exact 'Luna Digital'
  await database.pool.query(
    `UPDATE companies SET name = 'Luna Digital Legacy' WHERE id = 'luna-digital'`,
  );
  await database.pool.query(`UPDATE companies SET name = 'Luna Digital' WHERE id = 'luna-didital'`);

  // Re-run migration 006: it must not fail with unique constraint violation on companies_name_lower_key
  await database.pool.query(sql006);

  const finalCompany = await database.rows('SELECT id, name FROM companies WHERE id = $1', [
    'luna-digital',
  ]);
  assert.equal(finalCompany.length, 1);
  assert.equal(finalCompany[0].name, 'Luna Digital');

  const oldCompanies = await database.rows(
    "SELECT id FROM companies WHERE id IN ('univrse', 'luna-didital')",
  );
  assert.equal(oldCompanies.length, 0);

  // Idempotency: running migration 006 again succeeds cleanly
  await database.pool.query(sql006);
});
