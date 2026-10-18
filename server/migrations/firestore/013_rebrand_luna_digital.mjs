import { DEFAULT_COMPANY_ID } from '../../companies.mjs';

// Firestore migration 012: Rebrand default tenant from 'univrse' to 'luna-digital'.
// Updates existing records with companyId: 'univrse' to companyId: 'luna-digital'.
// Idempotent: writes in batches of 400, only documents matching 'univrse'. Logs counts only.
export async function up({ firestore, log }) {
  const BATCH_SIZE = 400;

  async function updateCollectionCompany(collectionName) {
    const snapshot = await firestore.collection(collectionName).get();
    let batch = firestore.batch();
    let batchCount = 0;
    let totalUpdated = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data?.companyId !== 'univrse' && data?.companyId !== 'luna-didital') continue;

      batch.update(doc.ref, { companyId: DEFAULT_COMPANY_ID });
      batchCount++;
      totalUpdated++;

      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        batch = firestore.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    return { total: snapshot.size, updated: totalUpdated };
  }

  const profileCounts = await updateCollectionCompany('employeeProfiles');
  const documentCounts = await updateCollectionCompany('companyDocuments');
  const supportCounts = await updateCollectionCompany('supportRequests');
  const gapCounts = await updateCollectionCompany('knowledgeGaps');
  const submissionCounts = await updateCollectionCompany('employeeDocumentSubmissions');
  const importCounts = await updateCollectionCompany('employeeImports');

  log(
    `luna-digital rebrand backfill: employeeProfiles updated ${profileCounts.updated}/${profileCounts.total}, ` +
      `companyDocuments updated ${documentCounts.updated}/${documentCounts.total}, ` +
      `supportRequests updated ${supportCounts.updated}/${supportCounts.total}, ` +
      `knowledgeGaps updated ${gapCounts.updated}/${gapCounts.total}, ` +
      `employeeDocumentSubmissions updated ${submissionCounts.updated}/${submissionCounts.total}, ` +
      `employeeImports updated ${importCounts.updated}/${importCounts.total}`,
  );
}
