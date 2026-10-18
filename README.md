# OnboardAi

An employee onboarding assistant with Alya, the original 3D avatar. Answers can include text, the same server-generated voice for everyone, and a visual guide on Alya's presentation stage that follows her voice. Gemini uses approved company documents and saved conversation context.

## Run locally

Use Node.js 22.13 or later; development has been checked with Node.js 24.

For a fresh copy of the project, run these commands in its folder:

```powershell
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run voice:prepare
npm.cmd run dev
```

**Keep your existing `.env` if this project is already configured.** The example contains no credentials and starts with sample answers. The first voice setup downloads the Kokoro model into the ignored `.cache` folder.

Open [the website](http://localhost:3000/) or [Alya's chat](http://localhost:3000/alya).

### Local UI preview without sign-in

Run `npm run dev:preview` and open http://localhost:3000/onboarding or
http://localhost:3000/hr. The bottom preview bar switches between employee, HR,
and Alya pages without login. Stop any other server on port 3000 first.

This separate development server uses the existing API test fixtures with
temporary in-memory accounts and sample data. It does not load `.env`, connect
to real databases, or call Google services. Changes disappear on restart.
AI answers are synthetic test responses; cloud AI, uploads to cloud storage,
and real authentication are not exercised. Use `npm run dev` for normal login
testing with configured local databases.

The preview binds only to `127.0.0.1`, rejects remote hosts, cross-origin and
forwarded requests, and refuses production mode or Cloud Run. The production
entry points never import it; its test fixtures are excluded from Docker images.

### One command in Docker

`npm run local` starts everything in Docker (PostgreSQL, the Firestore emulator, the API, the voice service, the onboarding checklist agent and the website), creates the tables and a local HR account, and prints the website address, the HR ID and password, and the Emulator UI address. It starts Docker Desktop on macOS if needed. `npm run local:reset-hr` sets a new HR password, `npm run local:down` stops the app containers, the checklist agent included (the databases keep running) and `npm run local:logs` follows their logs. See [Account access](docs/account-access.md#local-setup-in-docker-one-command).

Gemini (answers, profile autofill, the Gemini voice and the checklist agent) needs `GOOGLE_CLOUD_PROJECT`. `npm run local` takes it from the environment, then `.env`, then `gcloud config get-value project`, passes it to the containers, and stops with "GOOGLE_CLOUD_PROJECT is not set: add it to .env (Gemini on Vertex AI needs it)" when none has it. The checklist agent container runs the ADK API server on the compose network and the api reaches it at `CHECKLIST_AGENT_URL=http://checklist-agent:8093`.

### Gemini, voice and checklist agent settings

| Setting                    | Meaning                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`     | Required for Gemini on Vertex AI (Application Default Credentials: `gcloud auth application-default login`)                                              |
| `VOICE_PROVIDER`           | `kokoro` (default) or `gemini`: Gemini text to speech for Alya's voice, with Kokoro as the fallback                                                      |
| `GEMINI_TTS_MODEL`         | Default `gemini-3.8-flash-tts` (a Preview model)                                                                                                         |
| `GEMINI_TTS_LOCATION`      | Default `global`                                                                                                                                         |
| `GEMINI_TTS_VOICE`         | Default `Sulafat`                                                                                                                                        |
| `CHECKLIST_AGENT_URL`      | The local ADK API server of the onboarding checklist agent (`npm run checklist-agent`: `http://127.0.0.1:8093`; in Docker `http://checklist-agent:8093`) |
| `CHECKLIST_AGENT_ENGINE`   | On Cloud Run instead: the Vertex AI Agent Engine resource name, set by the Deploy workflow. With neither set, the checklist agent is off                 |
| `CHECKLIST_AGENT_MODEL`    | The agent's Gemini model, default `gemini-3.8-flash`                                                                                                     |
| `CHECK_GRADER_MODEL`       | The Gemini model that grades the written policy checks, default `gemini-3.8-flash` (needs `GOOGLE_CLOUD_PROJECT`; off with `AI_MODE=document-search`)    |
| `CHECK_GRADER_THINKING`    | `low` (default, thinkingLevel LOW) or `default` (the model's own thinking; the rollback, and needed for Gemini 2.5 models)                               |
| `CHECKLIST_AGENT_THINKING` | The checklist agent's thinking: `default` (default) or `low`                                                                                             |

See [Onboarding journey and support](docs/onboarding-journey.md) for how the agent and the voice work.

### Local setup with HR and employee accounts

Accounts are optional. They need Docker for PostgreSQL and the Firestore emulator (`compose.yaml`):

1. Add to `.env` (the values are local placeholders from `compose.yaml`, also listed in `.env.example`):

   ```
   DATABASE_URL=postgresql://onboardai:onboardai_local@127.0.0.1:5442/onboardai
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8681
   FIRESTORE_PROJECT_ID=demo-onboardai
   FIRESTORE_DATABASE_ID=(default)
   ```

2. Start the databases, create the tables and the first HR account, then the app:

   ```bash
   npm run db:up       # PostgreSQL on 127.0.0.1:5442, Firestore emulator on 127.0.0.1:8681
   npm run db:migrate  # SQL and Firestore migrations; safe to run again
   npm run hr:create   # asks for the HR ID and password (not shown)
   npm run dev
   ```

HR then creates employee accounts: the server assigns the Employee ID from the department (for example `PE-0001`) and a temporary password, and employees choose their own password at first sign-in. `npm run hr:reset-password` recovers an HR account (asks for the HR ID and the new password twice). With these settings the server refuses to start without the emulator, so local test personal data never reaches a cloud database. Guest access was removed (issue #55): the app needs `DATABASE_URL` and a signed-in account for chat, voice and every app page, so create an HR account first. See [Account access](docs/account-access.md) for roles, rules and the API.

With `GOOGLE_CLOUD_PROJECT` also set (and Application Default Credentials, as for Gemini chat), HR can pre-fill the "Add employee account" and "Edit profile" forms from a CV, offer letter or details form (PDF, DOCX, TXT, Markdown, JPG or PNG, up to 5 MB). Gemini on Vertex AI reads the file; HR reviews the values before saving. The file is sent to Google, but the server keeps no copy and logs no file name, content or values. See [Profile autofill](docs/account-access.md#profile-autofill).

To serve a production build locally:

```powershell
npm.cmd run build
npm.cmd start
```

## Pages

| Address       | Contents                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `/`, `/login` | Employee/HR sign-in                                                                                          |
| `/onboarding` | The employee's one onboarding page: overall progress, the five areas and steps (`/dashboard` redirects here) |
| `/alya`       | Alya's presentation stage beside the chat, quick-question chips and Ask HR                                   |
| `/mira`       | Old `/mira` links redirect to `/alya`.                                                                       |
| `/hr`         | The HR workspace: employee accounts, onboarding, support requests, insights and company documents            |

Every app page needs a signed-in account; a signed-out visitor is sent to `/login` (issue #55).

Inside UniVRse, Launchpad and the handbook page have already been removed. Their old addresses lead to Alya. Suggested checklist items and support roles are editable templates, not verified company instructions.

## Employee document submissions

Employees upload within the Documentation section of `/onboarding`; HR uses `/hr#submissions`. See [document submission setup and review notes](docs/document-submissions.md) for the private storage configuration, local preview behavior, and file list.

## Understand and edit the code

Start with the [file guide](docs/file-guide.md). The project uses JavaScript, React and CSS. File names describe their purpose; conventional entry points such as `src/main.jsx` and `server/index.mjs` are retained.

- [Chat and memory](docs/chat-and-memory.md): Gemini, LangChain, LangGraph, Vertex AI Search and saved conversations.
- [Answer styles](docs/answer-styles.md): automatic support, short explanations, steps, examples and brief answers.
- [Visual guides and HR summary](docs/visual-guides-and-hr-summary.md): illustrated answers, feedback and HR summary boundaries.
- [Account access](docs/account-access.md): HR and employee accounts, local setup, the data split and the account API.
- [Onboarding journey and support](docs/onboarding-journey.md): the onboarding footprint, quick questions, first-day details, consented support requests, team insights and knowledge gaps.
- [Avatar provenance](public/avatars/alya/PROVENANCE.md): original asset and rendering/voice dependencies.

The current voice is Kokoro Heart (`af_heart`). Its installed model warms at server startup, and a shorter opening segment lets speech begin before the remaining audio is ready. It runs on the Node server. The website does not use device-specific browser voices. Playback and estimated mouth movement start automatically with new answers when voice is on; mute, stop, speed and reduced movement controls remain available.

The ALYA avatar is kept as lossless gzip. Its transfer is about 21 MiB (a 27.7 MiB model once decoded), so loading may take time on slower devices. Chat works independently of the 3D model.

## Useful commands

| Command                              | Purpose                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `npm.cmd run dev`                    | Start the local development server                                                                            |
| `npm.cmd test`                       | Check chat, memory, visual answers, audio and assets                                                          |
| `npm.cmd run build`                  | Build the browser website                                                                                     |
| `npm.cmd run format`                 | Apply consistent, readable formatting                                                                         |
| `npm.cmd run format:check`           | Check formatting without changing files                                                                       |
| `npm.cmd run check:share`            | Check the current Git file list for private files, recognised secrets and large assets                        |
| `npm.cmd run check:search`           | Run one Vertex AI Search query and list the matching files; Google usage billing applies                      |
| `npm.cmd run docs:reconcile`         | Report drift between Firestore, the documents bucket and Vertex AI Search (read only; see below)              |
| `npm.cmd run check:gemini`           | Make one small Gemini request to check model access; Google usage limits and billing apply                    |
| `npm.cmd run check:voice`            | Synthesise and transcribe 120 Gemini voice clips; fail if any has words not in its sentence (billing applies) |
| `npm.cmd run voice:prepare`          | Download the voice model and generate a local sample                                                          |
| `npm.cmd run db:up`                  | Start local PostgreSQL and the Firestore emulator (Docker) and wait until they are healthy                    |
| `npm.cmd run db:migrate`             | Run the SQL and Firestore migrations; safe to repeat                                                          |
| `npm.cmd run db:migrations:check`    | Check migration file names and numbers (no database)                                                          |
| `npm.cmd run hr:create`              | Create an HR account; the password is prompted for, never passed as an argument                               |
| `npm.cmd run hr:reset-password`      | Recover an HR account: new password, lock cleared, its sessions ended                                         |
| `npm.cmd run local`                  | Start the whole stack in Docker and print the local HR login                                                  |
| `npm.cmd run local:reset-hr`         | Set a new password for the local HR account and print it                                                      |
| `npm.cmd run local:down`             | Stop the app containers (databases keep running)                                                              |
| `npm.cmd run local:logs`             | Follow the app container logs                                                                                 |
| `npm.cmd run checklist-agent`        | Start the onboarding checklist agent (ADK, needs uv) on 127.0.0.1:8093; set `CHECKLIST_AGENT_URL`             |
| `npm.cmd run checklist-agent:test`   | Run the checklist agent's Python tests (`uv run pytest`, no network)                                          |
| `npm.cmd run checklist-agent:deploy` | Create or update the checklist agent on Vertex AI Agent Engine (the Deploy workflow runs it)                  |

## Local settings and data

The existing `.env`, saved chats and voice cache remain local. Git and Docker exclude `.env`, credentials, chat databases, private files, generated builds, dependencies and test artifacts. `check:share` is a helpful pattern check, not a guarantee that every confidential value has been identified.

Company chat searches the approved company documents with Vertex AI Search. Enable it with `AI_MODE=gemini-chat` and the server-only settings in `.env`. Gemini and the search use Application Default Credentials: set `GOOGLE_CLOUD_PROJECT` (and optionally `GOOGLE_CLOUD_LOCATION`, default `global`), set `VERTEX_SEARCH_ENGINE_ID` (and optionally `VERTEX_SEARCH_LOCATION`, default `global`) and run `gcloud auth application-default login`. Without `VERTEX_SEARCH_ENGINE_ID`, chat answers from the built-in sample onboarding guide. Never put credentials in browser code or variables beginning with `VITE_`.

Successful chats are saved locally in SQLite, or in Firestore when `FIRESTORE_DATABASE_ID` is set (the cloud setting), and belong to the signed-in account. The selected chat and voice preferences survive normal refreshes. Support observations describe recorded requests and feedback; they do not diagnose disability or score ability, and they never change onboarding completion. Employee chat does not display reports or export controls. HR sees an individual only through a support request that the employee confirmed; otherwise HR sees team-level insights (at least 3 employees) and anonymous knowledge gaps (decision D1 = Option A, see [Onboarding journey and support](docs/onboarding-journey.md)).

## Company documents

Signed-in HR uploads PDF, DOCX, TXT or Markdown company documents on the HR page (5 MB each, forty documents). Firestore keeps only their metadata; with `DOCS_BUCKET` and `VERTEX_SEARCH_DATA_STORE_ID` set, each file goes to the documents bucket and is imported into Vertex AI Search, a replace (a new version of a document) swaps it, and a delete removes it from both. Alya answers from Vertex AI Search only when `VERTEX_SEARCH_ENGINE_ID` is set (or from the built-in sample guide without it), never from Firestore, and only from documents HR currently lists: Firestore's metadata decides which search results she may use, so a deleted or replaced document leaves chat within 30 seconds even if a copy is still indexed (`DOCS_BUCKET` is then required). When the documents on a question are out of date she says so and offers Ask HR instead of answering. See [Company Documentation](docs/account-access.md#company-documentation). Gemini uses Vertex AI with Application Default Credentials and the configured project's quota; relevant passages are sent to Google. There is no model selector in the website.

## Document reconciliation

Firestore, the documents bucket and the Vertex AI Search data store are written one after another, so a failure can leave a file in the bucket or in search that HR no longer lists (chat ignores it, but it stays billed and indexed). `npm run docs:reconcile` compares the three and prints one JSON line per difference and one summary line. By default it only reads; `--apply` deletes orphaned search documents and bucket files and re-imports missing ones, with safety stops (`--max-deletes`, an empty-library guard) and an environment guard. It never writes Firestore and never touches files outside HR's document folders (such as production's `onboarding/` PDFs). Use your own Application Default Credentials and name the environment explicitly; it does not read `.env`:

```bash
ONBOARDAI_ENVIRONMENT=staging GOOGLE_CLOUD_PROJECT=<project> FIRESTORE_DATABASE_ID=onboardai-staging \
  DOCS_BUCKET=<project>-onboardai-docs-staging VERTEX_SEARCH_DATA_STORE_ID=onboardai-docs-staging \
  npm run docs:reconcile
```

Exit codes: 0 completed, 1 an apply action failed, 2 usage or configuration error, 3 safety stop, 4 a source could not be read. Flags, item kinds and log lines are in [Document reconciliation](docs/document-reconciliation.md).

## GitHub and hosting later

GitHub shares the source code. A running website still needs a hosted Node server and its private configuration. These interface changes do not deploy or publish a website.

A running version needs a Node server with enough memory for Kokoro, and Firestore (or persistent private storage for SQLite) for saved chats. A static GitHub Pages site alone cannot run these backend features. The existing Dockerfile provides a starting point; its container has not been verified here.

Employee and HR sign-in runs locally (PostgreSQL and the Firestore emulator); Cloud SQL and the hosted environments do not have it yet. Private company documents need access protection before an unrestricted online rollout. The dependency audit currently reports nine entries in the existing voice tree and Mammoth’s CLI parser dependency. There is no compatible automatic fix. Review these during hosting preparation; the upload reader uses Mammoth’s raw-text API, not its CLI.

## Verification after cleanup

`npm test` and the production build pass, including document extraction, account ownership, the onboarding journey and signed-out refusals. Automated Gemini checks use injected model responses; they do not validate live provider availability. The visual guide follows Alya's voice, and with voice off the employee steps through it with Previous/Next; captions are paged rather than scrolled. The Docker container has not been verified here.
