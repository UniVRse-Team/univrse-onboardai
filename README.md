# UniVRse OnboardAi

Onboard.AI turns a new hire’s first-day confusion into a guided journey with Alya, an animated AI onboarding buddy. Combining conversational support with clear visual explanations, Alya helps employees understand company policies, complete essential tasks and find the people and tools they need, while giving HR a clearer view of progress.

Designed for different minds and learning needs, Onboard.AI brings neurodivergent-inclusive onboarding, optional workplace-support preferences and AI-readiness self-assessment into one experience. Employees control what support information they share, while five weighted progress areas make their next steps clear. Our goal: less repetitive work for HR and a more confident, supported start for every new hire.

Built on **Node.js 22, Express 5, React 19, Vite 7, LangGraph, Google Gemini, Terraform, and Google Cloud Run**.

---

## Table of Contents

- [System Architecture](#system-architecture)
  - [Architecture Diagram](#architecture-diagram)
  - [GCP Infrastructure Components](#gcp-infrastructure-components)
  - [Backend Services & Pipelines](#backend-services--pipelines)
- [Key Features](#key-features)
- [Quick Start & Local Development](#quick-start--local-development)
  - [Prerequisites](#prerequisites)
  - [Option A: Local Development Server](#option-a-local-development-server)
  - [Option B: One-Command Docker Stack](#option-b-one-command-docker-stack)
  - [Option C: UI Preview Mode (No Sign-In Required)](#option-c-ui-preview-mode-no-sign-in-required)
  - [Running Tests & Quality Checks](#running-tests--quality-checks)
- [Application Pages & Routes](#application-pages--routes)
- [Environment Configuration](#environment-configuration)
- [Company Knowledge & Document Retrieval](#company-knowledge--document-retrieval)
  - [Dual-Bucket Architecture & Allowlist Filter](#dual-bucket-architecture--allowlist-filter)
  - [Document Reconciliation Job](#document-reconciliation-job)
- [Voice Synthesis Engine](#voice-synthesis-engine)
- [Security & IAM Architecture](#security--iam-architecture)
- [CI/CD & Environments](#cicd--environments)
  - [Staging vs. Production Matrix](#staging-vs-production-matrix)
  - [Release Workflow](#release-workflow)
- [Project Documentation](#project-documentation)

---

## System Architecture

### Architecture Diagram

```mermaid
flowchart TD
    subgraph Client["Frontend Client (Browser)"]
        UI["React 19 SPA (Vite 7)"]
        Avatar["Alya 3D Avatar (Three.js / WebGL)"]
        Audio["Voice Audio Player"]
        Pages["Onboarding Dashboard / HR Portal / Alya Chat"]
        UI --> Avatar
        UI --> Audio
        UI --> Pages
    end

    subgraph CloudRun["Google Cloud Run (asia-southeast1)"]
        direction TB
        Web["onboardai-web (Public Reverse Proxy & Vite SPA)\n1 vCPU / 512 MiB\nPublic: allUsers"]
        API["onboardai-api (Express 5 Backend & LangGraph)\n1 vCPU / 1 GiB | CPU Boost\nPrivate: Serverless Auth"]
        TTS["onboardai-tts (Kokoro ONNX Voice Microservice)\n2 vCPU / 2 GiB | Concurrency Limit: 8\nPrivate: Serverless Auth"]

        MigrateJob["Job: onboardai-db-migrate\n(PostgreSQL & Firestore Migrations)"]
        ReconcileJob["Job: onboardai-docs-reconcile\n(Hourly Firestore-GCS-Vertex Sync)"]

        Web -- "OIDC ID Token Proxy\n(X-Serverless-Authorization)" --> API
        API -- "OIDC ID Token\n(X-Serverless-Authorization)" --> TTS
    end

    subgraph GenAI["Google Cloud AI & Vertex AI"]
        GeminiChat["Gemini 3.5 Flash Lite\n(LangGraph Conversational Workflow)"]
        GeminiTTS["Gemini 3.8 Flash TTS\n(Primary Cloud Voice: Sulafat)"]
        CheckGrader["Gemini 3.8 Flash\n(Check Grader & Rubric Evaluator)"]
        VertexSearch["Vertex AI Search & Discovery Engine\n(Enterprise Tier / Layout-based Chunking)"]
        AgentEngine["Vertex AI Agent Engine (ADK Python 3.13)\n(Onboarding Checklist Reasoning Engine)"]

        API --> GeminiChat
        API --> GeminiTTS
        API --> CheckGrader
        API --> VertexSearch
        API --> AgentEngine
    end

    subgraph DataStorage["Data Storage & Databases"]
        CloudSQL[("Cloud SQL PostgreSQL 17\n(User Accounts, Sessions, Roles, Audit Logs)")]
        Firestore[("Cloud Firestore Native Mode\n(Onboarding Progress, Chat Checkpoints,\nDocument Metadata, Footprints)")]
        DocsBucket["GCS: Company Docs Bucket\n(project-...-onboardai-docs)"]
        EmpBucket["GCS: Private Employee Docs Bucket\n(project-...-onboardai-employee-docs\nAir-Gapped from Search)"]
        TFStateBucket["GCS: Terraform State Bucket\n(project-...-tfstate)"]

        API -- "Unix Domain Socket\n(/cloudsql/<connection>)\nSSL ENCRYPTED_ONLY" --> CloudSQL
        API --> Firestore
        API --> DocsBucket
        API --> EmpBucket
        DocsBucket -. "Automatic Document Import" .-> VertexSearch
    end

    subgraph SecurityOps["Security, Operations & Automation"]
        Scheduler["Cloud Scheduler\n(Hourly Cron Trigger: 7m / 37m offset)"]
        Secrets["Secret Manager\n(DATABASE_URL, DB Passwords, MCP Tokens)"]
        ArtifactReg["Artifact Registry (Docker)\n(asia-southeast1/onboardai[-staging])"]
        Monitoring["Cloud Monitoring & Alerting\n(Uptime Checks, Latency, 5xx, Sync Drift)"]
        WIF["Workload Identity Federation\n(GitHub Actions Keyless Deployment)"]

        Scheduler --> ReconcileJob
        ReconcileJob --> Firestore
        ReconcileJob --> DocsBucket
        ReconcileJob --> VertexSearch
        API -. "Read Secrets" .-> Secrets
        MigrateJob -. "Read Secrets" .-> Secrets
        WIF -. "Deploy Images" .-> ArtifactReg
        WIF -. "Deploy Services" .-> CloudRun
    end

    Client -->|HTTPS| Web
```

### GCP Services Breakdown & Usage

The production infrastructure is verified live in Google Cloud (`project-65a9b676-abdb-4393-bc1`) and provisioned declaratively via Terraform (`terraform/onboardai/`). Below is the technical usage and role of each service:

| Service                                 | Cloud Resource(s)                                                                                               | Primary Purpose & Usage in OnboardAi                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Google Cloud Run (Services)**         | `onboardai-web[-staging]`<br>`onboardai-api[-staging]`<br>`onboardai-tts[-staging]`                             | **Containerized Serverless Execution**:<br>• `web`: Public-facing reverse proxy serving Vite SPA; uses Cloud Run metadata server to mint Google-signed OIDC ID tokens for private backend requests.<br>• `api`: Private Express 5 application orchestrating Gemini LangGraph workflows, verification checks, and data operations.<br>• `tts`: Dedicated private microservice executing Kokoro TTS on ONNX Runtime with concurrency controls (max 8 concurrent voice renders; 9th returns `VOICE_BUSY`). |
| **Google Cloud Run (Jobs)**             | `onboardai-db-migrate[-staging]`<br>`onboardai-docs-reconcile[-staging]`                                        | **Batch & Maintenance Tasks**:<br>• `db-migrate`: Runs automated PostgreSQL advisory-locked schema migrations and Firestore document migrations before traffic shifts to new revisions.<br>• `docs-reconcile`: Scheduled job comparing Firestore metadata, Cloud Storage files, and Vertex AI Search index, repairing orphaned or missing documents.                                                                                                                                                    |
| **Cloud SQL for PostgreSQL 17**         | `onboardai-db`<br>`onboardai-db-staging`                                                                        | **Relational Identity & Audit Vault**:<br>Stores user credentials (argon2id hashes), assigned Employee IDs (e.g., `PE-0001`), department structures, session records, and immutable security audit logs. Connected securely via Cloud Run's native Unix socket (`/cloudsql/<connection>`) with `ENCRYPTED_ONLY` SSL and IAM connector enforcement.                                                                                                                                                      |
| **Cloud Firestore (Native Mode)**       | `(default)` (Production)<br>`onboardai-staging` (Staging)                                                       | **High-Throughput NoSQL State Store**:<br>Stores employee onboarding milestone progress, task verification records, chat session checkpoints (LangGraph state saver), and active company document metadata. Includes automatic TTL expiration policies (e.g., `purgeAt` on `employeeImports`).                                                                                                                                                                                                          |
| **Google Cloud Storage (GCS)**          | `...-onboardai-docs[-staging]`<br>`...-onboardai-employee-docs[-staging]`<br>`...-tfstate`                      | **Segregated Object Repositories**:<br>• `docs`: Stores approved organizational policies, handbooks, and SOPs indexed by Vertex AI Search.<br>• `employee-docs`: Private repository for confidential employee onboarding submissions (IDs, certificates, tax forms). **Air-gapped and excluded from search indexing.**<br>• `tfstate`: Remote state and lock storage for Terraform.                                                                                                                     |
| **Vertex AI Search & Discovery Engine** | `onboardai-search[-staging]`<br>`onboardai-docs[-staging]`                                                      | **Enterprise Semantic Retrieval**:<br>Indexes approved company documents using layout-based document parsing (PDF, DOCX, TXT) and hierarchical heading-aware chunking (500 tokens). Serves extractive answers and citations to Gemini chat workflows.                                                                                                                                                                                                                                                   |
| **Google Gemini Models (Vertex AI)**    | `gemini-3.5-flash-lite`<br>`gemini-3.8-flash`<br>`gemini-3.8-flash-tts`                                         | **Generative AI & Multimodal Intelligence**:<br>• `3.5-flash-lite`: Conversational dialogue engine powering Alya's contextual answers.<br>• `3.8-flash`: Grading engine evaluating written employee onboarding checks against rubrics with prompt-injection defense.<br>• `3.8-flash-tts`: Cloud text-to-speech engine using voice profile `Sulafat`.                                                                                                                                                   |
| **Vertex AI Agent Engine (ADK)**        | `onboardai-checklist[-staging]`                                                                                 | **Autonomous Checklist Reasoning Engine**:<br>Python 3.13 Google Agent Development Kit (`google-adk`) service evaluating employee onboarding progress, identifying blockers, and proposing next steps.                                                                                                                                                                                                                                                                                                  |
| **Google Cloud Scheduler**              | `onboardai-docs-reconcile[-staging]`                                                                            | **Automated Cron Trigger**:<br>Triggers the hourly `docs-reconcile` Cloud Run job (minute 7 in prod, minute 37 in staging) using service account OIDC authentication.                                                                                                                                                                                                                                                                                                                                   |
| **Google Secret Manager**               | `onboardai-database-url[-staging]`<br>`onboardai-db-password[-staging]`<br>`onboardai-intake-mcp-token-staging` | **Runtime Secrets Management**:<br>Holds database connection URLs, Cloud SQL passwords, and internal service tokens. Provisioned write-only via Terraform (`password_wo`) so secrets never leak into `.tfstate` files.                                                                                                                                                                                                                                                                                  |
| **Google Artifact Registry**            | `asia-southeast1/onboardai`<br>`asia-southeast1/onboardai-staging`                                              | **Container Image Registry**:<br>Regional Docker repository hosting built container images for Cloud Run deployments.                                                                                                                                                                                                                                                                                                                                                                                   |
| **Cloud Monitoring & Logging**          | Log Views, Metrics & Alert Policies                                                                             | **Production Observability & SLA Monitoring**:<br>Multi-region uptime checks (`/web-health`, `/api/health`), 5xx alert policies, p95 API latency thresholds, and document reconciliation drift monitors notifying engineering teams.                                                                                                                                                                                                                                                                    |
| **Workload Identity Federation (WIF)**  | `onboardai-github[-staging]`                                                                                    | **Keyless CI/CD Security**:<br>Enables GitHub Actions workflows to authenticate to Google Cloud via short-lived OIDC tokens, eliminating long-lived service account keys.                                                                                                                                                                                                                                                                                                                               |

---

### Backend Services & Pipelines

The Express 5 backend (`server/`) is structured around clean domain boundaries and security gates:

- **Authentication & RBAC (`server/account-*.mjs`, `server/api-routes.mjs`)**:
  - Session-based authentication using cryptographically secure cookies (`SameSite=Lax`, `HttpOnly`).
  - Role-based gates distinguishing `employee` vs. `hr` access. Enforces mandatory first-time password resets for auto-generated credentials.
- **LangGraph Chat Workflow (`server/gemini-chat-workflow.mjs`)**:
  - Conversational state machine orchestrating Gemini prompt composition, contextual turn history, citations, and output structuring.
  - Multi-checkpoint persistence backed by Firestore (`server/firestore-checkpointer.mjs`) with SQLite fallback for local testing.
  - Automatic answer freshness and stale policy detection (`server/answer-recency.mjs`).
- **Onboarding Progress & Verification Engine (`server/onboarding-*.mjs`, `server/check-grader.mjs`)**:
  - Five core onboarding tracks with milestone thresholds (70% passing rule).
  - Document-grounded verification checks: Multiple-choice scenario checks with randomized option layouts, plus written short-answer checks graded dynamically by Gemini 3.8 Flash against verified rubrics.
  - Prevents prompt injections, catches fabricated evidence, and delivers non-revealing instructional feedback.
- **Dual-Layer Retrieval Engine (`server/company-knowledge.mjs`, `server/active-company-documents.mjs`)**:
  - Queries Vertex AI Search for candidate passages, then applies a strict local snapshot allowlist cached from Firestore. Replaced or deleted documents are filtered out within 30 seconds even if the search index is still updating.
- **Multi-Provider Voice Synthesis (`server/gemini-voice.mjs`, `server/kokoro-voice.mjs`)**:
  - Dual-tier synthesis: Primary streaming via Gemini TTS (`gemini-3.8-flash-tts` / voice `Sulafat`), falling back automatically to self-hosted Kokoro TTS (`af_heart`).
  - Sentence-level chunking and phoneme alignment driving real-time 3D avatar lip sync and presentation cue changes.

---

## Key Features

- **Interactive 3D Digital Human (Alya)**: Fully animated 3D avatar built with Three.js/WebGL, featuring real-time viseme lip synchronization, natural idle movements, and synchronized presentation stage cues.
- **Document-Grounded Intelligence**: Gemini answers strictly grounded in approved organizational documents via Vertex AI Search; automatically flags outdated policies.
- **Automated Verification & Grading**: Built-in quizzes and AI-evaluated scenario checks that verify employee comprehension before marking onboarding steps completed.
- **Autonomous Checklist Agent**: Powered by Google ADK on Vertex AI Agent Engine, continuously monitoring employee progress, proposing helpful next actions, and routing blockers.
- **Private Document Submissions**: Secure employee document collection pipeline with HR review workflows and private Google Cloud Storage segregation.
- **HR Command Center**: Comprehensive management dashboard for employee profile provisioning, track assignment, document uploads, support requests, and anonymous team insights.

---

## Quick Start & Local Development

### Prerequisites

- **Node.js**: `v22.13.0` or later (tested up to Node.js 24)
- **Docker & Docker Compose**: For local PostgreSQL, Firestore emulator, and Kokoro runtime
- **Google Cloud SDK (`gcloud`)**: For Application Default Credentials (Vertex AI Gemini access)

---

### Option A: Local Development Server

1. **Clone the repository and install dependencies**:

   ```bash
   git clone https://github.com/UniVRse-Team/univrse-onboardai.git
   cd univrse-onboardai
   npm ci
   ```

2. **Configure your environment**:

   ```bash
   cp .env.example .env
   ```

   _(Add your `GOOGLE_CLOUD_PROJECT` to `.env` to enable Vertex AI Gemini answers)._

3. **Log in with Application Default Credentials**:

   ```bash
   gcloud auth application-default login
   ```

4. **Prepare the local voice model** (downloads Kokoro ONNX model to `.cache/`):

   ```bash
   npm run voice:prepare
   ```

5. **Start local databases in Docker**:

   ```bash
   npm run db:up       # Starts PostgreSQL on 127.0.0.1:5442 & Firestore emulator on 127.0.0.1:8681
   npm run db:migrate  # Runs SQL and Firestore migrations
   npm run hr:create   # Prompts to create your first local HR administrator account
   ```

6. **Start the development server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

### Option B: One-Command Docker Stack

To launch the full production-like topology locally (API, Web, PostgreSQL, Firestore emulator, Checklist Agent, and Kokoro TTS) in Docker:

```bash
npm run local
```

Useful Docker management commands:

```bash
npm run local:reset-hr   # Reset the local HR administrator credentials
npm run local:logs       # Stream container logs
npm run local:down       # Stop application containers while keeping database data intact
```

---

### Option C: UI Preview Mode (No Sign-In Required)

For rapid frontend styling and interaction design without requiring databases or GCP credentials:

```bash
npm run dev:preview
```

Open [http://localhost:3000/onboarding](http://localhost:3000/onboarding) or [http://localhost:3000/hr](http://localhost:3000/hr). A bottom preview bar lets you freely switch between Employee, HR, and Alya views using mock fixtures.

---

### Running Tests & Quality Checks

Run the verification test suite before committing changes:

```bash
npm test                 # Run all backend, frontend, and integration tests
npm run build            # Verify client production build (Vite)
npm run format:check     # Check code formatting (Prettier)
npm run check:share      # Scan working tree for leaked secrets or unauthorized files
```

---

## Application Pages & Routes

| URL Route     | Purpose                                                                                   | Role Required         |
| :------------ | :---------------------------------------------------------------------------------------- | :-------------------- |
| `/`, `/login` | Secure portal sign-in                                                                     | Public                |
| `/onboarding` | Unified employee onboarding journey, activity checks, footprint, and document uploads     | Signed-in Employee    |
| `/alya`       | Interactive 3D Alya presentation stage, voice conversation, and quick questions           | Signed-in Employee    |
| `/hr`         | HR Command Center: Employee accounts, onboarding oversight, document library, submissions | Signed-in HR          |
| `/api/health` | Backend readiness probe (checks PostgreSQL, Firestore, and Vertex AI connectivity)        | Internal / Monitoring |
| `/web-health` | Frontend container health probe                                                           | Internal / Monitoring |

---

## Environment Configuration

Key configuration parameters (see `.env.example` for the complete reference):

| Variable                      | Description                                                                   | Default / Example                   |
| :---------------------------- | :---------------------------------------------------------------------------- | :---------------------------------- |
| `PORT`                        | Web server listening port                                                     | `3000`                              |
| `NODE_ENV`                    | Application environment (`development` or `production`)                       | `development`                       |
| `GOOGLE_CLOUD_PROJECT`        | GCP Project ID hosting Vertex AI, Gemini, and Cloud Run                       | `project-65a9b676-abdb-4393-bc1`    |
| `AI_MODE`                     | AI conversational engine (`gemini-chat` or `sample`)                          | `gemini-chat`                       |
| `GEMINI_MODEL`                | Foundation model for LangGraph chat workflows                                 | `gemini-3.5-flash-lite`             |
| `CHECK_GRADER_MODEL`          | Gemini model for evaluating written onboarding checks                         | `gemini-3.8-flash`                  |
| `VOICE_PROVIDER`              | Primary text-to-speech engine (`gemini` or `kokoro`)                          | `gemini`                            |
| `GEMINI_TTS_MODEL`            | Model ID for cloud voice generation                                           | `gemini-3.8-flash-tts`              |
| `GEMINI_TTS_VOICE`            | Prebuilt voice profile for Alya                                               | `Sulafat`                           |
| `DATABASE_URL`                | PostgreSQL connection string                                                  | `postgresql://...`                  |
| `FIRESTORE_DATABASE_ID`       | Firestore database name (`(default)` in prod, `onboardai-staging` in staging) | `(default)`                         |
| `DOCS_BUCKET`                 | Cloud Storage bucket for company policies and knowledge base                  | `<project>-onboardai-docs`          |
| `EMPLOYEE_DOCUMENTS_BUCKET`   | Air-gapped Cloud Storage bucket for private employee submissions              | `<project>-onboardai-employee-docs` |
| `VERTEX_SEARCH_DATA_STORE_ID` | Vertex AI Search data store identifier                                        | `onboardai-docs`                    |
| `VERTEX_SEARCH_ENGINE_ID`     | Vertex AI Search search engine identifier                                     | `onboardai-search`                  |
| `CHECKLIST_AGENT_URL`         | Local ADK server address for checklist agent                                  | `http://127.0.0.1:8093`             |
| `CHECKLIST_AGENT_ENGINE`      | Cloud Run resource name for deployed Vertex AI Agent Engine                   | `projects/...`                      |

---

## Company Knowledge & Document Retrieval

### Dual-Bucket Architecture & Allowlist Filter

To protect organizational data and prevent hallucinations, OnboardAi uses a dual-layer knowledge retrieval pipeline:

1. **Storage Segregation**:
   - Company knowledge documents live in `DOCS_BUCKET` and are ingested into Vertex AI Search.
   - Private employee submissions live in `EMPLOYEE_DOCUMENTS_BUCKET` and are **never** indexed or readable by the search engine.
2. **Instant Eviction Allowlist**:
   - Vertex AI Search can take several minutes to index new uploads or purge deleted files.
   - To guarantee zero lag when an HR manager deletes or replaces a policy document, the backend maintains an in-memory snapshot of active documents from Firestore (`active-company-documents.mjs`, 30s TTL cache).
   - Any passage returned by Vertex AI Search that does not match an active Firestore document ID is immediately discarded before reaching Gemini.

### Document Reconciliation Job

The automated Cloud Run Job `docs-reconcile` runs on an hourly schedule via Cloud Scheduler:

```bash
# Run manual dry-run report
npm run docs:reconcile

# Run reconciliation with automatic repair
npm run docs:reconcile -- --apply
```

It compares Firestore `companyDocuments`, Cloud Storage objects, and Vertex AI Search indexed documents, reporting any drift and cleaning up orphaned storage objects.

---

## Voice Synthesis Engine

Alya's voice system is designed for high responsiveness and lifelike natural delivery:

1. **Gemini TTS (Primary)**: Generates lifelike speech via `gemini-3.8-flash-tts` using the `Sulafat` voice profile.
2. **Kokoro ONNX (Automatic Fallback)**: If Gemini TTS is unreachable or rate-limited, the system seamlessly falls back to self-hosted Kokoro TTS (`af_heart`) running locally or on the `onboardai-tts` microservice.
3. **Viseme Lip Sync**: Audio phonemes are mapped to facial blend shapes in Three.js, animating Alya's mouth movements in real time.
4. **Scene Stepping**: Visual slides and text captions automatically synchronize with speech boundaries, pausing and advancing as Alya narrates each concept.

---

## Security & IAM Architecture

- **Least Privilege Access**: Dedicated runtime Service Accounts per microservice (`web-run`, `api-run`, `tts-run`, `checklist`).
- **Workload Identity Federation (WIF)**: GitHub Actions authenticates directly to GCP without long-lived JSON service account keys.
- **Air-Gapped Employee Submissions**: Strict IAM boundaries prevent search engines and unauthorized personnel from accessing employee identity documents.
- **Write-Only Secrets**: All database passwords and tokens are provisioned via Terraform `ephemeral` blocks and write-only properties into Google Secret Manager.
- **Data Protection**: AES-256 encryption at rest across all buckets, databases, and disks; TLS enforced on all internal and external communication.

---

## CI/CD & Environments

### Staging vs. Production Matrix

| Feature                     | Staging                                  | Production                              |
| :-------------------------- | :--------------------------------------- | :-------------------------------------- |
| **Git Branch**              | `staging`                                | `main`                                  |
| **GCP Project**             | `project-65a9b676-abdb-4393-bc1`         | `project-65a9b676-abdb-4393-bc1`        |
| **Terraform Workspace**     | `staging`                                | `default`                               |
| **Cloud Run Services**      | `*-staging` (`web`, `api`, `tts`)        | `onboardai-web`, `api`, `tts`           |
| **Cloud SQL Database**      | `onboardai-db-staging` (3 daily backups) | `onboardai-db` (7 daily backups + PITR) |
| **Firestore Database**      | `onboardai-staging`                      | `(default)` (PITR enabled)              |
| **Storage Buckets**         | `*-staging`                              | Production buckets                      |
| **Search Engine**           | `onboardai-search-staging`               | `onboardai-search`                      |
| **Reconciliation Schedule** | Minute 37 past each hour                 | Minute 7 past each hour                 |
| **Intake Agent (MCP)**      | Enabled                                  | Disabled                                |

### Release Workflow

Per [AGENTS.md](AGENTS.md), all code changes follow a strict release lifecycle:

```text
feature/<task> → local verification (npm test && npm run build) → PR to staging
→ staging verification → PR staging to main → production verification
```

1. **Feature Development**: Created on an isolated feature branch off `origin/staging`.
2. **Quality Gate**: Zero test failures and clean builds required locally.
3. **Staging Deployment**: Merging to `staging` triggers `.github/workflows/deploy.yml`, building containers, running database migrations, and updating Staging Cloud Run services.
4. **Production Release**: Promoting `staging` to `main` deploys to Production after user verification.

---

## Project Documentation

Detailed reference guides are available in the `docs/` directory:

- [Account Access & RBAC](docs/account-access.md)
- [Chat Architecture & LangGraph Memory](docs/chat-and-memory.md)
- [Document Submissions & Private Storage](docs/document-submissions.md)
- [Document Reconciliation](docs/document-reconciliation.md)
- [Onboarding Journey & Footprint Tracking](docs/onboarding-journey.md)
- [Visual Presentation Guides](docs/visual-guides-and-hr-summary.md)
- [Codebase File Guide](docs/file-guide.md)
- [3D Avatar Provenance](public/avatars/alya/PROVENANCE.md)
- [Terraform Infrastructure Details](terraform/onboardai/README.md)
- [Repository Agent Guidelines (Codex / Antigravity)](AGENTS.md)
