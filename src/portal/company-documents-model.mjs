// Pure helpers for the company documents an employee can open in My Onboarding
// (GET /api/me/company-documents). The server already sorts by area order then
// title and never sends text; this only groups and picks.

const AREAS = ['documentation', 'policies', 'alignment', 'role-tools', 'team-support'];

const list = (documents) =>
  Array.isArray(documents) ? documents.filter((d) => d && d.viewUrl) : [];

// Documents filed under one onboarding area, in the order received.
export const documentsForArea = (documents, areaId) =>
  list(documents).filter((d) => d.category === areaId);

// Documents in the "additional" category, or any category this page has no area for.
export const otherDocuments = (documents) =>
  list(documents).filter((d) => !AREAS.includes(d.category));

// The company's own handbook: a policies document titled "handbook", else any policies document.
export const uploadedHandbook = (documents) => {
  const policies = documentsForArea(documents, 'policies');
  return policies.find((d) => /handbook/i.test(d.title || '')) || policies[0] || null;
};

// What the handbook / policy button offers: the company upload first, then the
// built-in document link, otherwise nothing (the "not added yet" note).
export const policyButtonTarget = ({ stepId, document, documents }) => {
  if (stepId === 'policies.employee-handbook') {
    const uploaded = uploadedHandbook(documents);
    if (uploaded)
      return { kind: 'uploaded', url: uploaded.viewUrl, label: 'View ' + uploaded.title };
  }
  if (document) return { kind: 'built-in', document };
  return null;
};

// A Word file is downloaded by the browser rather than opened.
export const hasWordFile = (documents) =>
  list(documents).some((d) => /\.docx?$/i.test(d.fileName || ''));
