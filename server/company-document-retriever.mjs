import { DEFAULT_COMPANY_ID } from './companies.mjs';
import { profileCandidates, selectProfilePassages } from './company-profile.mjs';
import { tasks } from './sample-onboarding-content.mjs';
import {
  createVertexSearch,
  searchConfigProblem,
  vertexSearchConfig,
} from './vertex-ai-search.mjs';

// Where company passages come from. VERTEX_SEARCH_ENGINE_ID switches on Vertex AI
// Search; without it the server uses the built-in, unapproved sample guide so
// local development keeps working with no Google Cloud data store.
export function knowledgeMode(env) {
  return vertexSearchConfig(env) ? 'vertex-ai-search' : 'sample-tasks';
}

// The answer modes that search company documents.
const searchingModes = ['gemini-chat', 'document-search'];

export class KnowledgeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KnowledgeConfigError';
  }
}

// Throws KnowledgeConfigError when a searching mode would use Vertex AI Search
// without DOCS_BUCKET. Chat admits only passages of active company documents
// (active-company-documents.mjs), which it recognises by their gs:// URI in
// that bucket; without it every passage would be withheld. The api and the
// local server refuse to start instead (createApp itself withholds them all).
export function checkKnowledgeConfig(env = {}) {
  if (!searchingModes.includes(env.AI_MODE) || !vertexSearchConfig(env)) return;
  if (String(env.DOCS_BUCKET || '').trim()) return;
  throw new KnowledgeConfigError(
    'VERTEX_SEARCH_ENGINE_ID is set without DOCS_BUCKET. Chat uses only passages of active company documents and needs the documents bucket name to recognise them. Set DOCS_BUCKET, or leave VERTEX_SEARCH_ENGINE_ID blank to use the sample guide.',
  );
}

export function describeKnowledgeSource(env) {
  const config = vertexSearchConfig(env);
  if (!config) return 'the sample onboarding guide (VERTEX_SEARCH_ENGINE_ID is not set)';
  const problem = searchConfigProblem(config);
  return `Vertex AI Search engine ${config.engine} (${config.location})${problem ? `, incomplete: ${problem}; company questions will fail` : ''}`;
}

export const sampleSourceTitle = 'Sample onboarding guide (confirm with HR)';

const stopWords = new Set(
  'a an and are as at be can could do does for from have how i if in is it me my of on or our please should tell that the their there this to us was we what when where which who why will with would you your company univrse'.split(
    ' ',
  ),
);
const termsOf = (value) =>
  new Set(
    (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
      (word) => word.length > 2 && !stopWords.has(word),
    ),
  );

// Sample tasks that share a meaningful word with the query. The text says it is
// unapproved so Gemini (and the search preview) present it as sample guidance.
export function samplePassages(query) {
  const wanted = termsOf(typeof query === 'string' ? query : '');
  return tasks
    .map((task) => {
      const guidance = [
        task.summary,
        'Steps:',
        ...task.steps.map((step, i) => `${i + 1}. ${step}`),
        task.verification,
      ].join('\n');
      return {
        matches: [...termsOf(task.title + ' ' + guidance)].some((term) => wanted.has(term)),
        passage: {
          title: sampleSourceTitle,
          heading: task.title,
          text: 'Unapproved sample guidance: confirm with HR before relying on it.\n' + guidance,
        },
      };
    })
    .filter((item) => item.matches)
    .map((item) => item.passage);
}

// retrieve(query, { signal, companyId, pageSize }) -> [{ title, heading, text, excerpt?,
// uri?, vertexId? }] in rank order.
export function createCompanyRetriever({
  env = {},
  fetchImpl,
  getAccessToken,
  log,
  getCompanyProfile = null,
} = {}) {
  const config = vertexSearchConfig(env);
  const search = config ? createVertexSearch({ config, fetchImpl, getAccessToken, log }) : null;
  const profileCache = new Map();

  function clearProfileCache(companyId) {
    if (companyId) profileCache.delete(companyId);
    else profileCache.clear();
  }

  async function getProfileCandidates(companyId) {
    if (!companyId || !getCompanyProfile) return [];
    const now = Date.now();
    const cached = profileCache.get(companyId);
    if (cached && cached.expiresAt > now) return cached.candidates;
    try {
      const envelope = await getCompanyProfile(companyId);
      if (!envelope || envelope.version === 0) {
        profileCache.set(companyId, { expiresAt: now + 60000, version: 0, candidates: [] });
        return [];
      }
      const candidates = profileCandidates(envelope.profile);
      profileCache.set(companyId, {
        expiresAt: now + 60000,
        version: envelope.version,
        candidates,
      });
      return candidates;
    } catch {
      return [];
    }
  }

  const retriever = async (query, options = {}) => {
    const companyId = options.companyId || DEFAULT_COMPANY_ID;
    const candidates = await getProfileCandidates(companyId);
    const profilePassages =
      candidates.length > 0 ? selectProfilePassages(candidates, query, { extra: 2 }) : [];

    let docPassages = [];
    if (search) {
      docPassages = await search(query, {
        signal: options?.signal,
        companyId,
        ...(options?.pageSize ? { pageSize: options.pageSize } : {}),
      });
    } else if (companyId === DEFAULT_COMPANY_ID) {
      docPassages = samplePassages(query);
    }
    return [...profilePassages.slice(0, 3), ...docPassages.slice(0, options?.pageSize || 5)];
  };

  retriever.clearProfileCache = clearProfileCache;
  return retriever;
}
