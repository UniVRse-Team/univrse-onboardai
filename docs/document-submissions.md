# Employee document submissions

## Review locally

Run `npm run dev:preview`, then open:

- Employee: http://localhost:3000/onboarding (expand Documentation; uploads live inside each step).
- HR: http://localhost:3000/hr#submissions (Submissions in the HR navigation).

The guarded preview starts with six clearly labelled synthetic submissions. Upload a
sample PDF, DOCX, JPG or PNG (up to 25 MB); switch to HR, review it, and return to
the corresponding employee dashboard step to see the decision and remarks. Both sides share the same
in-memory records and file bytes. Document status updates automatically after an upload, when the window is focused and every 30 seconds.
Changes disappear when the preview restarts. This is not a production upload.

## Architecture and production configuration

The normal account routers enforce active sessions, password-change requirements,
same-origin requests, and employee/HR roles. Employee identity and department are
read from the authenticated account and profile, never accepted from the form.
Only that employee or HR can read a submission or download its bytes. Unknown and
other employees' IDs return the same 404 response. HR updates require the record's
revision to avoid overwriting a concurrent review.

Metadata lives in the `employeeDocumentSubmissions` Firestore collection using the
existing account Firestore client. Each file is an immutable object under
`employee-submissions/{submission UUID}` in a separate private GCS bucket.
Set `EMPLOYEE_DOCUMENTS_BUCKET` in the API service's environment, distinct from
`DOCS_BUCKET`. Configure uniform bucket-level access, public access prevention,
and object create/read/delete permissions for the API service account. Do not
share this bucket publicly or attach it to Vertex AI Search. No cloud resources,
IAM settings, or production accounts were created by this implementation.

With the variable absent, uploads are explicitly unavailable; the application
never claims a file was saved. The GCS adapter has injected-HTTP tests, but needs
a live staging check after the private bucket and service-account permissions are
configured. Downloads are authorized API responses, not public or signed URLs.
Responses use attachment disposition, no-store, nosniff and a restrictive CSP.
Images can be previewed from an authenticated response in a temporary browser
blob URL. PDF and DOCX files are downloaded instead of embedded.

Server validation checks names, sizes, allowed extensions and content signatures.
PDF and DOCX parsing runs in the existing bounded worker; scanned PDFs do not
need extracted text. DOCX archive expansion limits still apply. This validation
is not malware scanning; add scanning/quarantine before broader production use
if required by the company's document handling policy.

Deleting an employee through the existing HR API also deletes their submission
objects and metadata. A failed object deletion prevents account deletion so it
can be retried. A failed metadata write after an upload attempts object cleanup.
Operationally, failed cleanup needs storage reconciliation. No automatic retention
policy is imposed; HR must confirm retention, access and audit requirements.

## Assumptions and current limits

- One file per submission, maximum 25 MB. Categories and statuses are shared in
  `shared/document-submissions.mjs` and can be edited centrally.
- Submission time and employee identity are assigned by the server. Step IDs are validated against the employee’s actual Documentation plan.
- Rejection requires remarks. Employees resubmit as a new Pending Review record,
  linked to the rejected submission; earlier review and file remain unchanged.
- Every HR account has review permission, matching the app's current HR model.
- Pagination, search, filters and sorting are client-side over the authorized
  metadata list (10 HR rows; employee history grouped within each step). For large organizations, move
  filtering and pagination into indexed server queries before rollout.
- No email notification, OCR or e-signature.
- **Step progress follows the saved submission.** Each Documentation step is one
  required document. For the employee it is To do (action: Start) until a document
  has been saved, then Completed (the step is done). Tasks open in order, one at a time. The
  employee list never shows Pending, Submitted, Rejected or review labels. HR's review (Pending Review, Under
  Review, Approved, Rejected) is separate and never changes the employee's progress.
  Employees cannot mark a document step done or submitted by a click (409
  `DOCUMENT_REQUIRED`), HR cannot un-submit one that has a saved document (409
  `DOCUMENT_SUBMITTED`), and Alya never marks one from chat. The step is re-derived on
  every read and after every upload, so a failed write heals itself. Saved progress is never reset by a read: an HR
  verification or other earlier status with no document is left as it is. If HR rejects a document the employee's task stays complete; the employee view has no
  way to resubmit yet (HR review follow-up is out of scope).
- One document is in play per step: a new upload is accepted only when there is none
  or HR rejected the latest (it is then linked as the resubmission). Approved and
  Rejected are final decisions.
- UI success means the API saved metadata AND file bytes; review success means
  the revision-checked metadata update completed. Preview success is labelled as
  temporary. No production authentication bypass was added.

## Checks

`npm test` covers owner isolation, HR-only review, file validation, byte downloads,
required rejection remarks, stale reviews, resubmission, storage unavailability,
private GCS requests and employee deletion. `npm run build` checks the frontend.

## Files added or updated for this feature

Added:

- `shared/document-submissions.mjs` — common types, statuses and file limits.
- `server/document-submissions.mjs` — metadata, ownership, review and resubmission.
- `server/document-submission-routes.mjs` — authorized upload/list/detail/review/download APIs.
- `server/submission-files.mjs` — private GCS and explicitly injected memory storage.
- `src/documents/DashboardDocumentUpload.jsx` — inline uploads, per-step history and status refresh.
- `src/documents/dashboard-documents.css` — dashboard styling matching the existing dark panels.
- `src/documents/HrDocumentSubmissions.jsx` — HR summary, filters and management table.
- `src/documents/SubmissionParts.jsx` — shared details dialog, notices and status labels.
- `src/documents/submissions-api.mjs` — shared browser API client.
- `src/documents/documents.css` — responsive page and dialog styles.
- `scripts/seed-preview-submissions.mjs` — synthetic preview records and files.
- `tests/server/document-submissions.test.mjs` — workflow, permissions and storage checks.
- `docs/document-submissions.md` — configuration, behavior and review notes.

Updated:

- `server/api-routes.mjs` and `server/account-routes.mjs` — service wiring and account deletion cleanup.
- `server/read-uploaded-document.mjs` and `server/uploaded-document-worker.mjs` — validation-only mode, including scanned PDFs.
- `src/portal/EmployeeFootprint.jsx` — uploads in the existing Documentation steps.
- `src/access/legacy-paths.mjs` — redirect the retired `/documents` URL to `/onboarding`.
- `src/access/HrWorkspace.jsx` and `src/access/hr-navigation.mjs` — HR tab and bookmarkable hash navigation.
- `scripts/start-local-preview.mjs` — memory files, sample records and safe file-response headers.
- `tests/server/account-harness.mjs` and `tests/frontend/hr-navigation.test.mjs` — fixture injection and navigation expectation.
- `.env.example`, `Dockerfile`, and `README.md` — optional bucket setting, shared runtime files and documentation link.

Earlier local-preview and sign-in-form changes were preserved. `.env` was not changed.

No separate employee submission page or navigation item is added. Existing Ask Alya, briefing and checklist verification remain intact; submitting a document completes its Documentation step (see above). Older records without a step link remain available under Earlier submissions. The default tax/ID category is Identification Document; other Documentation steps use Employment Documents. One step may have multiple files, with the latest review shown prominently and all files retained in its history.
