// Synthetic meeting-review data, only imported by the guarded local preview.
import { pdf } from '../tests/server/document-fixtures.mjs';
import { syntheticProfile } from '../tests/server/account-harness.mjs';

export async function seedPreviewSubmissions(fixture, hr, employee) {
  const other = await fixture.readyEmployee(hr, {
    profile: syntheticProfile('Nadia Rahman', 'People & Culture'),
  });
  const third = await fixture.readyEmployee(hr, {
    profile: syntheticProfile('Daniel Tan', 'Customer Success'),
  });
  // The preview employee starts fresh at 0%: nothing is seeded for them. Only
  // other sample employees have documents, so HR still has submissions to review.
  const rows = [
    [
      other.browser,
      'Professional qualification',
      'Certificates and Qualifications',
      'Under Review',
      'Checking the qualification details.',
    ],
    [third.browser, 'Leave supporting letter', 'Leave Supporting Documents', 'Pending Review', ''],
    [
      other.browser,
      'Medical leave certificate',
      'Medical Certificate',
      'Approved',
      'Document received and reviewed.',
    ],
  ];
  for (const [browser, title, type, status, remarks] of rows) {
    const stepId = null;
    const query = new URLSearchParams({ title, type, ...(stepId ? { stepId } : {}) });
    const name = title.toLowerCase().replaceAll(' ', '-') + '.pdf';
    const result = await browser.upload(
      `/api/me/document-submissions?${query}`,
      pdf('SAMPLE ONLY - ' + title + ' - Not an actual employee document.'),
      name,
    );
    if (result.status !== 201) throw new Error('Preview submission seed failed: ' + result.text);
    if (status !== 'Pending Review') {
      const reviewed = await hr.patch('/api/hr/document-submissions/' + result.body.submission.id, {
        status,
        remarks,
        revision: 1,
      });
      if (reviewed.status !== 200) throw new Error('Preview review seed failed.');
    }
  }
}
