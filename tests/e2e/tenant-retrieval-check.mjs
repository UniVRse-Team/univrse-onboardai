// Standalone staging check (NOT a node:test file; run by hand, never by npm test).
// Usage: node tests/e2e/tenant-retrieval-check.mjs <repoPath> <scratchDir> [--answer]
//   env ONLY=<companyId> limits to one company.
// CALLS STAGING (Firestore onboardai-staging, Vertex AI Search, GCS bucket) and
// Gemini via ADC. READ-ONLY for cloud resources: chat memory is a local SQLite
// file in <scratchDir>. Nothing is uploaded, deleted or imported.
// Per-company retrieval and cross-company leak check against STAGING, using
// the app's real code: Vertex AI Search with the companyId filter (layer 1),
// then the active-document allowlist with its company check (layer 2).
// With --answer it also asks Alya (real Gemini pipeline) a few questions per
// company. Read-only for staging: chat memory goes to a local SQLite file.
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const [repo, scratch, ...flags] = process.argv.slice(2);
const imp = (p) => import(path.join(repo, p));
const { createFirestoreClient } = await imp('server/firestore-client.mjs');
const { createCompanyDocumentStore } = await imp('server/company-documents.mjs');
const { createActiveDocuments } = await imp('server/active-company-documents.mjs');
const { createCompanyRetriever } = await imp('server/company-document-retriever.mjs');
const { createCompanyKnowledge } = await imp('server/company-knowledge.mjs');

const PROJECT = 'project-65a9b676-abdb-4393-bc1';
const env = {
  NODE_ENV: 'production',
  AI_MODE: 'gemini-chat',
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  GOOGLE_CLOUD_PROJECT: PROJECT,
  GOOGLE_CLOUD_LOCATION: 'global',
  VERTEX_SEARCH_LOCATION: 'global',
  VERTEX_SEARCH_ENGINE_ID: 'onboardai-search-staging',
  DOCS_BUCKET: `${PROJECT}-onboardai-docs-staging`,
  ONBOARDAI_ENVIRONMENT: 'staging',
};
const library = createCompanyDocumentStore({
  firestore: createFirestoreClient({ projectId: PROJECT, databaseId: 'onboardai-staging' }),
  env,
});
const active = createActiveDocuments({
  documents: library,
  bucket: env.DOCS_BUCKET,
  environment: 'staging',
});
const vertexOnly = createCompanyRetriever({ env });
const knowledge = createCompanyKnowledge({
  documents: library,
  companyRetrieve: vertexOnly,
  active,
});

const owners = new Map((await library.listSummaries()).map((d) => [d.id, d.companyId]));
const prefix = `gs://${env.DOCS_BUCKET}/`;
const companyOfUri = (uri) => {
  const name = decodeURIComponent(String(uri || '').replace(prefix, ''));
  const parts = name.split('/');
  return parts[0] === 'companies' ? parts[1] : parts.length === 2 ? 'luna-digital' : `?${name}`;
};

// [question, fact the answer needs (regex) or null]
const ONLY = process.env.ONLY;
const own0 = {
  'luna-digital': [
    ['What are the working hours from Monday to Thursday?', /12[:.]30|5[:.]30/],
    ['What should I wear to the office on weekdays?', /smart.?casual|ripped jeans/i],
    ['When is the regular internal meeting?', /9[:.]30/],
    ['When was the company established?', /2015/],
    ['What is the name of our company?', /Luna Digital/],
    ['Can I bring my pet dog to the office?', null],
    ['Does the company pay for a gym membership?', null],
  ],
  'seri-bayu-digital': [
    ['What are the working hours from Monday to Thursday?', /12[:.]30|5[:.]30/],
    ['What should I wear to the office on weekdays?', /smart.?casual|ripped jeans/i],
    ['When is the regular internal meeting?', /9[:.]30/],
    ['When was the company established?', /20\d\d/],
    ['What is the name of our company?', /Seri Bayu/],
    ['Can I bring my pet dog to the office?', null],
    ['Does the company pay for a gym membership?', null],
  ],
  rimba: [
    ['What are the working hours?', /09:00.18:00|18:00/],
    ['Who is my onboarding buddy on the first day?', /Farah/],
    ['How far ahead should I submit a leave request?', /five working days/i],
    ['Which days are shared studio days?', /Monday and Wednesday/i],
    ['Can I bring my pet dog to the office?', null],
    ['Does the company pay for a gym membership?', null],
  ],
  avocako: [
    ['What are the working hours?', null],
    ['What is the leave policy?', null],
    ['Can I bring my pet dog to the office?', null],
    ['Does the company pay for a gym membership?', null],
  ],
};
const own = ONLY ? { [ONLY]: own0[ONLY] } : own0;
// Phrases unique to one company, asked as every other company.
const probes = [
  ['Rimba Learning Studio onboarding buddy Farah Welcome Desk', 'rimba'],
  ['Seri Bayu Digital company overview', 'seri-bayu-digital'],
  ['Luna Digital company overview', 'luna-digital'],
];
const names = /luna digital|seri bayu|rimba|lumora|univrse|avocako/gi;

let leaks = 0;
const report = [];
for (const [company, questions] of Object.entries(own)) {
  const asked = [
    ...questions.map(([q, fact]) => ({ q, fact, kind: 'own' })),
    ...probes
      .filter(([, from]) => from !== company)
      .map(([q, from]) => ({ q, fact: null, kind: `probe:${from}` })),
  ];
  for (const { q, fact, kind } of asked) {
    const raw = await vertexOnly(q, { companyId: company, pageSize: 10 });
    const rawCompanies = raw.map((p) => companyOfUri(p.uri));
    const final = await knowledge.retrieve(q, { companyId: company });
    const finalCompanies = final.map((p) => owners.get(p.documentId) || `?${p.title}`);
    const foreignRaw = rawCompanies.filter((c) => c !== company);
    const foreignFinal = finalCompanies.filter((c) => c !== company);
    const text = final.map((p) => p.text).join('\n');
    const foreignNames = [...new Set((text.match(names) || []).map((n) => n.toLowerCase()))].filter(
      (n) => !company.startsWith(n.split(' ')[0]),
    );
    leaks += foreignRaw.length + foreignFinal.length;
    report.push({
      company,
      kind,
      q,
      vertex: `${raw.length} (${foreignRaw.length ? 'FOREIGN ' + foreignRaw.join(',') : 'all own'})`,
      final: `${final.length} (${foreignFinal.length ? 'FOREIGN ' + foreignFinal.join(',') : 'all own'})`,
      titles: [...new Set(final.map((p) => p.title))].join(' | ') || '-',
      fact: fact ? (fact.test(text) ? 'yes' : 'NO') : '-',
      otherNamesInText: foreignNames.join(',') || 'none',
    });
  }
}
for (const r of report) {
  console.log(`\n[${r.company}] ${r.kind}: ${r.q}`);
  console.log(
    `   vertex layer: ${r.vertex}   after allowlist: ${r.final}   fact found: ${r.fact}   other company names in text: ${r.otherNamesInText}`,
  );
  console.log(`   sources: ${r.titles}`);
}
console.log(`\nTOTAL foreign passages: ${leaks}`);

if (flags.includes('--answer')) {
  const { createConversationService } = await imp('server/gemini-chat-workflow.mjs');
  const displayName = {
    'luna-digital': 'Luna Digital',
    'seri-bayu-digital': 'Seri Bayu Digital',
    rimba: 'RIMBA',
    avocako: 'Avocako',
  };
  for (const [company, questions] of Object.entries(own)) {
    // One service per company; its retrieve is pinned to that company, the way
    // the API pins it to the signed-in account's company.
    const chat = createConversationService({
      env: { ...env, CHAT_DATABASE_PATH: path.join(scratch, `tenant-check-${company}.sqlite`) },
      retrieve: async (query, options) => {
        const found = await knowledge.retrieve(query, {
          signal: options?.signal,
          companyId: company,
        });
        console.log(
          `   alya search: "${query}" -> ${found.map((p) => `${p.title.slice(0, 2)}·${p.heading || '-'}`).join(' | ') || 'NONE'}`,
        );
        return found;
      },
    });
    for (const [q, fact] of questions) {
      const owner = `account:qa-check-${randomUUID()}`;
      const created = await chat.memory.create(owner);
      const result = await chat.ask(owner, created.id, q, randomUUID(), undefined, null, null, {
        companyId: company,
        companyName: displayName[company],
      });
      const answer = String(result.answer || result.text || '').replace(/\s+/g, ' ');
      console.log(
        `\nALYA [${company}] ${q}\n   ${answer.slice(0, 400)}\n   fact: ${fact ? (fact.test(answer) ? 'yes' : 'NO') : '-'}  other names: ${[...new Set((answer.match(names) || []).map((n) => n.toLowerCase()))].join(',') || 'none'}`,
      );
    }
    await chat.close?.();
  }
}
process.exit(0);
