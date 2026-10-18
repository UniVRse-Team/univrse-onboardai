import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeFirestore } from './fake-firestore.mjs';
import { up as rebrandLunaDigital } from '../../server/migrations/firestore/013_rebrand_luna_digital.mjs';
import { DEFAULT_COMPANY_ID } from '../../server/companies.mjs';

test('migration 013 updates univrse companyId to luna-digital across collections', async () => {
  const firestore = new FakeFirestore();

  firestore.write('employeeProfiles/p1', { name: 'Alice', companyId: 'univrse' });
  firestore.write('employeeProfiles/p2', { name: 'Bob', companyId: 'other-co' });
  firestore.write('companyDocuments/d1', { title: 'Doc 1', companyId: 'univrse' });
  firestore.write('supportRequests/s1', { issue: 'Help', companyId: 'univrse' });
  firestore.write('knowledgeGaps/g1', { question: 'Where is lunch?', companyId: 'univrse' });
  firestore.write('employeeDocumentSubmissions/sub1', { file: 'a.pdf', companyId: 'univrse' });
  firestore.write('employeeImports/imp1', { count: 5, companyId: 'univrse' });

  const logs = [];
  await rebrandLunaDigital({ firestore, log: (msg) => logs.push(msg) });

  assert.equal(firestore.read('employeeProfiles/p1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('employeeProfiles/p2').companyId, 'other-co');
  assert.equal(firestore.read('companyDocuments/d1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('supportRequests/s1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('knowledgeGaps/g1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('employeeDocumentSubmissions/sub1').companyId, DEFAULT_COMPANY_ID);
  assert.equal(firestore.read('employeeImports/imp1').companyId, DEFAULT_COMPANY_ID);

  assert.ok(logs[0].includes('employeeProfiles updated 1/2'));
  assert.ok(logs[0].includes('companyDocuments updated 1/1'));
  assert.ok(logs[0].includes('supportRequests updated 1/1'));
});
