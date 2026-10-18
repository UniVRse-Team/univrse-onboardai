import { DEFAULT_COMPANY_ID } from './companies.mjs';
import { createStorageCall } from './firestore-client.mjs';
import { journeyCollections } from './onboarding-collections.mjs';
import { companyDay } from './onboarding-progress.mjs';
import { redactPersonalData } from './pii-redaction.mjs';
import { tracks } from './onboarding-content.mjs';
import { profileStorageErrors } from './employee-profiles.mjs';

// Knowledge gaps (issue #49): onboarding questions the company documents could
// not answer, kept anonymously for HR to improve the documents. A gap holds
// the redacted question, a short topic, the asker's track, the nearest
// retrieved source and the calendar day only: never an account id, a
// conversation id or a time of day. Documents get random ids.
export const gapLimits = Object.freeze({ question: 500, topic: 60, examples: 3, sources: 3 });
const readCap = 5000;

// The topic used for grouping: lower case, redacted, one line.
export function normaliseTopic(topic) {
  const clean = redactPersonalData(typeof topic === 'string' ? topic : '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, gapLimits.topic);
  return clean || 'other';
}

// The gap document for one unanswered question.
export function gapDocument({ question, topic, track, nearestSource, companyId }, at) {
  return {
    questionRedacted: redactPersonalData(String(question || ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, gapLimits.question),
    topic: normaliseTopic(topic),
    track: tracks.includes(track) ? track : 'employee',
    nearestSource:
      nearestSource && typeof nearestSource.title === 'string' && nearestSource.title
        ? { title: nearestSource.title, heading: String(nearestSource.heading || '') }
        : null,
    companyId: companyId || DEFAULT_COMPANY_ID,
    createdDay: companyDay(at),
  };
}

// GET /api/hr/knowledge-gaps: grouped by topic, highest count first, then the
// most recent day, then the topic.
export function groupGaps(docs) {
  const groups = new Map();
  for (const gap of docs) {
    if (!gap || typeof gap.questionRedacted !== 'string') continue;
    const topic = normaliseTopic(gap.topic);
    const group = groups.get(topic) || {
      topic,
      count: 0,
      lastSeenDay: null,
      entries: [],
      tracks: Object.fromEntries(tracks.map((t) => [t, 0])),
      nearestSources: [],
    };
    group.count++;
    const day = typeof gap.createdDay === 'string' ? gap.createdDay : null;
    if (day && (!group.lastSeenDay || day > group.lastSeenDay)) group.lastSeenDay = day;
    group.entries.push({ day: day || '', question: gap.questionRedacted });
    if (tracks.includes(gap.track)) group.tracks[gap.track]++;
    const source = gap.nearestSource;
    if (
      source?.title &&
      !group.nearestSources.some((s) => s.title === source.title && s.heading === source.heading)
    )
      group.nearestSources.push({ title: source.title, heading: source.heading || '' });
    groups.set(topic, group);
  }
  return [...groups.values()]
    .map(({ entries, nearestSources, ...group }) => ({
      ...group,
      examples: [
        ...new Set(
          entries
            .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
            .map((entry) => entry.question)
            .filter(Boolean),
        ),
      ].slice(0, gapLimits.examples),
      nearestSources: nearestSources.slice(0, gapLimits.sources),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.lastSeenDay < b.lastSeenDay ? 1 : a.lastSeenDay > b.lastSeenDay ? -1 : 0) ||
        (a.topic < b.topic ? -1 : 1),
    )
    .map(({ topic, count, lastSeenDay, examples, tracks: byTrack, nearestSources }) => ({
      topic,
      count,
      lastSeenDay,
      examples,
      tracks: byTrack,
      nearestSources,
    }));
}

export function createKnowledgeGaps({ firestore, now = () => new Date(), timeoutMs, log }) {
  let client = null;
  const database = async () =>
    (client ??= await (typeof firestore === 'function' ? firestore() : firestore));
  const call = createStorageCall({ timeoutMs, log });
  const guarded = async (operation, fn) => {
    try {
      return await call(operation, fn);
    } catch (error) {
      throw error?.code === 'STORAGE_TIMEOUT'
        ? profileStorageErrors.timeout()
        : profileStorageErrors.unavailable();
    }
  };
  return {
    // Records one gap. The caller decides whether the turn is a gap.
    record: (gap) =>
      guarded('save knowledge gap', async () => {
        const db = await database();
        await db.collection(journeyCollections.knowledgeGaps).doc().set(gapDocument(gap, now()));
      }),
    list: (companyId = null) =>
      guarded('read knowledge gaps', async () => {
        const db = await database();
        let query = db.collection(journeyCollections.knowledgeGaps);
        if (companyId) query = query.where('companyId', '==', companyId);
        const found = await query.limit(readCap).get();
        const docs = found.docs.map((doc) => doc.data());
        return { total: docs.length, groups: groupGaps(docs) };
      }),
  };
}
