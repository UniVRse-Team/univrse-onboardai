# OnboardAi on Cloud Run: infrastructure and deploy setup

This Terraform root module builds the OnboardAi MVP in the **OnBoard AI**
project (`project-65a9b676-abdb-4393-bc1`, number `48074397808`, region
`asia-southeast1`) and prepares it for the GitHub Actions deploy in
`.github/workflows/deploy.yml`. It builds two stacks in that project from the
same code: **production** (deployed from `main`, described below) and
**staging** (deployed from `staging`, every ID suffixed `-staging`; see
[Staging](#staging)). Each has its own state in Cloud Storage (see
[State](#state)).

| Creates                                | Name                                                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APIs (never disabled on destroy)       | run, artifactregistry, iam, iamcredentials, sts, secretmanager, aiplatform, discoveryengine, firestore, storage, monitoring, sqladmin, cloudscheduler                                                                                              |
| Artifact Registry Docker repository    | `onboardai` in `asia-southeast1`, keeps the newest 5 versions of each image                                                                                                                                                                        |
| Cloud Run services (placeholder image) | `onboardai-web` (public), `onboardai-api` and `onboardai-tts` (private, see [Private api and tts](#private-api-and-tts))                                                                                                                           |
| Runtime service accounts               | `onboardai-web-run`, `onboardai-api-run`, `onboardai-tts-run`                                                                                                                                                                                      |
| Deployer service account (no key)      | `onboardai-deployer`                                                                                                                                                                                                                               |
| Workload Identity Federation           | pool `onboardai-github`, provider `github-actions`                                                                                                                                                                                                 |
| Project roles of `onboardai-api-run`   | `roles/aiplatform.user`, `roles/datastore.user` (on `(default)` only), `roles/cloudsql.client` (on `onboardai-db` only)                                                                                                                            |
| Documents bucket                       | `<project>-onboardai-docs`: uniform access, public access prevention, versioning                                                                                                                                                                   |
| Vertex AI Search (`global`)            | data store `onboardai-docs` (layout parser, 500-token chunks), Enterprise engine `onboardai-search`; `onboardai-api-run` searches it through `roles/discoveryengine.viewer` on the engine                                                          |
| Firestore                              | `(default)`, Native mode, `asia-southeast1`, delete protection on, point-in-time recovery (7 days)                                                                                                                                                 |
| Employee accounts (#45)                | Cloud SQL `onboardai-db`, secrets `onboardai-db-password` and `onboardai-database-url`, migration job `onboardai-db-migrate` and its log view                                                                                                      |
| Document reconciliation (#79)          | Cloud Run job `onboardai-docs-reconcile` (api image, report mode), Cloud Scheduler job of the same name (hourly), trigger account `onboardai-docs-trigger`, 3 log-based metrics, 4 alerts; see [Document reconciliation](#document-reconciliation) |
| Cloud Monitoring                       | one email channel per `alert_emails` entry; alerts on 5xx (api, tts), api p95 latency and failing uptime checks (`/web-health`, `/api/health` through web)                                                                                         |

**Who owns what.** Terraform owns each service's shape: identity, CPU, memory,
scaling, concurrency, timeout, startup probe, ingress and public access, and
the migration job's shape and environment. The deploy workflow owns the
images (the services' and the migration job's), the environment variables,
the secret references, the api's Cloud SQL connection and traffic. Both pass the same settings: the workflow's `WEB_RUN_FLAGS`,
`API_RUN_FLAGS` and `TTS_RUN_FLAGS` lines must equal
`terraform output cloud_run_deploy_flags`, and `terraform test` fails if they
differ. To change a setting, edit `locals.tf`, copy the new output into
`deploy.yml`, then apply and deploy.

## Prerequisites

- Terraform 1.11 or newer (write-only arguments keep the generated
  secrets out of state), the gcloud CLI, and the GitHub CLI (`gh`) logged in
  with admin rights on `UniVRse-Team/univrse-onboardai`.
- Owner on the project (the module sets project IAM and creates the WIF pool,
  Firestore and Discovery Engine resources).
- Bootstrap, done once by hand and already done for OnBoard AI:
  `cloudresourcemanager.googleapis.com` and `serviceusage.googleapis.com`
  enabled, and the state bucket `gs://project-65a9b676-abdb-4393-bc1-tfstate`
  created (asia-southeast1, uniform access, public access prevention,
  versioning).

Do steps 1 to 3 **before** the pull request that changes `deploy.yml` is
merged. The merge pushes to `main`, and that push starts a deploy. Without the
repository variables that deploy stops at its first check.

## State

`versions.tf` keeps the state in `gs://project-65a9b676-abdb-4393-bc1-tfstate`
under the prefix `onboardai`, one object per Terraform workspace:

| Workspace | `environment` | State object                |
| --------- | ------------- | --------------------------- |
| `default` | `production`  | `onboardai/default.tfstate` |
| `staging` | `staging`     | `onboardai/staging.tfstate` |

The GCS backend locks the state during a plan or apply, and bucket versioning
keeps every earlier state. The module does not manage that bucket: a module
must not own the bucket its own state is in. Nothing but `.terraform/` is kept
locally.

A plan fails with `Module output value precondition failed` when the selected
workspace and `environment` disagree (for example staging inputs with the
`default` workspace selected), so neither stack's inputs can be planned against
the other's state. `terraform workspace show` prints the selected one.

## One-time setup

### 1. Create the infrastructure

```sh
cd terraform/onboardai
gcloud auth application-default login     # credentials Terraform uses
# without ADC: export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)
cat > terraform.tfvars <<'EOF'            # gitignored; never commit it
project_id   = "project-65a9b676-abdb-4393-bc1"
alert_emails = ["someone@example.com"]
EOF
terraform init        # connects to the GCS backend
terraform plan        # review: everything is "to add"
terraform apply
```

### 2. Upload the documents

HR uploads the company documents on the Company Documentation page of the
app. The api writes each file to the documents bucket under
`<document id>/<file name>`, records it in Firestore and imports that one file
into the data store. Nothing needs importing by hand, and Terraform output no
longer carries a bucket-wide import command (`import_documents_command` is
retired, #79): importing the whole bucket would put orphaned and replaced
files back into the index.

For a folder of operator-owned files, use the backend's guarded tool
(`npm run docs:import -- <folder> --prefix <name>/`, dry run unless `--apply`;
it refuses the bucket root and HR's `<document id>/` folders). To check that
the bucket, Firestore and the index agree, and to repair them, run the
reconciliation job ([Document reconciliation](#document-reconciliation)).
Discovery Engine reads the bucket as its service agent, which holds
`roles/storage.objectViewer` on that bucket only.

The API searches the serving config in output `vertex_search_serving_config`:
`projects/48074397808/locations/global/collections/default_collection/engines/onboardai-search/servingConfigs/default_search`.
The app shows the file name and section of a result, never a signed URL, and
the API holds no bucket role.

### 3. Set the GitHub repository variables

```sh
terraform output -raw github_variable_commands
```

Review the printed `gh variable set ...` lines, then run them. The workflows
read these variables (none of them is a secret):

| Repository variable       | Source                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `GCP_PROJECT_ID`          | `project_id`                                                |
| `GCP_REGION`              | `region` (default `asia-southeast1`)                        |
| `GCP_WIF_PROVIDER`        | output `workload_identity_provider` (known after apply)     |
| `GCP_DEPLOYER_SA`         | output `deployer_service_account_email` (known after apply) |
| `AI_MODE`                 | `ai_mode` (default `gemini-chat`)                           |
| `GEMINI_MODEL`            | `gemini_model` (default `gemini-3.5-flash-lite`)            |
| `VERTEX_SEARCH_LOCATION`  | the engine's location: `global`                             |
| `VERTEX_SEARCH_ENGINE_ID` | the engine ID: `onboardai-search`                           |
| `FIRESTORE_DATABASE_ID`   | the Firestore database: `(default)`                         |

`terraform test` fails if a workflow reads a variable that has no command here,
or the other way round. To change `AI_MODE` or `GEMINI_MODEL` later, set the
variable in GitHub and run the deploy again. `GOOGLE_DRIVE_FOLDER_ID` is
retired: delete it from the repository variables if it is still set.

### 4. Trigger the first deploy

Merge the pull request (a push to `main` deploys), or run it by hand:

```sh
gh workflow run deploy.yml --repo UniVRse-Team/univrse-onboardai --ref main
gh run watch --repo UniVRse-Team/univrse-onboardai
```

The workflow runs CI on the commit, builds and pushes the three images tagged
with the commit SHA, migrates the databases with the new api image (see
[Database migrations](#database-migrations)), deploys tts, then api, then web,
and smoke-tests through web, the way a browser reaches the stack:
`/web-health`, `/`, `/api/health` (web to api), a signed-out `POST /api/voice`
(the api's own `401 AUTH_REQUIRED`, so web's ID token reached the api),
`GET /api/health/tts` (`tts: "ok"`, so the api reached tts with its ID token;
`local` fails on Cloud Run) and that `GET /api/config` reports `accounts: true`. It only
reports whether the api's and tts's own URLs answer without credentials (see
[Private api and tts](#private-api-and-tts)).

**CI on pull requests and pushes.** `Verify` (format check, migration file
check, tests, build and the secret scan) always runs. `Database migrations`
always runs too: it applies every migration twice to a throwaway PostgreSQL 17
and the Firestore emulator (see [Database migrations](#database-migrations)). The three `Docker build (web|api|tts)` checks
always report, but they build only when the change touches an image input:
`Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json`,
`index.html`, `vite.config.*`, `server/`, `src/`, `public/` or `scripts/`.
Otherwise they pass with a notice that the build was skipped. Pull requests
compare against the merge base with the base branch; pushes compare with the
previous tip. When the comparison is impossible (a new branch, a force push, a
missing commit), the images are built. The deploy always builds all three, in
CI and for the push.

### 5. Check

```sh
terraform output service_urls   # open onboardai-web in a browser
terraform plan                  # expect: No changes
```

The first production plan after the staging change (issue #20) shows one
state-only move and nothing else; see
[Staging: production's one-time state move](#productions-one-time-state-move).

`terraform plan` after a deploy must show no changes. If it plans an update to a
service, the deploy flags and `locals.tf` have drifted apart; fix them before
you apply.

## Gemini, Vertex AI Search and Firestore

The API has no API key. It calls Gemini on Vertex AI, searches
`onboardai-search` and reads and writes Firestore as `onboardai-api-run`, with
Application Default Credentials. The deploy sets `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION=global` (`gemini-3.5-flash-lite` answers on `global` and
returns 404 on `asia-southeast1`), `VERTEX_SEARCH_LOCATION`,
`VERTEX_SEARCH_ENGINE_ID` and `FIRESTORE_DATABASE_ID`. Its only secret
reference is `DATABASE_URL` (#45); `--set-secrets` replaces every reference an
earlier revision carried, which also drops the old `GEMINI_API_KEY` mount.

The data store's document processing (layout parser; layout-based chunks of at
most 500 tokens that carry their ancestor headings) cannot change after
creation. Different chunking means a new data store and a fresh import.

`onboardai-api-run` reaches only its own data (#56): `roles/datastore.user`
with an IAM condition on the `(default)` database, and
`roles/discoveryengine.viewer` on the engine `onboardai-search`, not on the
project. Staging's api is limited the same way to its own database and engine
([Isolation inside the shared project](#isolation-inside-the-shared-project)).

Production's Firestore database keeps point-in-time recovery (PITR, #56): any
minute of the last 7 days can be read, exported
(`gcloud firestore export --snapshot-time=...`) or cloned into a new database
(`gcloud firestore databases clone --snapshot-time=...`). Without it only the
last hour can. It bills the retained versions as PITR storage, USD 0.1846 per
GiB-month in `asia-southeast1` (the metric
`firestore.googleapis.com/storage/pitr_storage_bytes` shows its size): cents a
month for a database of a few hundred MiB. Staging has it off.

## Company filter schema (#86, one-time, not Terraform)

Vertex AI Search results are filtered by company: every document carries
`structData.companyId` and every search sends
`filter: 'companyId: ANY("<id>")'`. A filter on a field the data store's
`default_schema` does not declare as indexable is rejected, so each data store
needs this schema field before the code that sends the filter is deployed
(staging `onboardai-docs-staging`, then production `onboardai-docs`).

Terraform does not manage it, on purpose. `google_discovery_engine_schema`
exists in the pinned google provider (8.6.0) and can import `default_schema`,
but its `json_schema` argument is `ForceNew`, its update is a no-op, and its
destroy sends `DELETE .../schemas/default_schema`. Adopting the schema and then
adding `companyId` would plan as destroy-and-recreate: it deletes the schema
(the API refuses while the data store holds documents) and then tries to POST
a new one. Even `lifecycle { prevent_destroy = true }` only turns that plan into
an error, so the field could still not be added. The data store resource has no
schema argument (`skip_default_schema_creation` only skips creating it). The API
call below (`schemas.patch`) updates the schema in place. `tests/company_schema.tftest.hcl`
fails if a `google_discovery_engine_schema` resource is added, and checks that this
section keeps the JSON the backend relies on.

The caller needs `discoveryengine.schemas.get` and `.update`: Owner, or
`roles/discoveryengine.editor` (which the api already holds on the project;
use your own account, not the api service account). The call is idempotent and
safe to repeat.

Updating the schema re-indexes every document in the data store (Google, "Update a
schema": "Updating a schema triggers re-indexing of all documents ... Reindexing can
incur costs, depending on the parser"; the layout parser is billed). Search keeps
working but can be slow while it runs. Do it once per data store, before the
backfill. A schema update must be backward compatible: fields cannot be removed or
change type, so the step below keeps whatever the schema already holds.

```bash
PROJECT_ID=<project id>
DS=onboardai-docs-staging            # production: onboardai-docs
URL="https://discoveryengine.googleapis.com/v1/projects/$PROJECT_ID/locations/global/collections/default_collection/dataStores/$DS/schemas/default_schema"
AUTH=(-H "Authorization: Bearer $(gcloud auth print-access-token)" -H "X-Goog-User-Project: $PROJECT_ID")

# 1. Read the current schema (keep it, only add companyId).
curl -sS "${AUTH[@]}" "$URL" > /tmp/default_schema.current.json

# 2. Add companyId to it (existing properties stay).
jq '{structSchema: (
      (if .structSchema then .structSchema
       elif .jsonSchema then (.jsonSchema | fromjson)
       else {"$schema":"https://json-schema.org/draft-07/schema#","type":"object"} end)
      | .properties = ((.properties // {}) + {companyId: {type:"string", indexable:true, retrievable:true, searchable:false, dynamicFacetable:false}}))}' \
  /tmp/default_schema.current.json > /tmp/default_schema.patch.json

# 3. Patch it. The response is a long-running operation.
curl -sS -X PATCH "${AUTH[@]}" -H "Content-Type: application/json" "$URL" -d @/tmp/default_schema.patch.json

# 4. Check: companyId is present with indexable and retrievable true.
curl -sS "${AUTH[@]}" "$URL" | jq '(.structSchema // (.jsonSchema | fromjson)).properties.companyId'
```

On a data store whose schema is empty the result is exactly:

`{"$schema":"https://json-schema.org/draft-07/schema#","type":"object","properties":{"companyId":{"type":"string","indexable":true,"retrievable":true,"searchable":false,"dynamicFacetable":false}}}`

Poll the operation (`GET https://discoveryengine.googleapis.com/v1/<operation name>`)
until `done` is true. Rollback is not needed: an extra declared field does no harm
and cannot be removed.

For the api's role (#80 narrows `roles/discoveryengine.editor` to a custom role): it
must keep `discoveryengine.documents.import`, `.delete` and `.list`, plus
`discoveryengine.servingConfigs.search` (or the engine-level viewer grant).
It needs no `schemas.*` permission.

## Alerts

Cloud Monitoring emails every address in `alert_emails` (one email channel
each) when:

- **5xx responses** (`run.googleapis.com/request_count` with
  `response_code_class = 5xx`) on `onboardai-api` or `onboardai-tts` keep coming
  for 5 minutes: every 1-minute window holds at least one. One incident per
  service. `onboardai-web` is left out because it proxies the API.
- **Latency**: the p95 of `onboardai-api` (`run.googleapis.com/request_latencies`)
  over 5 minutes is above 20 s. A streamed answer counts until the stream ends.
- **Uptime** (#56): an uptime check fails from at least two of its three
  locations for 5 minutes. Two HTTPS checks run on `onboardai-web`'s `run.app`
  host every 5 minutes, from Asia Pacific, Europe and the USA (three
  locations, the fewest allowed), with a 30 s timeout: `GET /web-health`, and
  `GET /api/health`, which web proxies to the api, so it keeps working if the
  api stops being public. Each must answer 2xx with `"ok":true`. One incident
  per check; failed probes are logged to Cloud Logging.

A service scaled to zero sends no data, and missing data never fires an alert;
an open incident closes after 30 minutes without data. The uptime checks run
whatever the services' scale.

Cost: three conditions, and 25,920 check executions a month per check (four
checks across both stacks: 103,680), inside Cloud Monitoring's 1 million free
executions a month (USD 0.30 per 1,000 beyond). Each check is also a request
to web (and to the api) about every 100 s: milliseconds of request-based
billing, inside the Cloud Run free tier. It also keeps both warm, so fewer
users meet a cold start. To change the addresses, edit `alert_emails` and
apply.

## Employee accounts and database migrations

Both stacks run employee accounts (#23, #30; production since #45): a Cloud
SQL for PostgreSQL instance holds the accounts, sessions and account events,
and profiles and drafts stay in the stack's Firestore database. Every resource
below is gated on `local.employee_accounts` (`environment.tf`, true in both
stacks).

| Resource           | Production                                         | Staging                                                           |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| Cloud SQL instance | `onboardai-db`                                     | `onboardai-db-staging`                                            |
| Database and user  | `onboardai` and `onboardai`                        | the same                                                          |
| Secrets            | `onboardai-db-password`, `onboardai-database-url`  | `onboardai-db-password-staging`, `onboardai-database-url-staging` |
| Migration job      | `onboardai-db-migrate`                             | `onboardai-db-migrate-staging`                                    |
| Migration log view | `onboardai-db-migrate` (bucket `_Default`, global) | `onboardai-db-migrate-staging`                                    |
| Firestore target   | `(default)`                                        | `onboardai-staging`                                               |
| Backups            | daily, 7 kept, point-in-time recovery over 7 days  | daily, 3 kept, no point-in-time recovery                          |

Both instances: PostgreSQL 17, Enterprise edition, `db-f1-micro`, zonal, 10
GiB SSD (grows to 20 GiB at most), public IP with no authorized network,
connector enforcement (only the Cloud Run connection and the Cloud SQL Auth
Proxy), TLS required, delete protection. The database password is generated
during apply and never stored in state; `DATABASE_URL` is
`postgresql://onboardai:<password>@/onboardai?host=/cloudsql/<connection name>`.
The Cloud SQL Admin API is in production's `local.apis`; staging's state
enabled it for #30 and now only forgets it (`removed` block in `main.tf`, the
API stays on).

| Account                        | Gets                                             | On                                                                               |
| ------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `onboardai-api-run[-staging]`  | `roles/cloudsql.client`                          | The project, with an IAM condition: its own instance only                        |
|                                | Secret Manager Secret Accessor                   | Its own `onboardai-database-url[-staging]`                                       |
|                                | `roles/datastore.user` (already held: Firestore) | The project, with an IAM condition: its own database only (production since #56) |
| `onboardai-deployer[-staging]` | Cloud Run Developer (update the image, execute)  | Its own migration job                                                            |
|                                | Logs View Accessor                               | Its own migration log view                                                       |

Nobody but project owners reads the bare password secret.

### Database migrations

`npm run db:migrate` (backend, `scripts/migrate-database.mjs`) applies the
pending files of `server/migrations/NNN_name.sql` to Cloud SQL, then those of
`server/migrations/firestore/NNN_name.mjs` to Firestore. Each file runs once
per database: SQL files are recorded in the `schema_migrations` table, Firestore
files in the `schema_migrations` collection. Migrations are forward-only.

**Every deploy, both stacks.** After the three images are pushed and before
any service changes, the deploy job:

1. points the migration job at this commit's api image
   (`gcloud run jobs update onboardai-db-migrate$NAME_SUFFIX --image=...`) and
   executes it with `--wait`. The job runs as the api's account, through the
   api's Cloud SQL connection, with `DATABASE_URL` from Secret Manager,
   `FIRESTORE_DATABASE_ID` (the stack's database), `GOOGLE_CLOUD_PROJECT` and
   `MIGRATION_TARGETS=sql,firestore`, all set by Terraform. No database value
   reaches the GitHub runner.
2. prints the runner's lines of that execution into the run log and the run
   summary: `[sql] Applied: ...`, `[sql] Already applied: ...`,
   `[firestore] ...`, then `Migrations finished: ...` or
   `Migration stopped: ...`. Nothing else the job printed is shown.
3. stops the deploy if the migration failed: nothing is deployed, and every
   service keeps serving its previous revision.

**Limits.** Each Firestore migration file must finish within 5 minutes (the
runner's Firestore lease), and a whole run, every pending SQL and Firestore
file together, within 10 minutes: the job's task timeout is 600 s. Split a
longer backfill into several files. A killed or failed attempt is retried once
(`max_retries = 1`); because the retry gets a full 10 minutes, it outlasts the
lease a killed attempt left behind and can take the file over. The deploy job
allows 45 minutes: two full attempts plus the job's start, the log read and
the three service deploys.

**In CI.** `Verify` runs `npm run db:migrations:check`, which lists every
migration file and fails on one the runner would skip (bad name) or a repeated
number. The `Database migrations` job applies every migration twice to a
throwaway PostgreSQL 17 and the Firestore emulator: the first run must apply
every file, the second none, and neither may print the database URL or its
password. The `Docker build (api)` check runs the file check inside the built
api image, the image the migration job runs.

**Read a migration log.** The run log of the `Deploy tts, api, web` job, step
`Migrate the databases`, and the run summary show the lines. The full output
(npm's own lines and any stack trace) is in Cloud Logging. With Logs Viewer on
the project (owners have it):

```sh
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="onboardai-db-migrate" AND labels."run.googleapis.com/execution_name"="EXECUTION"' \
  --project=project-65a9b676-abdb-4393-bc1 --order=asc --format='value(textPayload)'
gcloud run jobs executions list --job=onboardai-db-migrate --region=asia-southeast1 --project=project-65a9b676-abdb-4393-bc1
```

Use `onboardai-db-migrate-staging` for staging. The deploy prints the execution
name. Lines can reach Cloud Logging a few seconds late: the deploy retries for
about 40 seconds and only warns (never fails) when a successful migration's
last line has not arrived.

### Roll back a migration

Migrations are forward-only and a service rollback does not undo them.

- **A migration failed.** Nothing was deployed. A failed SQL file rolled back
  its own transaction; files before it stay applied, and so do Firestore files
  that finished. Fix forward: push a commit that corrects the file (if it never
  applied anywhere) or adds a new one.
- **A migration applied but broke something.** Prefer a new migration that
  undoes it, shipped through `staging` like any change.
- **Data was lost or corrupted (production).** Point-in-time recovery covers
  the last 7 days. Clone the instance as it was just before the migration ran
  into a new instance, check it, and copy the affected data back from it.
  Before restoring a backup over the live instance, take an on-demand backup
  of it (`gcloud sql backups create --instance=onboardai-db`):

  ```sh
  gcloud sql instances clone onboardai-db onboardai-db-restore-1 \
    --point-in-time='2026-10-16T09:00:00Z' --project=project-65a9b676-abdb-4393-bc1
  gcloud sql backups list --instance=onboardai-db --project=project-65a9b676-abdb-4393-bc1
  ```

  Staging has daily backups only (`gcloud sql backups restore`). Production's
  Firestore has point-in-time recovery over the last 7 days (#56): clone
  `(default)` as it was just before the migration into a new database, check
  it, and copy the affected documents back:

  ```sh
  gcloud firestore databases clone --source-database='projects/project-65a9b676-abdb-4393-bc1/databases/(default)' \
    --snapshot-time='2026-10-16T09:00:00Z' --destination-database=onboardai-restore-1 --project=project-65a9b676-abdb-4393-bc1
  ```

  The snapshot time must be a whole minute. Staging's Firestore has no
  point-in-time recovery; a Firestore migration there is undone by a new one.

### Rotate the database password

Terraform generates the password during apply (`ephemeral "random_password"`)
and sends it only when `db_password_version` changes. To rotate, raise it by
one in the stack's tfvars, plan, apply, then run that stack's deploy again
(`gh workflow run deploy.yml --repo UniVRse-Team/univrse-onboardai --ref main`
or `--ref staging`): running api instances keep the old value until they are
replaced. The user, the password secret and `DATABASE_URL` change in the same
apply. If an apply ever fails after creating the database user but before
writing its secrets, raise `db_password_version` by one and apply again: the
three get one consistent new password.

### First HR account

There is no public sign-up, so a stack's first HR account is created once, by
hand, by a project owner, with `npm run hr:create` (#23) through the Cloud SQL
Auth Proxy, after the stack's first deploy has run the migrations. The
password is typed at a prompt that does not echo it; it never reaches a log,
the repository or a workflow, and the database stores only its scrypt hash.
You need the [Cloud SQL Auth Proxy v2](https://cloud.google.com/sql/docs/postgres/sql-proxy)
(`brew install cloud-sql-proxy`), Application Default Credentials
(`gcloud auth application-default login`) and a checkout of the deployed
branch with `npm ci` done. For production use `onboardai-db` and
`onboardai-db-password`; for staging the `-staging` names:

```sh
# Terminal 1: the proxy, on localhost only. Connector enforcement allows it;
# no authorized network is needed.
cloud-sql-proxy --address 127.0.0.1 --port 15432 \
  project-65a9b676-abdb-4393-bc1:asia-southeast1:onboardai-db-staging

# Terminal 2, at the repository root. A shell variable keeps the password out
# of the command line and the shell history.
DB_PASSWORD=$(gcloud secrets versions access latest \
  --secret=onboardai-db-password-staging --project=project-65a9b676-abdb-4393-bc1)
DATABASE_URL="postgresql://onboardai:${DB_PASSWORD}@127.0.0.1:15432/onboardai" npm run hr:create
unset DB_PASSWORD
# hr:create asks for the HR ID and the password twice, without echo.
```

Stop the proxy afterwards. `npm run hr:reset-password` works the same way.

### Cost of the accounts database

Per stack, the instance runs all month: about USD 13 a month in
`asia-southeast1` (`db-f1-micro` USD 0.0147 an hour, USD 10.73 for 730 hours;
10 GiB SSD at USD 0.238 per GiB-month, USD 2.38). Backups and point-in-time
recovery logs are billed as backup storage at USD 0.112 per GiB-month of
backup data: cents a month at this size (production keeps 7 daily backups and
7 days of logs, staging 3 backups). The public IPv4 address is billed only
while an instance is stopped. The migration job runs for well under a minute
per deploy (Cloud Run jobs: CPU and memory seconds, within the free tier at
this rate), and the log view and its grant cost nothing. Secret Manager: two
active versions per stack (USD 0.06 each a month after six free).

### Order of the #45 change

1. Apply the `staging` workspace (plan reviewed by the user): the migration
   job's new environment and the log view and its grant; nothing else changes.
2. Merge the pull request into `staging`. Its deploy migrates and prints the
   lines, then deploys the api with the Cloud SQL connection and
   `DATABASE_URL`, without the intake agent while #27's deploy command is not
   in the branch.
3. Apply the `default` workspace (production; plan reviewed by the user): the
   accounts database, its secrets, the migration job, the log view, the api's
   Cloud SQL Client role and the Cloud SQL Admin API, plus #24's pending WIF
   update (production deploys cannot authenticate without it).
4. Then the `staging` to `main` pull request. Its deploy creates production's
   schema, and the smoke test requires `accounts: true`. Create the first
   production HR account by hand afterwards ([First HR account](#first-hr-account)).

## Document reconciliation

Company documents (#79) live in three places that the api writes one after
another, with no shared transaction: Firestore `companyDocuments` (what HR
published), the documents bucket (the files) and the Vertex AI Search data
store (what chat can find). A failed upload, delete or replace can leave them
out of step. A Cloud Run job compares the three every hour and prints the
drift as structured log lines; with apply mode it also repairs what is safe
to repair. The script is `scripts/reconcile-company-documents.mjs` and its
rules, item kinds and exit codes are in `docs/document-reconciliation.md`.

**Resources** (`docs_reconcile.tf`, `docs_reconcile_monitoring.tf`; staging
appends `-staging`):

| Resource                 | Name and settings                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run job            | `onboardai-docs-reconcile`: the api image, `node scripts/reconcile-company-documents.mjs`, runs as `onboardai-api-run`, 1 task, 900 s, no retries, no secret, no Cloud SQL |
| Cloud Scheduler job      | `onboardai-docs-reconcile`: `7 * * * *` UTC in production, `37 * * * *` in staging; POST to the job's `:run` with an OAuth token of the trigger account                    |
| Trigger account          | `onboardai-docs-trigger` (30 characters in staging, the limit): no key, `roles/run.invoker` on the job only                                                                |
| Deployer grant           | `roles/run.developer` on the job only, so `deploy.yml` can update its image                                                                                                |
| Log-based metrics        | `onboardai_docs_sync_failures`, `onboardai_docs_reconcile_items`, `onboardai_docs_reconcile_unrepaired` (staging: suffix `-staging`)                                       |
| Alerts (existing emails) | sync failing; reconciliation run failed; reconciliation SLA missed (3 h production, 6 h staging); index drift not repaired                                                 |

**Report mode.** The job starts in `report` in both environments
(`local.docs_reconcile_mode`, pinned in `tests/docs_reconcile.tftest.hcl`): it
reads, prints what it would do and changes nothing, and exits 0 even when it
finds drift (the drift is in the counts). Apply mode is a later PR: it flips
the map in `docs_reconcile.tf`, which adds `--apply` to the job's args and
nothing else, goes through staging first, and needs the user's OK on the
production plan. Do not set it earlier.

**No new grant.** The job runs as the api runtime account and the module adds
no project-level binding. The api's existing roles cover report mode:
`roles/discoveryengine.editor` (project; `documents.list`; also `import`,
`delete` and `operations.get` for apply mode), `roles/storage.objectUser` on
its own bucket (`objects.list`; `delete` for apply mode) and
`roles/datastore.user` limited to its own database (reads). Narrowing the
editor role is issue #80. The script refuses (exit 2, nothing read) a data
store, bucket or database of the other environment.

**What alerts.** All four go to the existing email channels.

- _Sync failing_: the api logged a failed Cloud Storage or Discovery Engine
  request (`onboardai_docs_sync`, outcome `failed`) in the last 5 minutes.
  ERROR in production, WARNING in staging.
- _Run failed_: an execution of the job failed (exit 1 to 4). ERROR / WARNING.
- _SLA missed_: no successful execution for 3 h (production) or 6 h (staging).
  This is an absence alert, so it **arms only after the first successful
  execution**: run the job once by hand after the first apply. ERROR / WARNING.
- _Drift not repaired_: a run reported items that are not `unmanaged`, not
  `pending` and not `done`. WARNING in both. Production's 4 legacy
  `onboarding/*.pdf` files are `unmanaged`: they neither fail the run nor
  alert. In report mode every real drift is unrepaired, so this alert stays
  open until the drift is fixed or the job runs in apply mode. It is aligned
  over 65 minutes, so hourly runs keep one incident open. Staging's known
  drift (5 index orphans and 1 object orphan) opens it on the first run.

Not built yet: an ingestion SLA alert (a document searchable 15 minutes after
upload) and an alert on Discovery Engine's own `api_errors` log, which today
holds only the app's expected 404s.

**Run it once by hand** (read-only while the job is in report mode):

```sh
terraform output -raw docs_reconcile_run_command    # gcloud run jobs execute ... --wait
```

The result is in Cloud Logging, in the job's logs: the last line is the
summary (`event` `onboardai_docs_reconcile`, with `exitCode`, `reason` and the
counts) and each item is a line with `event` `onboardai_docs_reconcile_item`.
No line carries a file name, title or URI.

**Rollout order** (the apply gate holds: the user sees every plan and says OK):

1. **Enable the Cloud Scheduler API once, by hand, with the user's OK**:
   `gcloud services enable cloudscheduler.googleapis.com --project=<project>`.
   Only production's state manages APIs (`main.tf`), and production is applied
   from `main` only, so staging's apply cannot enable it and the staging
   Scheduler job cannot be created (403) until it is on. Enabling an API
   changes nothing else. The `terraform plan` of staging works without it.
2. Merge the PR into `staging`. The staging deploy ships the script and the
   `ONBOARDAI_ENVIRONMENT` variable; the "Update the document reconciliation
   job" step skips with a notice, because the job does not exist yet.
3. Apply staging with the user's OK on the plan (about 3 metrics, 4 alerts,
   the job, the trigger account, 2 job grants and the Scheduler job to add;
   see the PR for the exact plan).
4. Point the job at the current api image: the next deploy does it, or run
   `gcloud run jobs update onboardai-docs-reconcile-staging --image=<api image>`.
   Until then the job runs the placeholder image and fails, so P2 fires; do
   step 5 right after.
5. Run it once by hand (`docs_reconcile_run_command`), read the summary line,
   and check the report against what is known. This also arms the SLA alert.
6. Promote `staging` to `main`, apply production the same way (its plan also
   adopts the Scheduler API as a create, which is a no-op enable), point the
   job at the image, run it once, and show the user the report.
7. Later, in separate PRs through staging: the apply-mode PR for staging, then
   production's, after the user decides what happens to the 4 legacy PDFs.

## Roll back

A failed deploy or smoke test prints the exact commands in the job log and the
run summary. They send each service back to the revision that served before
that run. By hand:

```sh
gcloud run revisions list --service=onboardai-web --region=asia-southeast1 --project=YOUR_PROJECT_ID
gcloud run services update-traffic onboardai-web --region=asia-southeast1 --project=YOUR_PROJECT_ID \
  --to-revisions=REVISION_NAME=100
```

Repeat for `onboardai-api` and `onboardai-tts` as needed. The URLs do not
change. A rollback lasts until the next deploy: each deploy sends traffic back
to the newest revision. To keep the old behaviour, revert the commit on `main`,
which deploys the reverted code. You can roll back only to revisions whose
images are among the newest 5 per image (`images_to_keep`).

A service rollback does not undo the migrations the failed run applied (see
[Roll back a migration](#roll-back-a-migration)): the previous revisions run
against the migrated databases, so migrations must keep the previous code
working (add columns, tables and fields; remove them only in a later release).

A revision from before #57 sends no ID tokens. Once the api and tts are
private, rolling web or the api back to such a revision breaks web to api or
api to tts (Cloud Run answers 403). Make them public first (see
[Private api and tts](#private-api-and-tts), Roll back), then roll back.

## Private api and tts

Since #57 only `onboardai-web` is public. `onboardai-api` and `onboardai-tts`
refuse any request without a Google-signed ID token of a principal that holds
Cloud Run Invoker (`roles/run.invoker`) on them; Cloud Run answers 403 itself.
Ingress stays `all` (`--ingress=all`): IAM, not the network, does the gating,
and every service keeps its `run.app` URL.

| Service (staging: `-staging`) | Invoker                                                                   | Why                                       |
| ----------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| `onboardai-web`               | `allUsers`                                                                | The browser's way in                      |
| `onboardai-api`               | `onboardai-web-run`                                                       | web proxies `/api/*` to it                |
|                               | `onboardai-intake-staging` (staging only)                                 | the intake agent calls `/mcp` (#27)       |
| `onboardai-tts`               | `onboardai-api-run`                                                       | the api renders voice with it             |
| all three                     | `onboardai-deployer` (Cloud Run Developer includes the invoke permission) | deploys, and the smoke test's `POST /mcp` |

Each caller mints an ID token for its own runtime account from the metadata
server, with the target's origin as audience, and sends it in
`X-Serverless-Authorization` (Cloud Run checks that header and leaves
`Authorization` to the app). The app does it by itself on Cloud Run whenever
the target URL is https (`SERVICE_AUTH` unset; see `docs/cloud-run-services.md`).
A missing grant shows as Cloud Run's 403, passed through web's proxy; a failed
mint as `API_UNAVAILABLE` (502) or `VOICE_UNAVAILABLE` (503).

**Rollout (app first, then IAM).** Deploy the app that sends ID tokens first:
it works against public services too. Then apply this module, which removes
`allUsers` from the api and tts and adds the invokers above. The smoke test
passes in both states: it checks everything through web and only reports the
api's and tts's own URLs, as `public` (200, not applied yet) or `private`
(403). For each stack:

1. Merge the pull request into `staging` (or `main`); its deploy ships the app
   and the smoke test reports both services as public.
2. Apply the invoker grants alone (plan reviewed by the user; staging 3 to
   add, production 2), so web and the api can call while `allUsers` is still
   there. Terraform cannot order the removal of `allUsers` (a key leaving
   `public_invoker`) after these creates within one apply:

   ```sh
   terraform apply -target=google_cloud_run_v2_service_iam_member.runtime_invoker \
     -target=google_cloud_run_v2_service_iam_member.intake_agent_invokes_api
   ```

3. Apply the workspace in full (plan: 2 to destroy, the api's and tts's
   `allUsers` bindings).
4. Check: chat and voice work in the web app, and the api's and tts's URLs
   answer 403 without credentials (the next deploy's smoke test reports them
   as private).

**Roll back.** To make a service public again, add its key to
`public_services` in `cloud_run.tf` and apply; the invoker bindings can stay.
Do that before rolling web or the api back to a revision from before #57.

**Calling a private service yourself.** Your account needs Cloud Run Invoker
on it (project owners have it). For example, with a local proxy that adds your
ID token:

```sh
gcloud run services proxy onboardai-api --region=asia-southeast1 --project=project-65a9b676-abdb-4393-bc1 --port=8081
curl http://localhost:8081/api/health
```

## Cloud Run settings

|                     | web                    | api                    | tts                 |
| ------------------- | ---------------------- | ---------------------- | ------------------- |
| CPU / memory        | 1 / 512Mi              | 1 / 1Gi                | 2 / 2Gi             |
| Concurrency         | 80                     | 80                     | 8                   |
| Min / max instances | 0 / 3                  | 0 / 1 (contract)       | 0 / 2               |
| Request timeout     | 300 s                  | 300 s                  | 300 s               |
| Startup probe       | `GET /web-health` 60 s | `GET /api/health` 60 s | `GET /health` 240 s |
| Startup CPU boost   | off                    | on                     | on                  |

All three use the gen2 execution environment, request-based billing (CPU only
while serving), scale to zero, and listen on port 8080.

- **web**: static files and a streaming proxy. Measured locally: 21 MiB idle,
  53 MiB peak. 512Mi is the gen2 minimum. The 300 s timeout is above the proxy's
  290 s upstream timeout, so the proxy answers a slow API with its own 504.
- **api**: one instance. Saved chats are in Firestore (#9), but the guest
  workspace store (`server/guest-workspace-store.mjs`: guest workspaces, their
  employees, documents, chats and checkpoints) is a SQLite file on each
  instance's local disk, wiped on restart, and the per-IP limit on POST and
  PATCH requests is counted per instance; a second instance would split both.
  Lifting the cap is #58. Measured locally: 61 MiB idle (demo mode). 1Gi
  leaves room for the SQLite file, which Cloud Run keeps in memory.
- **tts**: Kokoro q8 (82M) runs a whole answer, up to the model's 512 tokens, in
  one ONNX pass. Measured on linux/arm64 (container cgroup peak): 340 MiB after
  the model loads in about 0.6 s; 508 MiB for 100 characters, 591 for 150, 652
  for 200, 685 for 225. Natively, the longest input peaks at 727 MiB and reaches
  1022 MiB after repeated renders. A container capped at 1100 MiB was OOM-killed
  on its second 225-character render. 2Gi is therefore the smallest standard
  size with headroom. Renders run one at a time, so memory does not grow with
  concurrency. Two cores rendered 17% faster than one (15.9 s against 19.1 s for
  225 characters). The app answers `VOICE_BUSY` beyond 8 queued requests, so
  concurrency is 8. The 240 s startup probe covers the model load; `/health`
  returns 503 until then.

These are local measurements, not Cloud Run figures. After the first deploys,
check memory utilisation in the Cloud Run console. Raise tts to 4Gi if its logs
show "Memory limit exceeded".

## Security

- GitHub Actions has no key. The provider accepts a GitHub OIDC token only when
  the repository ID is `1418194026`, the owner ID is `283518526`, the ref is
  `refs/heads/main`, the workflow is `.github/workflows/deploy.yml` on `main`,
  and the event is `push` or `workflow_dispatch`. Pull requests, forks, other
  branches and other workflows cannot get a token. Staging has its own pool and
  provider with the same rule for `refs/heads/staging`.
- The repository moved to the `UniVRse-Team` organisation. The repository
  ID stays the same but the owner ID changes on transfer. Re-derive both with
  `gh api repos/OWNER/NAME --jq '.id, .owner.id'` and update
  `github_repository`, `github_repository_id` and `github_repository_owner_id`.
- The deploy jobs name a GitHub environment (`production` for `main`, `staging`
  for `staging`), which changes the OIDC token's `sub` claim. Neither provider
  reads `sub`: the conditions use `repository_id`, `repository_owner_id`,
  `ref`, `workflow_ref` and `event_name`, and the deployer binding uses
  `attribute.repository_id`.
- The production deployer holds one project-level role, `roles/aiplatform.user`
  (#81), to deploy the checklist agent; it exists while
  `checklist_agent_production` is true (the default). Agent Engine has no
  resource-level grant for creating a reasoning engine, so the role also
  reaches every other Vertex AI resource in the project, staging's agents
  included. Its other grants are: Cloud Run
  Developer on the three OnboardAi services and on the migration job
  `onboardai-db-migrate`, Logs View Accessor on the log view
  `onboardai-db-migrate` (that job's log entries only), Artifact Registry Writer on
  the `onboardai` repository, Service Account User on the three runtime
  accounts, and nothing else. It cannot create services, change IAM policies,
  read any other log, or touch any other Cloud Run service in the project.
  The staging deployer holds the same project-level role, also for the intake
  agent (see [The intake agent (staging)](#the-intake-agent-staging)).
- Production has no API key. Its only Secret Manager secrets are the accounts
  database's password and `DATABASE_URL` (#45), generated by Terraform and
  written with write-only arguments, so neither is in state, the repository
  or a log. `onboardai-api-run` holds `roles/aiplatform.user`,
  `roles/datastore.user` (IAM condition: the `(default)` database only) and
  `roles/cloudsql.client` (IAM condition: `onboardai-db` only) on the project,
  `roles/discoveryengine.viewer` (includes
  `discoveryengine.servingConfigs.search`) on the engine `onboardai-search`
  only, and Secret Accessor on `onboardai-database-url`. Its project roles are
  the only project-level bindings in this module besides staging's intake
  agent roles; the web and tts accounts and the deployer hold none. The API
  has no access to the documents bucket, staging's database or staging's
  engine.
- Only web is public (#57). The api and tts accept only callers holding Cloud
  Run Invoker on them: web's account on the api, the api's account on tts,
  staging's intake agent on the staging api, and the stack's deployer, whose
  Cloud Run Developer role includes the invoke permission (the smoke test uses
  it for `POST /mcp`; the deployer is reachable only from the deploy
  workflow). See [Private api and tts](#private-api-and-tts).
- The document reconciliation job (#79) runs as `onboardai-api-run` and adds no
  grant. Its trigger account `onboardai-docs-trigger` has no key and holds
  `roles/run.invoker` on that job only; the deployer holds
  `roles/run.developer` on it, as on the migration job. Cloud Scheduler mints
  the trigger account's OAuth token through its own service agent, which holds
  the token-creation permission for service accounts of the same project, so
  the account needs no further grant.
- The repository is public, so its Actions logs are public too, and they show
  the project ID and the service URLs. Neither is a credential. To hide the
  project ID, make `GCP_PROJECT_ID` a repository secret instead and change
  `vars.GCP_PROJECT_ID` to `secrets.GCP_PROJECT_ID` in `deploy.yml`.

## Tear down

Destroy is blocked on purpose while `deletion_protection` is `true` (the
default):

- The Cloud Run services have `deletion_protection = true`.
- The data store and the engine have `deletion_policy = "PREVENT"`. Deleting
  the data store deletes the imported documents.
- Firestore has delete protection on and `deletion_policy = "ABANDON"`:
  `terraform destroy` only drops it from state, and the data stays.
- The accounts Cloud SQL instance has deletion protection on in Terraform and
  in Cloud SQL, and its `onboardai` database is only abandoned. The migration
  job has `deletion_protection = true`.
- The documents bucket is never force-destroyed: empty it first.

To tear a stack down, apply once with `-var deletion_protection=false` (review
the plan: it only lifts those guards), empty the bucket, then destroy. For
staging, see [Staging: tear down](#tear-down-staging).

Destroy leaves the APIs on. A deleted workload identity pool keeps its ID
reserved for 30 days; to recreate it within that time, undelete the pool
instead.

## Staging

A second stack in the same project, built from the same code with
`environment = "staging"`, in its own workspace and state. `main` deploys
production and `staging` deploys staging, through the same
`.github/workflows/deploy.yml`.

| Resource                   | Production                                        | Staging                                                                   |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Cloud Run services         | `onboardai-web`, `onboardai-api`, `onboardai-tts` | `onboardai-web-staging`, `onboardai-api-staging`, `onboardai-tts-staging` |
| Runtime service accounts   | `onboardai-<service>-run`                         | `onboardai-<service>-run-staging`                                         |
| Deployer service account   | `onboardai-deployer`                              | `onboardai-deployer-staging`                                              |
| Artifact Registry          | `onboardai`                                       | `onboardai-staging`                                                       |
| WIF pool / provider        | `onboardai-github` / `github-actions`             | `onboardai-github-staging` / `github-actions-staging`                     |
| Documents bucket           | `<project>-onboardai-docs`                        | `<project>-onboardai-docs-staging`                                        |
| Data store / engine        | `onboardai-docs` / `onboardai-search`             | `onboardai-docs-staging` / `onboardai-search-staging`                     |
| Firestore database         | `(default)`                                       | `onboardai-staging` (a project has one `(default)`)                       |
| Alerts and uptime checks   | `OnboardAi: ...`                                  | `OnboardAi [staging]: ...`, watching the staging services                 |
| Labels                     | `app`, `managed-by`, `component`                  | the same plus `environment = staging`                                     |
| Deploys from / GitHub vars | `main` / repository variables                     | `staging` / variables of the GitHub environment `staging`                 |

Staging has production's shape: the same Cloud Run settings (one set of
`*_RUN_FLAGS` serves both), Enterprise search with the same document
processing, Native-mode Firestore (point-in-time recovery off), the same bucket
and repository policies, and the same alerts and uptime checks. API enablement
and the Discovery Engine service agent are project-wide and stay in
production's state; staging relies on them and never manages them.

### Production's one-time state move

Staging skips the Discovery Engine service agent, so that resource now has a
`count`, and a `moved` block in `vertex_ai_search.tf` renames it in
production's state. The first production plan after this change shows only:

```text
# google_project_service_identity.discovery_engine has moved to google_project_service_identity.discovery_engine[0]
Plan: 0 to add, 0 to change, 0 to destroy.
```

Applying that plan rewrites production's state and calls no Google API. After
it, `terraform plan` shows `No changes` again. Until it is applied, every
production plan shows the move (`-detailed-exitcode` returns 2).

### Create the staging stack

```sh
cd terraform/onboardai
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)   # or ADC
cat > staging.tfvars <<'EOF'              # gitignored (*.tfvars); never commit it
environment  = "staging"
project_id   = "project-65a9b676-abdb-4393-bc1"
alert_emails = ["someone@example.com"]
EOF
terraform init
terraform workspace select -or-create staging   # first time: writes an empty onboardai/staging.tfstate
terraform plan -var-file=staging.tfvars -out=staging.tfplan   # review: everything is "to add", every name ends in -staging
terraform apply staging.tfplan
terraform workspace select default              # back to production
```

`terraform.tfvars` (production's inputs) is loaded in every workspace;
`staging.tfvars` overrides it. Forgetting `-var-file=staging.tfvars` in the
`staging` workspace, or passing it in `default`, fails the plan at the
workspace guard before anything is planned.

Then upload documents on the staging app's Company Documentation page as in
step 2. `terraform output -raw docs_bucket_name` prints the staging bucket and
`terraform output -raw docs_reconcile_run_command` the command that checks the
staging bucket, database and index against each other.

### Set up GitHub for staging

In the `staging` workspace:

```sh
terraform output -raw github_environment_commands   # creates environment "staging", deployable from the staging branch only
terraform output -raw github_variable_commands      # gh variable set ... --env staging (all nine variables)
```

Review the printed lines, then run them (gh with admin rights on the
repository). Production's repository variables do not change. The deploy jobs
of a `staging` run read `vars.*` from the `staging` environment, which takes
precedence over the repository variables of the same name.

The first deploy from `main` after this change makes GitHub create an empty
`production` environment, because the deploy jobs now name one. With no
variables of its own it falls back to the repository variables, as before. You
can restrict it to the `main` branch or add reviewers in the repository
settings later.

### Deploy staging

Push to `staging` (merging a pull request into it does that), or run it by
hand:

```sh
gh workflow run deploy.yml --repo UniVRse-Team/univrse-onboardai --ref staging
```

The run checks that the staging deployer, provider, engine and database all
end in `-staging`, pushes to `onboardai-staging`, deploys
`onboardai-<service>-staging` and smoke-tests the staging URLs
(`terraform output service_urls` in the `staging` workspace). Staging and
production deploys never queue behind each other. CI runs on pull requests
into, and pushes to, both branches.

### Isolation inside the shared project

The two api accounts are limited to their own data the same way (production
since #56), so neither reaches the other stack's database or engine.

- **Deploy identity.** The staging pool's provider accepts only the deploy
  workflow on `refs/heads/staging` (repository and owner pinned by numeric ID,
  push or workflow_dispatch). `onboardai-deployer-staging` holds Cloud Run
  Developer on the three staging services, Artifact Registry Writer on
  `onboardai-staging` and Service Account User on the three staging runtime
  accounts: nothing on production. For the migrations (#45) it holds Cloud
  Run Developer on `onboardai-db-migrate-staging` and Logs View Accessor on the
  log view `onboardai-db-migrate-staging`. For the intake agent (#30) it also
  holds Service Account User on `onboardai-intake-staging`, and its one
  project-level role,
  `roles/aiplatform.user`, because Agent Engine has no resource-level grant
  for creating a reasoning engine. That role also reaches any other Vertex AI
  resource in the project, production's included; the staging deployer is
  reachable only from the deploy workflow on the `staging` branch.
- **Cloud Run invokers (#57).** Staging's api and tts accept only staging's
  callers: `onboardai-web-run-staging` on `onboardai-api-staging`,
  `onboardai-api-run-staging` on `onboardai-tts-staging`, and
  `onboardai-intake-staging` on `onboardai-api-staging`. No staging account
  holds an invoker grant on a production service, and the other way round.
- **Firestore.** `onboardai-api-run-staging` holds `roles/datastore.user` on the
  project with an IAM condition, `resource.name` equal to
  `projects/<project>/databases/onboardai-staging` (by project ID or number).
  Firestore evaluates database-level IAM conditions, so it cannot read or
  write `(default)`. `onboardai-api-run` holds the same role with the
  condition on `projects/<project>/databases/(default)` (title
  `(default) database only`), so it cannot read or write `onboardai-staging`.
- **Vertex AI Search.** Neither api account holds a Discovery Engine role on
  the project. Each holds `roles/discoveryengine.viewer` on its own engine
  only (`onboardai-search-staging`, `onboardai-search`; engines carry their own
  IAM policy), so neither can search the other's engine or read its data
  store. If engine-level grants were not honoured for search, search would
  fail with 403 and never reach the other stack's data.
- **Gemini.** `roles/aiplatform.user` on the project, unconditioned, in both
  stacks: Vertex AI has no narrower grant. The same role lets staging's api
  query the intake agent on Agent Engine.
- **Cloud SQL.** `roles/cloudsql.client` on the project with an IAM condition,
  `resource.name` equal to `projects/<project>/instances/onboardai-db-staging`
  and `resource.type` `sqladmin.googleapis.com/Instance`, so it can connect to
  the staging accounts instance and no other.

After an apply, each API's project-level grants can be checked without
changing anything (`onboardai-api-run@` for production):

```sh
gcloud projects get-iam-policy project-65a9b676-abdb-4393-bc1 \
  --flatten=bindings --filter="bindings.members:onboardai-api-run-staging@" \
  --format="table(bindings.role, bindings.condition.expression)"
```

### Production follow-ups

- Done in #56: `onboardai-api-run` held `roles/datastore.user` and
  `roles/discoveryengine.viewer` on the whole project, unconditioned, so it
  could reach staging's database and search staging's engine. It is now
  narrowed like staging's api (a condition on `(default)`, a grant on
  `onboardai-search`); see [Order of the #56 change](#order-of-the-56-change).
- The GitHub environment `production` has no protection rules; consider
  limiting it to `main`.

### Order of the #56 change

Staging's plan only adds its two uptime checks and their alert; its IAM and
Firestore do not change. Production's plan replaces `roles/datastore.user`
with the conditioned binding (`+/-`: the new binding is created before the old
one is removed, both in the project policy), adds the engine grant, removes
the project-level `roles/discoveryengine.viewer`, turns on Firestore
point-in-time recovery (an in-place update) and adds the uptime checks and
their alert.

Terraform cannot order the removal of the project-level search role after the
creation of the engine grant: the role leaves a `for_each` map, and such a
destroy never waits for another resource's create (adding `depends_on` makes
it run first). The engine grant also sits in a different IAM policy, which
takes effect on its own schedule. So production is applied in two steps, and
the api can search throughout:

1. Apply the `staging` workspace (plan reviewed by the user; 3 to add). Within
   about 10 minutes both `OnboardAi [staging]` checks show as passing under
   Monitoring, Uptime checks.
2. Production, step 1, the engine grant alone (plan: 1 to add):

   ```sh
   terraform apply -target='google_discovery_engine_search_engine_iam_member.api_searches_engine[0]'
   ```

3. Wait at least 7 minutes: Google documents that an IAM change usually takes
   effect within 2 minutes but can take 7 or more.
4. Production, step 2, everything else (plan: 4 to add, 1 to change, 2 to
   destroy): `terraform apply`.
5. Check production: a chat question answered from the company documents
   (search), a signed-in chat that saves and reloads (Firestore), and the next
   deploy's migration step (the migration job uses the same Firestore grant).
   If Firestore answers `PERMISSION_DENIED`, restore the old binding at once
   with
   `gcloud projects add-iam-policy-binding project-65a9b676-abdb-4393-bc1 --member=serviceAccount:onboardai-api-run@project-65a9b676-abdb-4393-bc1.iam.gserviceaccount.com --role=roles/datastore.user --condition=None`
   and investigate before the next apply.

### The intake agent (staging)

The employee form intake agent (#27) runs on staging only (#30). Its resources
are gated on `local.intake_agent` (`environment.tf`): staging, never
production. The accounts database it relies on runs in both stacks (see
[Employee accounts and database migrations](#employee-accounts-and-database-migrations)).

| Resource       | Staging name                                     | Settings                                                                                                             |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Secret         | `onboardai-intake-mcp-token-staging`             | Replicated in `asia-southeast1` only; written with a write-only argument, never in state                             |
| Agent identity | `onboardai-intake-staging`                       | Runtime service account of the intake agent on Vertex AI Agent Engine                                                |
| Firestore TTL  | `employeeImports.purgeAt` in `onboardai-staging` | Expired draft imports are deleted (Firestore usually does it within a day); the field's single-field indexes are off |

| Account                      | Gets                                       | On                                                                     |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `onboardai-api-run-staging`  | Secret Manager Secret Accessor             | `onboardai-intake-mcp-token-staging`                                   |
| `onboardai-intake-staging`   | `roles/aiplatform.user` (Gemini)           | The project                                                            |
|                              | Secret Manager Secret Accessor             | `onboardai-intake-mcp-token-staging`                                   |
|                              | Cloud Run Invoker (#57)                    | `onboardai-api-staging`: its `/mcp` calls                              |
| `onboardai-deployer-staging` | `roles/aiplatform.user` (deploy the agent) | The project: Agent Engine has no resource-level grant for creating one |
|                              | Service Account User                       | `onboardai-intake-staging`                                             |

The api queries the agent and deletes its sessions with the
`roles/aiplatform.user` it already holds.

**Deploy.** Job `agent` runs after the image builds and decides first:

- on `main`, it skips with a notice;
- on `staging`, it skips with a notice while `package.json` has no
  `intake-agent:deploy` script (#27 not merged yet);
- otherwise `npm run intake-agent:deploy` (#27) creates or updates the
  reasoning engine `OnboardAi employee form intake (staging)` (its display
  name, the key the command creates or updates by) in `INTAKE_AGENT_LOCATION`
  (`deploy.yml`, equal to `var.intake_agent_location`, default
  `asia-southeast1`), running as `onboardai-intake-staging`, with the api's
  `/mcp` URL and the token's secret ID. Its last output line is the engine's
  resource name.

A skip never fails the deploy. When the agent was deployed, the api also gets
`INTAKE_AGENT_ENGINE` and `INTAKE_MCP_TOKEN` (a Secret Manager reference), and
the smoke test also checks that `GET /api/config` reports `employeeImport:
true` and that `POST /mcp` without the MCP token gets the api's own 401 (its
JSON-RPC error, not Cloud Run's page). That request is the smoke test's one
direct call to the api, so it carries the deployer's ID token for the api
(`google-github-actions/auth` with `token_format: id_token`, masked, no
credentials file). Otherwise the api deploys without them and those two
checks are skipped.

**The agent and the private api (#57, for #27).** The api is private, so the
agent's MCP client must send an ID token of `onboardai-intake-staging` (from
Agent Engine's metadata server, audience the api's origin, the `--mcp-url`
without `/mcp`) in `X-Serverless-Authorization`, next to the
`Authorization: Bearer <INTAKE_MCP_TOKEN>` it sends today. Without it, Cloud
Run answers 403 before the api sees the request.

**Rotate the token.** Raise `intake_mcp_token_version` by one in
`staging.tfvars`, plan, apply, then run the staging deploy again: the api and
the agent both read the latest version.

### The checklist agent (#51) and Gemini voice (#52)

The onboarding checklist agent runs on Vertex AI Agent Engine like the intake
agent, in the same region (`deploy.yml` `INTAKE_AGENT_LOCATION`, equal to
`var.intake_agent_location`). `checklist_agent.tf` creates its runtime account
`onboardai-checklist<suffix>` with `roles/aiplatform.user` and
`roles/datastore.user` (limited by an IAM condition to the environment's own
Firestore database), and lets the deployer act as it. Staging always has them.
Production has them too: `checklist_agent_production` defaults to `true` (#81),
so a plan from `main` creates them; set it to `false` to remove them. After the
apply, set the GitHub variable `CHECKLIST_AGENT_ENABLED=true` on the
`production` environment, which is what makes the deploy job create the agent. The `checklist_agent` job of `deploy.yml` deploys the agent with
`npm run checklist-agent:deploy` and hands the engine to the api as
`CHECKLIST_AGENT_ENGINE`; it skips with a notice while the commit has no such
script, or on production while the variable is not true.

In production the same variable also gives the deployer
(`onboardai-deployer`) `roles/aiplatform.user` on the project, because Agent
Engine has no resource-level grant for creating a reasoning engine (see
[Security](#security)).

The api speaks with Gemini TTS using its own `roles/aiplatform.user`; no new
grant. `deploy.yml` passes `VOICE_PROVIDER` (default `gemini`),
`GEMINI_TTS_MODEL` (`gemini-3.8-flash-tts`), `GEMINI_TTS_LOCATION` (`global`)
and, when the GitHub variable `GEMINI_TTS_VOICE` is set, that voice. Set
`VOICE_PROVIDER=kokoro` to fall back to the tts service.

### Cost of staging

Every staging service scales to zero, so an idle staging stack costs little.
What it adds:

- **Vertex AI Search, Enterprise tier**: per 1,000 search queries, plus index
  storage for the imported documents. Same tier as production for parity; the
  largest variable cost.
- **Firestore named database**: the free tier applies to `(default)` only, so
  every read, write and stored GiB of `onboardai-staging` is billed.
- **Gemini** calls from staging chats, at production's rates.
- **Cloud Run**: request time of staging deploys, smoke tests and use
  (request-based billing, no minimum instances).
- **Artifact Registry**: up to 5 versions of each of the three images
  (`images_to_keep`), roughly as much storage as production's.
- **Cloud Storage**: the staging documents bucket, with 30 days of old
  versions.
- **Cloud Monitoring**: three more alert conditions, and two uptime checks
  (51,840 executions a month, inside the free 1 million together with
  production's).
- **Cloud SQL** (`onboardai-db-staging`, runs all month): about USD 13 a
  month in `asia-southeast1`: `db-f1-micro` USD 0.0147 an hour (USD 10.73 for
  730 hours), 10 GiB SSD at USD 0.238 per GiB-month (USD 2.38), and backups at
  USD 0.112 per GiB-month of backup data (cents for a small database). The
  public IPv4 address is billed only while the instance is stopped.
- **Agent Engine** (the intake agent; the deploy command sets 1 vCPU, 2 GiB,
  0 to 2 instances, concurrency 3): nothing while idle, since it scales to
  zero (and Agent Engine bills no idle time today in any case; its resource
  controls are in Preview). Per import, about USD 0.01 to 0.02: one minute of
  agent time is USD 0.0017 (USD 0.085 per vCPU-hour, USD 0.009 per GiB-hour,
  after a free 50 vCPU-hours and 100 GiB-hours a month, about 3,000 such
  minutes), plus Gemini 3.5 Flash-Lite tokens (USD 0.30 per million in, 2.50
  per million out; about USD 0.01 for a form). The first import after an idle
  spell waits for a cold start.
- **Secret Manager**: three active secret versions (USD 0.06 each a month after
  six free) and accesses at USD 0.03 per 10,000 after 10,000 free.

### Tear down staging

In the `staging` workspace:

```sh
terraform apply -var-file=staging.tfvars -var deletion_protection=false   # lifts the guards only; review the plan
gcloud storage rm --all-versions "gs://$(terraform output -raw docs_bucket_name)/**"
terraform destroy -var-file=staging.tfvars -var deletion_protection=false
terraform workspace select default
terraform workspace delete staging          # deletes onboardai/staging.tfstate
```

Destroy deletes the staging database, data store (with its documents) and
engine, the accounts Cloud SQL instance (its backups go with it) and the
staging secrets, and never touches production or the shared APIs (the Cloud
SQL Admin API stays on). A deleted Cloud SQL instance's name cannot be reused
for up to a week. The pool
`onboardai-github-staging` stays reserved for 30 days after deletion. Remove
the GitHub environment `staging` by hand if staging is gone for good.
