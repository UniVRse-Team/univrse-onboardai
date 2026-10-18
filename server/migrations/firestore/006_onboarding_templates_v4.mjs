import { journeyCollections } from '../../onboarding-collections.mjs';
import { builtInTemplate, templateVersion, tracks } from '../../onboarding-content.mjs';

// Template version 4: every track follows the revised checklist (Documentation 3,
// Policies 3, Alignment 4, Role & Tools 10, People & Support 4).
export async function up({ firestore, log }) {
  const counts = { upgraded: 0, created: 0, kept: 0 };
  for (const track of tracks) {
    const ref = firestore.collection(journeyCollections.templates).doc(track);
    const outcome = await firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) {
        tx.set(ref, builtInTemplate(track));
        return 'created';
      }
      const version = snapshot.data()?.version;
      if (Number.isInteger(version) && version >= templateVersion) return 'kept';
      tx.set(ref, builtInTemplate(track));
      return 'upgraded';
    });
    counts[outcome]++;
  }
  log(
    `onboarding templates v${templateVersion}: ${counts.upgraded} upgraded, ${counts.created} created, ${counts.kept} already current`,
  );
}
