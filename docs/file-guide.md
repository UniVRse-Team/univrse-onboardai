# Developer file guide

The project stays in JavaScript and React. `.jsx` files contain React screens; `.js` and `.mjs` contain JavaScript; `.css` files control appearance. `.mjs` makes the server's module format explicit.

## Main folders

| Folder                 | What it contains                                                              |
| ---------------------- | ----------------------------------------------------------------------------- |
| `src/portal/`          | The website shell and the welcome, onboarding and support pages               |
| `src/avatar/`          | Alya's chat screen, avatar rendering, answer visuals and support summary      |
| `src/access/`          | Employee/HR sign-in and the HR workspace                                      |
| `server/`              | API routes, accounts, Gemini workflow, document search, saved chats and voice |
| `scripts/`             | Development, connection checks, avatar import and voice setup                 |
| `tests/`               | Regression checks using temporary data and synthetic company documents        |
| `public/avatars/alya/` | The original avatar, loading poster and asset information                     |
| `docs/`                | Architecture and behaviour explanations                                       |

`node_modules`, `dist`, `.cache` and `artifacts` are generated or private working folders. They are excluded from sharing. `.env` holds this installation's private settings; `.env.example` is the blank setup template.

## Start reading here

1. `src/main.jsx` starts React and redirects old page addresses.
2. `src/portal/OnboardingWebsite.jsx` selects a page and renders the website shell.
3. `src/avatar/AlyaChatPage.jsx` submits questions and displays chat, the avatar, visual answers and support controls.
4. `server/index.mjs` starts the HTTP server and serves the website and compressed avatar.
5. `server/api-routes.mjs` handles browser requests and calls the appropriate chat or voice service.

## Website

`src/styles/theme.css` defines the shared navy (`#0A2D43`), gold (`#F6C44B`) and
ivory palette. `src/brand/OnboardAiBrand.jsx` draws the shared sailboat mark and
OnboardAi wordmark. Existing browser storage keys keep their original names so
saved preferences survive the branding change.

| File                               | Purpose                                                |
| ---------------------------------- | ------------------------------------------------------ |
| `src/portal/OnboardingWebsite.jsx` | Page layouts, navigation, checklist and personal notes |
| `src/portal/website-content.js`    | Navigation labels, suggested tasks and support roles   |
| `src/portal/website.css`           | Website colours, spacing and responsive layouts        |
| `src/portal/Icon.jsx`              | Shared labelled interface icons                        |

## Chat and company knowledge

| File                                    | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `server/api-routes.mjs`                 | Chat, saved-chat, settings and voice endpoints (signed-in only) |
| `server/gemini-chat-workflow.mjs`       | LangGraph conversation steps and Gemini prompts/answers         |
| `server/vertex-ai-search.mjs`           | Vertex AI Search chunk search, passages, file names and errors  |
| `server/company-document-retriever.mjs` | Chooses Vertex AI Search or the sample guide for passages       |
| `server/active-company-documents.mjs`   | Retrieval allowlist: only active company documents, with dates  |
| `server/answer-freshness.mjs`           | Dates rules in the prompt and the fixed stale-document reply    |
| `server/document-search.mjs`            | Search-only preview that quotes passages without Gemini         |
| `server/chat-store.mjs`                 | Chooses Firestore or SQLite for saved chats                     |
| `server/firestore-chat-memory.mjs`      | Firestore saved chats, support data, turn leases and expiry     |
| `server/firestore-checkpointer.mjs`     | LangGraph checkpoints in Firestore                              |
| `server/checkpoint-writes.mjs`          | A failed background checkpoint save fails its turn, not the app |
| `server/firestore-client.mjs`           | Firestore client, time limit and safe storage errors            |
| `server/chat-errors.mjs`                | Chat and storage error messages shared by both stores           |
| `server/saved-conversations.mjs`        | SQLite history, ownership checks, expiry and deletion (local)   |
| `server/answer-style-preferences.mjs`   | Explanation preference and explicit support requests            |
| `server/sample-onboarding-content.mjs`  | Sample/demo answers, separate from real company documents       |
| `src/avatar/AnswerStyleSettings.jsx`    | The five explanation choices and their visible reason           |

For Gemini chat, the main path is:

```text
Question + saved context
    -> interpret the question
    -> search approved company documents (Vertex AI Search)
    -> write an answer with references
    -> save the conversation
    -> display text, visual explanation and voice
```

LangChain connects the model. Vertex AI Search returns the company passages. LangGraph runs and checkpoints the conversation steps. Neither library diagnoses employees or replaces the language model.

Alya's stage shows the answer beside her as a visual guide (see [Alya's presentation stage](#alyas-presentation-stage-issue-61)). Its captions use `src/avatar/use-visual-text-pages.js` to measure the space available and `src/avatar/visual-text-pagination.mjs` to page the text without dropping words.

## Avatar and voice

| File                                         | Purpose                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/avatar/AvatarDisplay.jsx`               | Avatar loading, presence and poster fallback                                                         |
| `src/avatar/avatar-renderer.js`              | Three.js camera, light, model, face and gentle movement                                              |
| `src/avatar/answer-audio-player.js`          | Fetch server audio, play it and cancel safely                                                        |
| `src/avatar/speech-text-and-mouth-timing.js` | Prepare spoken text and estimate English mouth timing                                                |
| `src/avatar/alya-chat.css`                   | Chat/avatar layout and chat controls                                                                 |
| `src/avatar/alya-workspace.css`              | Window-sized layout: Alya's stage beside (or above) the chat                                         |
| `src/avatar/digital-human.js`                | Material tuning for the supplied ALYA digital-human model (no vertex sculpt of its face or morphs)   |
| `src/avatar/avatar-poster.mjs`               | The still poster shown while the model loads, cache-busted by the model's SHA-256 in `manifest.json` |
| `server/kokoro-voice.mjs`                    | Fixed Kokoro Heart voice, startup warmup, synthesis queue and WAV output                             |
| `scripts/download-voice-model.mjs`           | Cache the voice model and create a sample                                                            |
| `scripts/import-avatar-model.mjs`            | Import and compress a revised original GLB                                                           |

The avatar is the supplied ALYA model of PR #59 (issue #61): `public/avatars/alya/alya.glb.gz`, a 27.7 MiB GLB sent as about 21 MiB of gzip by `server/avatar-route.mjs`, with 66 facial controls listed in `manifest.json`.

The browser plays WAV audio from `/api/voice`, starting with a short opening while the next segment is prepared. The installed model warms at server startup. Mouth movement follows the audio clock using estimated phonemes. The unused browser-voice controller was removed; text and mouth-timing helpers remain because the current player uses them.

`server/optional-windows-voice.mjs`, `server/windows-audio-mouth-timing.mjs`, `scripts/start-windows-voice-helper.ps1` and `scripts/WindowsVoiceHelper.cs` support the existing optional Windows TTS route. They are retained because the server still calls them. The current website's shared voice uses Kokoro.

## Alya's presentation stage (issue #61)

Ported from PR #59. While Alya speaks, her stage shows a short answer and a sequence of scenes that follow the audio clock (`answer-audio-player.js` reports the spoken position with `getProgress`); with voice off, unavailable or finished, the employee steps through the same scenes. Everything here is worked out **in the browser** from the delivered answer text and its sources: there is no extra model call. #59's server-side answering "brain" was deliberately not adopted; answers still come from the server's existing chat workflow.

| File                                      | Purpose                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/avatar/AlyaPresentationStage.jsx`    | Alya's stage: the avatar in her office, the selected answer's presentation and the replay control                         |
| `src/avatar/AutomaticPresentation.jsx`    | Plays the answer's scenes in step with the voice, or lets the reader step through them                                    |
| `src/avatar/AutomaticCaption.jsx`         | The caption page under Alya's voice, or the page the reader chose                                                         |
| `src/avatar/ClothingPresentation.jsx`     | One dress-code scene (what to wear or avoid) with its caption                                                             |
| `src/avatar/ClothingIllustration.jsx`     | SVG garments for the dress-code scenes                                                                                    |
| `src/avatar/OnboardingIllustration.jsx`   | SVG subject illustrations (hours, leave, tasks, arrival, security, payroll, approval, company); never a task's completion |
| `src/avatar/answer-presentation.mjs`      | Builds the scenes from the answer (sentences, times; clothing answers via clothing-presentation)                          |
| `src/avatar/chat-answer-presentation.mjs` | The short spoken reply of a chat answer and the answer as the chat presents it                                            |
| `src/avatar/short-answer.mjs`             | The short answer, built from the delivered answer's own sentences                                                         |
| `src/avatar/clothing-presentation.mjs`    | Dress-code scenes that keep contrasting permissions apart without rewriting the source                                    |
| `src/avatar/presentation-cues.mjs`        | A source-character map through the voice's text cleanup, so scenes follow the real audio                                  |
| `src/avatar/scene-steps.mjs`              | Which scene and caption page to show: under the voice, or the reader's own step                                           |
| `src/avatar/alya-presentation.css`        | Stage layout                                                                                                              |
| `src/avatar/automatic-presentation.css`   | Scene and caption styling                                                                                                 |
| `src/avatar/clothing-presentation.css`    | Dress-code scene styling                                                                                                  |

## Answer support and HR summary

The separate visual panel (`VisualAnswerPanel.jsx`, `IllustratedAnswer.jsx`, `visual-answer.css`) was removed in #61; Alya's presentation stage above replaces it.

| File                                     | Purpose                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/avatar/AnswerIllustrations.jsx`     | Original SVG subject illustrations, used by the stage's onboarding scenes                          |
| `src/avatar/visual-answer-content.mjs`   | Topic titles, point labels and conservative plain wording from the delivered answer, for the stage |
| `src/access/HrWorkspace.jsx`             | The signed-in HR workspace (employees, onboarding, support requests, insights, documents)          |
| `src/access/CompanyKnowledgeLibrary.jsx` | Company uploads, file removal and company-source status                                            |
| `src/access/HrInsights.jsx`              | Team insights and knowledge gaps (aggregates only)                                                 |
| `src/avatar/hr-support-report.mjs`       | The concise report text exported for HR                                                            |
| `src/avatar/answer-support-controls.css` | Feedback, explanation and source controls                                                          |
| `server/employee-support-tracking.mjs`   | Recorded support requests, feedback and summary templates                                          |
| `server/answer-guide-metadata.mjs`       | Source-supported guide metadata for existing saved-chat records                                    |

The persisted/API field named `card` remains compatible with existing chats and guide counts. It is metadata; the interface shows answers on Alya's presentation stage. UI component renames do not rename database fields, cookies or local preference keys.

## Useful script names

- `start-development-server.mjs`: start Node with file watching and Vite live updates.
- `check-gemini-connection.mjs`: check Gemini with one small live request.
- `check-gemini-voice.mjs`: check that Alya's Gemini voice speaks the sentence and nothing else (`npm run check:voice`; `--base-url` and `--cookie-file` for a running server).
- `check-vertex-ai-search.mjs`: check Vertex AI Search with one live search (`npm run check:search`).
- `import-company-documents.mjs`: operator-only: upload a folder into one named bucket folder (`--prefix`, never the root or a document-ID folder) and import it into Vertex AI Search (`npm run docs:import`, dry run by default, INCREMENTAL only).
- `reconcile-company-documents.mjs`: compare Firestore `companyDocuments`, the bucket and the data store and print the drift as JSON lines (`npm run docs:reconcile`, read-only report by default; `--apply` repairs it). See [Document reconciliation](document-reconciliation.md).
- `check-shareable-files.mjs`: inspect the Git file list without printing secrets or publishing files.
- `migrate-database.mjs`: apply the SQL and Firestore migrations (`npm run db:migrate`).
- `check-migration-files.mjs`: list the migration files and fail on a misnamed or duplicate one (`npm run db:migrations:check`).
- `create-hr-account.mjs`: create an HR account (`npm run hr:create`).
- `reset-hr-password.mjs`: recover an HR account (`npm run hr:reset-password`).
- `local-stack.mjs`: start, reset, stop and log the local Docker stack (`npm run local`, `local:reset-hr`, `local:down`, `local:logs`).

Use the `npm` commands in the README rather than remembering these file paths.

## What was cleaned up

Ambiguous names such as `Portal`, `AvatarStage`, `conversation` and `drive-knowledge` were replaced with names that describe their role. The architecture notes are grouped in `docs/`. Compressed source formatting is expanded consistently with Prettier. Tests and imports follow the new names.

The existing removed pages and old standalone avatar demos stay removed. The unused device-voice controller and its obsolete tests were replaced with checks for the active audio player. The original avatar, live settings, saved conversations and voice cache are preserved.

## Cloud Run services

In the cloud the website runs as three services (web, api, tts); see [Cloud Run services](cloud-run-services.md).

| File                         | Purpose                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `server/web-service.mjs`     | Starts the web service                                                           |
| `server/web-app.mjs`         | Serves `dist/` and the avatar, and mounts the `/api` proxy                       |
| `server/api-proxy.mjs`       | Forwards `/api/*` to the api service and streams the answer back                 |
| `server/api-service.mjs`     | Starts the api service (the routes in `server/api-routes.mjs`)                   |
| `server/tts-service.mjs`     | Starts the tts service (`server/tts-app.mjs`, Kokoro)                            |
| `server/remote-voice.mjs`    | The api's client for the tts service                                             |
| `server/service-auth.mjs`    | `SERVICE_AUTH` and the Google ID tokens the private api and tts services require |
| `server/service-runtime.mjs` | `.env` loading, `TRUST_PROXY` and clean shutdown shared by the three entry files |

## Accounts

HR and employee sign-in, on when `DATABASE_URL` is set. PostgreSQL holds accounts, sessions and the audit trail; Firestore holds employee profiles, account-owned chats and the company knowledge library. See [Account access](account-access.md) for the setup, rules and API contract.

| File                                    | Purpose                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `server/account-settings.mjs`           | When accounts are on, and the start-up guard (Firestore emulator off Cloud Run)                                                      |
| `server/account-service.mjs`            | Sign-in, sessions, lockout, password changes and HR actions; `createEmployeeAccount`, the one way employees are created              |
| `server/account-store.mjs`              | PostgreSQL pool, queries and transactions (Employee ID allocation too); code-only error logs                                         |
| `server/account-routes.mjs`             | `/api/auth`, `/api/me` and `/api/hr` routes and the `onboardai_account` cookie                                                       |
| `server/account-errors.mjs`             | Account error codes and messages                                                                                                     |
| `server/password-hashing.mjs`           | scrypt password hashes, password rules and generated passwords (temporary and local HR)                                              |
| `server/departments.mjs`                | The six first departments and prefixes, seed data only (migration 004 holds the live list in `departments`); import-free             |
| `server/employee-ids.mjs`               | The prefix rule (2–4 letters, `HR` reserved) and the `PE-0001` Employee ID format                                                    |
| `server/employee-profiles.mjs`          | Profile validation and `employeeProfiles/{accountId}` in Firestore; removes an account's profile and `employeeImports` drafts        |
| `server/company-knowledge.mjs`          | HR company knowledge uploads, replacements and the `onChange` hook; account chats retrieve from Vertex AI Search via the allowlist   |
| `server/company-documents.mjs`          | Firestore `companyDocuments` (metadata, `listSummaries`), library and replace rules, GCS + Vertex AI Search sync and its log lines   |
| `server/discovery-engine-documents.mjs` | Shared, pure: object names, `gs://` URIs, Vertex document IDs, Discovery Engine and GCS URLs, the paginated documents list           |
| `server/onboarding-document-topics.mjs` | The five onboarding areas of the company library                                                                                     |
| `server/profile-autofill.mjs`           | Profile autofill: reads profile fields from an uploaded document with Gemini; saves nothing                                          |
| `server/database-migrations.mjs`        | Runs `server/migrations/*.sql` once each, recorded in `schema_migrations`                                                            |
| `server/migrations/`                    | Plain SQL migrations                                                                                                                 |
| `server/migrations/firestore/`          | Firestore migrations (`NNN_name.mjs`, `up({ firestore, log })`) and their README                                                     |
| `server/firestore-migrations.mjs`       | Runs the Firestore migrations once each, markers in the `schema_migrations` collection, lease lock per file                          |
| `server/migration-runner.mjs`           | `db:migrate` target selection (`MIGRATION_TARGETS`), output and exit codes; the migration file check                                 |
| `scripts/migrate-database.mjs`          | `npm run db:migrate`                                                                                                                 |
| `scripts/create-hr-account.mjs`         | `npm run hr:create`: the first HR account, password never shown or passed as an argument                                             |
| `scripts/reset-hr-password.mjs`         | `npm run hr:reset-password`: recover an HR account (new password, lock cleared, sessions ended)                                      |
| `server/local-setup.mjs`                | The compose `setup` service: guard, migrations, local HR login, `hr-login.json`, banner                                              |
| `scripts/local-stack.mjs`               | Host command for `npm run local*`: starts Docker, runs compose, prints the login summary                                             |
| `scripts/hr-account-tool.mjs`           | Input (terminal without echo, or piped lines) and rules shared by both HR scripts                                                    |
| `server/onboarding-content.mjs`         | The built-in onboarding templates per track, policy scenario checks and quick-question chips                                         |
| `server/onboarding-progress.mjs`        | Footprint rules: template validation, the Onboarding view (70% rule, next step), step transitions, the briefing gate, chip selection |
| `server/ai-proficiency.mjs`             | AI proficiency self-assessment (levels 1–10, learning paths) for the `role-tools.ai-readiness-training` step, and its chat rating    |
| `server/check-grader.mjs`               | Grades written policy checks with Gemini; the server decides the pass from verified evidence                                         |
| `server/onboarding-journey.mjs`         | Firestore templates, progress, chips and first-day details for employees and HR                                                      |
| `server/employee-company-documents.mjs` | `GET /api/me/company-documents` and `/:id/file`: an employee's own company's active documents (#126)                                 |
| `server/company-document-files.mjs`     | Reads an uploaded company document's object from `DOCS_BUCKET`; the in-memory stand-in for the preview and tests                     |
| `server/onboarding-routes.mjs`          | The onboarding journey HTTP routes under `/api/me` and `/api/hr`                                                                     |
| `server/onboarding-collections.mjs`     | The onboarding journey's Firestore collection names                                                                                  |
| `server/support-requests.mjs`           | Consented support requests (preview, create, HR workflow) and team insights                                                          |
| `server/team-insights.mjs`              | Team-level aggregates, shown only with at least 3 employees with data                                                                |
| `server/knowledge-gaps.mjs`             | Anonymous knowledge gaps: the stored document and the HR grouping                                                                    |
| `server/pii-redaction.mjs`              | Best-effort removal of emails, phone numbers, IC numbers and Employee IDs                                                            |
| `server/checklist-agent-client.mjs`     | The onboarding checklist agent (#51): the ADK API server or Vertex AI Agent Engine, sessions and confirmations                       |
| `server/agent-actions.mjs`              | Proposed checklist changes (`agentActions`), the employee's decision and the completion heuristic                                    |
| `server/gemini-voice.mjs`               | Gemini text to speech for `/api/voice` (#52): the transcript-only prompt, WAV/PCM, cache, guard retry, Kokoro fallback               |
| `server/voice-guard.mjs`                | The duration guard for Gemini clips: spoken length of a sentence, WAV duration, accept/reject                                        |
| `server/speech-pronunciation.mjs`       | How Alya says a few names (UniVRse, Alya): the speech-only respelling map and its version                                            |
| `scripts/check-gemini-voice.mjs`        | `npm run check:voice`: synthesise and transcribe a fixed set, fail on extra words or guard trips                                     |
| `agent-platform/onboarding-checklist/`  | The checklist agent (Python, Google ADK, uv): tools, rules, Firestore, deploy command and pytest                                     |
| `scripts/start-checklist-agent.mjs`     | `npm run checklist-agent` (local ADK API server on 127.0.0.1:8093) and `npm run checklist-agent:test`                                |
| `scripts/deploy-checklist-agent.mjs`    | `npm run checklist-agent:deploy`: create or update the agent on Vertex AI Agent Engine                                               |

## Uploaded company guidance

See [Account access](account-access.md#company-documentation). `server/read-uploaded-document.mjs` validates files and bounds worker execution; `server/uploaded-document-worker.mjs` extracts PDF/DOCX/text content (profile autofill reuses both, cutting long text to the limit instead of rejecting it). `server/company-knowledge.mjs` manages HR's uploaded library in Firestore `companyDocuments` for the HR dashboard while routing runtime retrieval (`retrieve`, `quote`) exclusively through the company document search (Vertex AI Search, when `VERTEX_SEARCH_ENGINE_ID` is set); `server/active-company-documents.mjs` keeps only the passages of active library entries (see [Chat and memory](chat-and-memory.md#which-documents-chat-may-use-retrieval-allowlist)). `server/workspace-limits.mjs` holds the shared upload limits. The guest workspace (`guest-workspace-*.mjs`, `workspace-company-knowledge.mjs`) was removed in issue #55.
