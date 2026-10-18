import { DEFAULT_COMPANY_ID } from '../../companies.mjs';
import { journeyCollections } from '../../onboarding-collections.mjs';
import { starterTemplate, starterTemplateVersion, tracks } from '../../onboarding-content.mjs';

// Firestore migration 011 (issue #86): multi-company tenants.
// 1. Backfills companyId: 'univrse' where missing on:
//    employeeProfiles, companyDocuments, supportRequests (and assignedHrAccountId: null),
//    knowledgeGaps, employeeDocumentSubmissions, employeeImports.
// 2. Seeds onboardingTemplates/starter.{track} when missing or older than starterTemplateVersion.
// Idempotent: writes in batches of 400, only documents missing companyId. Logs counts only.
export async function up({ firestore, log }) {
  const BATCH_SIZE = 400;

  async function backfillCollection(
    collectionName,
    transform = (data) => ({ companyId: DEFAULT_COMPANY_ID }),
  ) {
    const snapshot = await firestore.collection(collectionName).get();
    let batch = firestore.batch();
    let batchCount = 0;
    let totalUpdated = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const needsUpdate =
        data?.companyId === undefined ||
        (collectionName === 'supportRequests' && data?.assignedHrAccountId === undefined);
      if (!needsUpdate) continue;

      const updates = transform(data);
      batch.update(doc.ref, updates);
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

  // 1. Collections backfill
  const profileCounts = await backfillCollection('employeeProfiles');
  const documentCounts = await backfillCollection('companyDocuments');
  const supportCounts = await backfillCollection('supportRequests', (data) => {
    const patch = {};
    if (data?.companyId === undefined) patch.companyId = DEFAULT_COMPANY_ID;
    if (data?.assignedHrAccountId === undefined) patch.assignedHrAccountId = null;
    return patch;
  });
  const gapCounts = await backfillCollection('knowledgeGaps');
  const submissionCounts = await backfillCollection('employeeDocumentSubmissions');
  const importCounts = await backfillCollection('employeeImports');

  log(
    `company scope backfill: employeeProfiles updated ${profileCounts.updated}/${profileCounts.total}, ` +
      `companyDocuments updated ${documentCounts.updated}/${documentCounts.total}, ` +
      `supportRequests updated ${supportCounts.updated}/${supportCounts.total}, ` +
      `knowledgeGaps updated ${gapCounts.updated}/${gapCounts.total}, ` +
      `employeeDocumentSubmissions updated ${submissionCounts.updated}/${submissionCounts.total}, ` +
      `employeeImports updated ${importCounts.updated}/${importCounts.total}`,
  );

  // 2. Starter templates seed
  const templateCounts = { upgraded: 0, created: 0, kept: 0 };
  for (const track of tracks) {
    const docId = `starter.${track}`;
    const ref = firestore.collection(journeyCollections.templates).doc(docId);
    const outcome = await firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) {
        tx.set(ref, starterTemplate(track));
        return 'created';
      }
      const version = snapshot.data()?.version;
      if (Number.isInteger(version) && version >= starterTemplateVersion) return 'kept';
      tx.set(ref, starterTemplate(track));
      return 'upgraded';
    });
    templateCounts[outcome]++;
  }

  log(
    `starter templates v${starterTemplateVersion}: ${templateCounts.upgraded} upgraded, ${templateCounts.created} created, ${templateCounts.kept} already current`,
  );
}
