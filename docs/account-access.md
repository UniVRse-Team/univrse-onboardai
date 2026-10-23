# Account access

The welcome page at `/` or `/login` offers Employee and HR sign-in.

There is one way in: **accounts** (issue #23), real HR and employee sign-in, served by the API
when `DATABASE_URL` is set. HR creates every employee account; there is no public sign-up.

**Guest access was removed (issue #55).** "Continue without an account" is gone, the guest
workspace API (`/api/guest-workspace/*`) is no longer served (a JSON `404 NOT_FOUND`), and chat,
saved conversations, voice and tts need a signed-in account in every `AI_MODE` (see
[Account-owned chats](#account-owned-chats)). There is no anonymous `alya_session` cookie any more.
Before promoting a release, make sure an HR account exists in that environment: without guest
access nobody else can get in.

The onboarding footprint, quick questions, first-day details, support requests, team insights
and knowledge gaps are described in [Onboarding journey and support](onboarding-journey.md).

## Roles

| Role       | Created by                                             | Can                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hr`       | `npm run hr:create` on the server (no forced change)   | Everything an employee can, plus list, read, create, edit and delete employees, reset their passwords, disable or enable them, verify onboarding paperwork, enter first-day details, work confirmed support requests, read team insights and knowledge gaps (never named per-employee summaries) and manage departments and prefixes in Settings and upload, replace (with a new version) and remove the company documentation files. HR accounts are not editable or deletable through the API; `npm run hr:reset-password` recovers one. |
| `employee` | HR; the server assigns the ID and a temporary password | Change their own password, read their own profile, keep saved chats that follow them across browsers, work through their onboarding footprint and ask HR to follow up on an answer.                                                                                                                                                                                                                                                                                                                                                        |

An account created or reset by HR must choose a new password before anything else works.

## Where the data lives

| Store                                                              | Holds                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL (`DATABASE_URL`)                                        | `accounts`, `sessions` and `account_events`: IDs, password hashes, roles, status, sign-in state, audit.                                                  |
| Firestore `employeeProfiles/{accountId}`                           | Each employee's personal profile, written by HR.                                                                                                         |
| Firestore `conversations`, `supportPreferences`, `chatCheckpoints` | A signed-in account's saved chats, support observations and LangGraph state, owned by `account:<accountId>` (see [Chat and memory](chat-and-memory.md)). |
| Firestore `employeeImports/{importId}`                             | Short-lived employee form import drafts (issue #27), which can name accounts.                                                                            |
| Firestore `companyDocuments/{id}`                                  | The company-wide documentation files that HR uploads (see [Company Documentation](#company-documentation)).                                              |

PostgreSQL never holds profile values; Firestore never holds passwords or sessions. The
onboarding journey's Firestore collections (`onboardingTemplates`, `onboardingProgress`,
`employeeFirstDay`, `supportRequests`, `knowledgeGaps`, `config/quickQuestions`) are described
in [Onboarding journey and support](onboarding-journey.md).

### PostgreSQL tables (`server/migrations/*.sql`)

- **accounts**: `id` (uuid), `username` (3–32 of `A-Z a-z 0-9 . _ -`, unique regardless of
  case), `password_hash`, `role` (`hr` | `employee`), `status` (`active` | `disabled`),
  `must_change_password`, `failed_attempts`, `locked_until`, `created_at`, `updated_at`,
  `last_sign_in_at`, `created_by`.
- **sessions**: `token_hash` (SHA-256 of the cookie token), `account_id`, `created_at`, `expires_at`.
- **employee_id_counters** (`003_employee_id_counters.sql`): `prefix` (two to four capital
  letters since `004`), `last_number` (the last number handed out for that prefix). See
  [Employee IDs and temporary passwords](#employee-ids-and-temporary-passwords).
- **departments** (`004_departments.sql`): `id` (uuid), `name`, `prefix`, `archived`,
  `created_at`, `updated_at`; unique on `lower(name)` and on `prefix`. Seeded with the six
  first departments. See [Departments (HR Settings)](#departments-hr-settings).
- **account_events**: `actor_id`, `target_id`, `target_label`, `detail` (`jsonb`, department
  events only), `action`, `created_at`. Actions:
  `hr_account_created`, `employee_created`, `profile_updated`, `password_reset`,
  `account_disabled`, `account_enabled`, `password_changed`, `signed_in`, `account_locked`,
  `hr_password_reset` (by `npm run hr:reset-password`, no actor), `employee_deleted`,
  `department_created`, `department_updated`, `department_archived`, `department_restored`.
  No secrets or profile values. `target_id` becomes `NULL` when its account is deleted, so
  deleting an employee writes the account's username (its Employee ID) into `target_label` on
  every event about it, including `employee_deleted` (`002_account_event_labels.sql`).

Migrations are plain SQL files run by `npm run db:migrate`, in name order, each once, each in
its own transaction, and recorded in `schema_migrations`. Running it again changes nothing.
A file whose name does not match `NNN_snake_name.sql` is never run, so `npm run db:migrations:check`
(no database needed) fails on it and on two files sharing a number.

`npm run db:migrate` also runs the Firestore migrations in `server/migrations/firestore/`
(`NNN_snake_name.mjs`, each exporting `up({ firestore, log })`; format, idempotency rules and the
locking design are in that folder's `README.md`). Applied files are recorded in the Firestore
collection `schema_migrations` (document id = file name). `MIGRATION_TARGETS` (comma-separated
`sql`, `firestore`) selects what runs, always sql first: a listed target whose variable
(`DATABASE_URL` / `FIRESTORE_DATABASE_ID`) is missing, or an unknown name, exits 1 before any
database is touched. Unset runs every configured target (local development). Output is
`[sql] Applied: 005_x.sql`, `[firestore] Already applied: 001_x.mjs` and a last line
`Migrations finished: sql 1 applied, 4 already applied; firestore 0 applied, 1 already applied.`
A failure prints `Migration stopped: [<target>] <reason>` on stderr, exits 1, and later targets do
not run. No line contains a URL, password or document data. `DATABASE_URL` may be the Cloud SQL
socket form `postgresql://USER:PASS@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE`.

### Employee profile (`employeeProfiles/{accountId}`)

Every field is text, stored trimmed, `''` when empty. `job.fullName` and `job.department` are
required. Unknown fields are rejected. Values are single-line (no control characters).

`job.department` is the name of an **active** department in the `departments` table (exactly,
after trimming; `GET /api/hr/departments` lists them). Missing or empty is `required`; anything
else is `invalid_department`. An edit (`PUT …/profile`) may also keep exactly the department
already stored for that employee, so a profile saved before the list existed (free text, or
empty) or with a department since archived stays editable without a new choice; changing it
means choosing an active one. The department decides the Employee ID prefix at creation only:
editing it later never changes the ID.

| Group              | Field (maximum characters)                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job`              | `fullName` (120, required), `preferredName` (80), `jobTitle` (120), `department` (active department, required), `startDate` (`YYYY-MM-DD`, a real date), `manager` (120), `track` (`employee`, `intern` or `contractor`, any letter case, stored in lower case; empty means `employee`) |
| `contact`          | `workEmail` (254, email), `personalEmail` (254, email), `mobileNumber` (32, digits, spaces, `+ - ( ) .`)                                                                                                                                                                                |
| `emergencyContact` | `name` (120), `relationship` (60), `phoneNumber` (32, as `mobileNumber`)                                                                                                                                                                                                                |
| `homeAddress`      | `line1` (200), `line2` (200), `city` (100), `state` (100), `postcode` (20), `country` (100)                                                                                                                                                                                             |

The server adds `updatedAt` (ISO 8601) and `updatedBy` (the HR account ID). Log lines
about profiles name the operation and Firestore status only, never values.

## Security rules

- **Passwords**: Node's built-in scrypt (N=32768, r=8, p=1, 64-byte key) with a random
  16-byte salt per password, stored as `scrypt$n=…,r=…,p=…$<salt>$<key>`, compared with
  `timingSafeEqual`. 8–200 characters, not equal to the ID (ignoring case); a new
  password must differ from the current one. Plaintext is never logged, returned or stored.
- **Failed sign-ins** all return the same `401 SIGN_IN_FAILED`: unknown ID, wrong password,
  disabled or locked. Each costs one scrypt check (against a dummy hash when the ID is
  unknown) and the same database statements.
- **Lockout**: five consecutive wrong passwords lock the account for 15 minutes; a
  successful sign-in resets the count, and after a lock ends the count starts again. A
  wrong current password on the change-password form counts too. A lock blocks new
  sign-ins only: sessions that already exist keep working, so wrong guesses by someone
  else cannot sign the account holder out, and reaching the lock from the change-password
  form keeps that session. While locked, the change-password form checks no password and
  answers `429 ACCOUNT_LOCKED`, so a session cannot be used to keep guessing. An HR
  password reset (API) or `npm run hr:reset-password` clears a lock.
- **Sessions**: a 32-byte random token in the `onboardai_account` cookie (HttpOnly,
  SameSite=Strict, Path `/api`, Secure on HTTPS or with `NODE_ENV=production`). PostgreSQL
  stores only its SHA-256. A session ends 12 hours after sign-in. Signing in replaces the
  browser's previous session; changing the password ends every session of the account and
  issues a new one; a reset or disable ends all of that employee's sessions; signing out
  deletes the session on the server.
- **Requests**: every account and HR route checks the browser's `Origin` like the saved-chat
  routes, is never cached, and sits behind the API's limit of 60 POST and PATCH requests per
  minute per IP.
- **Start-up guard**: with `DATABASE_URL` set the server refuses to start unless
  `FIRESTORE_DATABASE_ID` and a project are set and, outside Cloud Run (`K_SERVICE` unset),
  `FIRESTORE_EMULATOR_HOST` is set. Local test personal data therefore never reaches a cloud
  Firestore database.

## Local setup in Docker (one command)

`npm run local` builds and starts the whole local stack in Docker (PostgreSQL, the Firestore
emulator, the API, the voice service, the onboarding checklist agent and the website) and prints
the HR login. It starts Docker Desktop on macOS if it is not running, waits for it (up to 120 s),
resolves `GOOGLE_CLOUD_PROJECT` (the environment, then `.env`, then
`gcloud config get-value project`; without one it stops with "GOOGLE_CLOUD_PROJECT is not set: add
it to .env (Gemini on Vertex AI needs it)"), passes it to compose, then runs
`docker compose build` and `docker compose up -d --wait web`.

The one-shot `setup` service runs `node server/local-setup.mjs` in the api image. It refuses to
run if `K_SERVICE` is set, `FIRESTORE_EMULATOR_HOST` is missing or the `DATABASE_URL` host is
not `localhost`, `127.0.0.1`, `::1` or `postgres`. It waits up to 60 s for PostgreSQL, applies
the migrations and makes sure the local HR account (`LOCAL_HR_ID`, default `HR-0001`) exists:

- No such account: it creates an HR account with a generated password (no forced change) and
  writes `.cache/local-stack/hr-login.json` (mode 0600; `hrId`, `password`, `appUrl`,
  `emulatorUiUrl`, `updatedAt`).
- Account and a stored password that still works: reused, nothing changes.
- Account but no usable stored password (for example an account made with `hr:create`): nothing
  changes. The summary says the password is not stored here and suggests `npm run local:reset-hr`.
- Other accounts are never touched.

| Command                  | What it does                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run local`          | Build, start and print the summary (App, HR ID, HR password, Emulator UI, Postgres)                                          |
| `npm run local:reset-hr` | `docker compose run --rm -e LOCAL_HR_RESET=1 setup`: new generated password for the HR account, lock cleared, sessions ended |
| `npm run local:down`     | `docker compose stop web api tts checklist-agent`. The databases keep running; nothing is removed                            |
| `npm run local:logs`     | `docker compose logs -f web api tts checklist-agent setup`                                                                   |

`npm run local` builds the Firestore emulator image only the first time. Run it from one checkout. Starting it from different folders makes Docker Compose
recreate the Firestore container (a fix is under way).

Firestore data is auto-saved: a sidecar exports the emulator's data every minute, so a Docker
crash loses at most about a minute of Firestore data.

Gemini autofill needs your Google login. The api container mounts your Application Default
Credentials read-only (`GOOGLE_APPLICATION_CREDENTIALS`, else
`~/.config/gcloud/application_default_credentials.json`; the file is only checked for, never
read or copied). Without it the stack still starts with an empty placeholder
(`.cache/local-stack/no-adc.json`), autofill is off and the summary says to run
`gcloud auth application-default login`, then `npm run local` again.

The login file holds local test data only and is ignored by Git (`.cache/`).

## Local setup

The Docker stack in `compose.yaml` runs PostgreSQL (127.0.0.1:5442) and the Firebase
Firestore emulator (127.0.0.1:8681, project `demo-onboardai`; Emulator UI at
http://127.0.0.1:4000).

1. Add to `.env` (see `.env.example`):

   ```
   DATABASE_URL=postgresql://onboardai:onboardai_local@127.0.0.1:5442/onboardai
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8681
   FIRESTORE_PROJECT_ID=demo-onboardai
   FIRESTORE_DATABASE_ID=(default)
   ```

   `FIRESTORE_PROJECT_ID` keeps `GOOGLE_CLOUD_PROJECT` free for Vertex AI. The emulator keeps
   data only for `demo-onboardai`.

2. `npm run db:up` starts the stack and waits until it is healthy.
3. `npm run db:migrate` creates the tables (safe to repeat).
4. `npm run hr:create` creates the first HR account. In a terminal it asks for the HR ID and
   the password twice without showing the password. It can be scripted with piped lines
   (ID, password, and optionally the password again); it never takes the password as an
   argument:

   ```bash
   printf '%s\n%s\n%s\n' HR-0001 "$PASSWORD" "$PASSWORD" | npm run hr:create
   ```

5. `npm run dev`. The start-up log prints `Accounts: on (…)` and where saved chats go.

To recover an HR account (forgotten password or a lock), run `npm run hr:reset-password`.
It takes input the same way as `hr:create`: the HR ID, then the new password twice, never
as arguments. It works on HR accounts only (other IDs get `No HR account with that ID.`;
employees are reset by HR through the API). It applies the same password rules, sets the
password with no forced change, clears failed attempts and any lock, ends every session of
that account and records an `hr_password_reset` event with no actor.

Without `DATABASE_URL` the app runs exactly as before and every account route answers
`503 ACCOUNTS_NOT_CONFIGURED`. Database shell: `docker compose exec postgres psql -U onboardai -d onboardai`.

## API contract

JSON in both directions, except the profile autofill upload (raw file bytes). Errors are
`{ "code": "…", "error": "message" }`; `PROFILE_INVALID` adds `fields`. Every route below
answers `Cache-Control: no-store`.

Answers every route can give:

| Status | Code                          | When                                                         |
| ------ | ----------------------------- | ------------------------------------------------------------ |
| 403    | `CROSS_ORIGIN_REJECTED`       | An `Origin` header that is not this site                     |
| 503    | `ACCOUNTS_NOT_CONFIGURED`     | `DATABASE_URL` is not set                                    |
| 503    | `ACCOUNTS_UNAVAILABLE`        | PostgreSQL failed                                            |
| 503    | `PROFILE_STORAGE_UNAVAILABLE` | Firestore failed (routes that touch profiles)                |
| 504    | `PROFILE_STORAGE_TIMEOUT`     | Firestore gave no answer within 10 seconds                   |
| 404    | `NOT_FOUND`                   | No such account route                                        |
| 429    | (no code)                     | More than 60 POST and PATCH requests in a minute from one IP |
| 500    | `ACCOUNT_REQUEST_FAILED`      | Unexpected failure                                           |

Routes that need a session check, in this order:

| Status | Code                       | When                                                                                                                                                                          |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `AUTH_REQUIRED`            | No `onboardai_account` cookie                                                                                                                                                 |
| 401    | `SESSION_EXPIRED`          | The cookie's session has ended (expiry, sign-out, rotation, password change elsewhere, reset, disable, forged). A lock does not end sessions. The response clears the cookie. |
| 403    | `PASSWORD_CHANGE_REQUIRED` | The account must choose a new password first                                                                                                                                  |
| 403    | `HR_ROLE_REQUIRED`         | An HR route and the account is not HR                                                                                                                                         |

Shapes:

```text
SessionAccount  { id, username, role: "hr"|"employee", mustChangePassword: boolean,
                  sessionExpiresAt: ISO 8601 }
EmployeeAccount { id, username, role: "employee", status: "active"|"disabled",
                  mustChangePassword, locked: boolean, lockedUntil: ISO|null,
                  createdAt: ISO, updatedAt: ISO, lastSignInAt: ISO|null }
Profile         { job, contact, emergencyContact, homeAddress  (every field a string),
                  updatedAt: ISO|null, updatedBy: account id|null }
ProfileInput    { job, contact, emergencyContact, homeAddress }  (updatedAt/updatedBy ignored)
ProfileSummary  { fullName, preferredName, jobTitle, department, startDate }
```

| Method and path                                                | Session                         | Request body                                                                                              | Success                                                                                                                                                                  | Errors (besides the tables above)                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-in`                                       | none                            | `{ username, password }`                                                                                  | 200 `{ account: SessionAccount }` and a new cookie                                                                                                                       | 400 `SIGN_IN_INVALID` (missing or non-text fields); 401 `SIGN_IN_FAILED` (any failed sign-in)                                                                                                                     |
| `GET /api/auth/session`                                        | optional; forced change allowed | none                                                                                                      | 200 `{ account: SessionAccount }`, or `{ account: null }` without a cookie                                                                                               | 401 `SESSION_EXPIRED`                                                                                                                                                                                             |
| `POST /api/auth/sign-out`                                      | optional                        | none                                                                                                      | 204, session deleted, cookie cleared                                                                                                                                     | none                                                                                                                                                                                                              |
| `POST /api/auth/password`                                      | any; forced change allowed      | `{ currentPassword, newPassword }`                                                                        | 200 `{ account: SessionAccount }` and a new cookie                                                                                                                       | 400 `PASSWORD_CHANGE_INVALID`, `CURRENT_PASSWORD_INCORRECT` (counts toward the lock), `PASSWORD_REJECTED` (the message says which rule); 429 `ACCOUNT_LOCKED` (locked: no password is checked; the session stays) |
| `GET /api/me/profile`                                          | any                             | none                                                                                                      | 200 `{ profile: Profile \| null }` (null for HR accounts without a profile)                                                                                              |                                                                                                                                                                                                                   |
| `GET /api/me/company-documents`                                | employee                        | none                                                                                                      | 200 `{ documents: [CompanyDocument] }`; see [Employees' company documents](#employees-company-documents-issue-126)                                                       | 403 `EMPLOYEE_ROLE_REQUIRED`; 503 `COMPANY_DOCUMENTS_UNAVAILABLE`                                                                                                                                                 |
| `GET /api/me/company-documents/:id/file`                       | employee                        | none                                                                                                      | 200 the file's bytes (`Cache-Control: private, no-store`); see [Employees' company documents](#employees-company-documents-issue-126)                                    | 403 `EMPLOYEE_ROLE_REQUIRED`; 404 `DOCUMENT_NOT_FOUND`; 503 `COMPANY_DOCUMENTS_UNAVAILABLE`                                                                                                                       |
| `GET /api/hr/employees`                                        | HR                              | none                                                                                                      | 200 `{ employees: [{ account: EmployeeAccount, profile: ProfileSummary \| null, track, onboarding: { percent, waitingOnHr, complete } }] }`, by ID, at most 500          |                                                                                                                                                                                                                   |
| `POST /api/hr/employees`                                       | HR                              | `{ profile: ProfileInput }` (nothing else)                                                                | 201 `{ employee: { account: EmployeeAccount, profile: Profile }, temporaryPassword }`; see [Employee IDs and temporary passwords](#employee-ids-and-temporary-passwords) | 400 `EMPLOYEE_INVALID` (not an object, or any key but `profile`, such as `username` or `temporaryPassword`), `PROFILE_INVALID` (`job.department` `required` or `invalid_department` among them)                   |
| `GET /api/hr/employees/:id`                                    | HR                              | none                                                                                                      | 200 `{ employee: { account, profile: Profile \| null } }`                                                                                                                | 404 `EMPLOYEE_NOT_FOUND` (unknown, not a UUID, or an HR account)                                                                                                                                                  |
| `PUT /api/hr/employees/:id/profile`                            | HR                              | `{ profile: ProfileInput }` (full replacement)                                                            | 200 `{ employee: { account, profile } }`                                                                                                                                 | 400 `PROFILE_INVALID` (`job.department` must be an active department or exactly the stored value); 404 `EMPLOYEE_NOT_FOUND`                                                                                       |
| `POST /api/hr/employees/:id/password`                          | HR                              | `{ temporaryPassword }`                                                                                   | 200 `{ account: EmployeeAccount }`: forced change set, lock cleared, sessions ended                                                                                      | 400 `PASSWORD_REJECTED`; 404 `EMPLOYEE_NOT_FOUND`                                                                                                                                                                 |
| `PUT /api/hr/employees/:id/status`                             | HR                              | `{ status: "active" \| "disabled" }`                                                                      | 200 `{ account: EmployeeAccount }`; disabling ends the sessions                                                                                                          | 400 `STATUS_INVALID`; 404 `EMPLOYEE_NOT_FOUND`                                                                                                                                                                    |
| `POST /api/hr/employees/autofill`                              | HR                              | raw file, see [Profile autofill](#profile-autofill)                                                       | 200 `{ profile: ProfileInput, filled, warnings }`; nothing is saved                                                                                                      | 400 `AUTOFILL_FILE_INVALID`; 413 `AUTOFILL_FILE_TOO_LARGE`; 422 `AUTOFILL_NOTHING_FOUND`; 429 `AUTOFILL_RATE_LIMITED`; 503 `AUTOFILL_NOT_CONFIGURED`, `AUTOFILL_UNAVAILABLE`; 504 `AUTOFILL_TIMEOUT`              |
| `DELETE /api/hr/employees/:id`                                 | HR                              | none                                                                                                      | 204; see [Deleting an employee](#deleting-an-employee)                                                                                                                   | 404 `EMPLOYEE_NOT_FOUND` (unknown, not a UUID, or an HR account); 409 `CHAT_BUSY`; 503 `PROFILE_STORAGE_UNAVAILABLE`, 504 `PROFILE_STORAGE_TIMEOUT` (the account is kept; retry)                                  |
| `GET /api/hr/team-insights`                                    | HR                              | none                                                                                                      | 200 team-level aggregates, only with at least 3 employees with data; see [Team insights](#team-insights-replacing-support-summaries)                                     | 503 `PROFILE_STORAGE_UNAVAILABLE`, 504 `PROFILE_STORAGE_TIMEOUT`                                                                                                                                                  |
| `GET /api/hr/departments`                                      | HR                              | none                                                                                                      | 200 `{ departments: Department[] }`; see [Departments (HR Settings)](#departments-hr-settings)                                                                           | 503 `PROFILE_STORAGE_UNAVAILABLE`, 504 `PROFILE_STORAGE_TIMEOUT`                                                                                                                                                  |
| `POST /api/hr/departments`                                     | HR                              | `{ name, prefix }`                                                                                        | 201 `{ department: Department }`                                                                                                                                         | 400 `DEPARTMENT_INVALID`; 409 `DEPARTMENT_NAME_TAKEN`, `DEPARTMENT_PREFIX_TAKEN`                                                                                                                                  |
| `PATCH /api/hr/departments/:id`                                | HR                              | `{ name?, prefix?, archived? }`                                                                           | 200 `{ department: Department, updatedProfiles }`                                                                                                                        | 400 `DEPARTMENT_INVALID`; 404 `DEPARTMENT_NOT_FOUND`; 409 as POST; 503 `PROFILE_STORAGE_UNAVAILABLE`, 504 `PROFILE_STORAGE_TIMEOUT`                                                                               |
| `GET /api/hr/company-knowledge`                                | HR                              | none                                                                                                      | 200 `KnowledgeSnapshot`; see [Company Documentation](#company-documentation)                                                                                             | 503 `COMPANY_KNOWLEDGE_UNAVAILABLE`, 504 `COMPANY_KNOWLEDGE_TIMEOUT`                                                                                                                                              |
| `POST /api/hr/company-knowledge/documents?category=…[&name=…]` | HR                              | raw file (`application/octet-stream`, `X-File-Name`), see [Company Documentation](#company-documentation) | 201 `{ id, duplicate: false, replaced: null }` or 200 `{ id, duplicate: true, replaced: null }`; `&replaces=<id>`: see [Company Documentation](#company-documentation)   | see [Company Documentation](#company-documentation)                                                                                                                                                               |
| `PATCH /api/hr/company-knowledge/documents/:id`                | HR                              | `{ category }`, see [Company Documentation](#company-documentation)                                       | 200 `{ document }`                                                                                                                                                       | 400 `DOCUMENT_TOPIC_REQUIRED`; 404 `WORKSPACE_DOCUMENT_NOT_FOUND`; 409 `COMPANY_DOCUMENT_DUPLICATE`; 503/504 as above                                                                                             |
| `DELETE /api/hr/company-knowledge/documents/:id`               | HR                              | none                                                                                                      | 204: the document is removed from GCS, Vertex AI Search and Firestore (see [Company Documentation](#company-documentation))                                              | 404 `WORKSPACE_DOCUMENT_NOT_FOUND`; 503 `COMPANY_KNOWLEDGE_UNAVAILABLE`, 504 `COMPANY_KNOWLEDGE_TIMEOUT`                                                                                                          |

`PROFILE_INVALID` example:

```json
{
  "code": "PROFILE_INVALID",
  "error": "Check the profile: extra is not a profile field; job.startDate must be a date in YYYY-MM-DD form.",
  "fields": [
    { "field": "extra", "problem": "unknown" },
    { "field": "job.startDate", "problem": "invalid_date" }
  ]
}
```

`problem` is one of `required`, `unknown`, `not_object`, `not_text`, `too_long`,
`invalid_characters`, `invalid_email`, `invalid_date`, `invalid_phone`,
`invalid_department`; `field` is `profile` when the profile itself is not an object.

### Employee IDs and temporary passwords

HR never types an Employee ID or a temporary password (issue #34). Creating an employee:

```text
POST /api/hr/employees   { profile: ProfileInput }
201 { employee: { account: EmployeeAccount, profile: Profile },
      temporaryPassword: string }      account.mustChangePassword is true
```

- **The ID** is the department's prefix and the next number for that prefix, at least four
  digits: `PE-0001`, `PE-0002`, … `PE-9999`, `PE-10000`.

  The prefix (two to four capital letters, never `HR`) belongs to the department in the
  `departments` table; the first six are `PE`, `CS`, `SM`, `FN`, `PC` and `OF`. HR adds
  departments and changes prefixes in Settings (next section). Only an active department can be
  chosen for a new hire.

- **Numbering** (`employee_id_counters`, one row per prefix): the number is taken inside the
  create transaction. The first creation for a prefix adds its row, starting after the highest
  existing username with that prefix (any role, any letter case, `PREFIX-` and 1–9 digits), so
  an existing `PE-0007` gives `PE-0008`; every later creation also skips past any such username
  made outside the counter. The counter row stays locked until the commit, so concurrent creates
  for one prefix get distinct, consecutive numbers. Numbers are never handed out twice: deleting
  an employee does not give the number back, and neither does a failed creation (a gap). If the
  profile write or the account insert fails, the transaction rolls back to a savepoint taken
  after the allocation and commits the counter alone; only a database failure undoes the
  allocation as well. In the unlikely case the ID is taken anyway (an account made outside the
  counter at the same moment), the next number is tried, three times at most, then
  `503 ACCOUNTS_UNAVAILABLE`.
- **The temporary password** is generated by the server with the same generator as the local HR
  login (`generatePassword` in `server/password-hashing.mjs`): four groups of five characters
  from `a–z` and `2–9` without look-alikes (`i`, `l`, `o`, `0`, `1`), such as
  `k3fmx-9qa2p-7hwze-c4ntr` (about 99 bits). It meets the password rules against its ID. It
  appears only in this `201` response (`Cache-Control: no-store`): PostgreSQL stores its scrypt
  hash, nothing logs it, and no other route returns it. The employee must change it at first
  sign-in. A lost temporary password is replaced with the HR reset
  (`POST /api/hr/employees/:id/password`), where HR still types the new temporary password.
- **Consistent across both stores**: the account is inserted inside the PostgreSQL transaction,
  the Firestore profile is written, then the transaction commits. If the profile write fails or
  times out, the account and its event are not kept (only the used number is) and the next
  creation simply gets the next ID.

**One entry point.** Every employee account is created by `createEmployeeAccount` on the account
service (`server/account-service.mjs`); HR's form and the employee form import approval (#27)
both call it, and nothing else inserts employee accounts:

```text
accounts.createEmployeeAccount({ profile, actorId })
  profile  ProfileInput (validated here; job.department required, the name of an active department)
  actorId  the HR account's id (uuid): created_by, the employee_created actor, profile.updatedBy
  -> Promise<{ employee: { account: EmployeeAccount, profile: Profile }, temporaryPassword }>
  throws 400 PROFILE_INVALID, 503 ACCOUNTS_UNAVAILABLE, 503 PROFILE_STORAGE_UNAVAILABLE,
         504 PROFILE_STORAGE_TIMEOUT (AccountError); a TypeError when actorId is not a uuid
```

The route only checks that the body is `{ profile }` and passes the signed-in HR account's id.

### Departments (HR Settings)

Departments and their Employee ID prefixes live in the `departments` table (issue #36), seeded by
migration `004_departments.sql` with the six first ones and managed by HR. There is no delete:
a department is archived instead. All routes are HR-only, same-origin, `Cache-Control: no-store`,
errors are `{ code, error }`, and `POST`/`PATCH` share the app's request limit.

```text
Department  { id, name, prefix, archived, exampleId, employees }
              exampleId   `${prefix}-0001`, a format example only
              employees   profiles whose job.department equals name

GET   /api/hr/departments
200 { departments: Department[] }       active first, then by name

POST  /api/hr/departments   { name, prefix }
201 { department: Department }
400 DEPARTMENT_INVALID { fields: [{ field: 'name' | 'prefix',
                         problem: 'required' | 'too_long' | 'invalid_format' | 'reserved' }] }
409 DEPARTMENT_NAME_TAKEN | DEPARTMENT_PREFIX_TAKEN

PATCH /api/hr/departments/:id   { name?, prefix?, archived? }      at least one
200 { department: Department, updatedProfiles: number }
400 DEPARTMENT_INVALID, 409 (as POST), 404 DEPARTMENT_NOT_FOUND
503 PROFILE_STORAGE_UNAVAILABLE | 504 PROFILE_STORAGE_TIMEOUT  (the rename's profile update failed)
```

- **Name**: trimmed, 1–60 characters, one line (no control characters), unique ignoring letter
  case, archived departments included. **Prefix**: `^[A-Z]{2,4}$` exactly (no lower case is
  accepted), unique across all departments including archived ones, and never `HR`, which is
  reserved for HR accounts (`reserved`). A non-text value is `invalid_format`; a missing or empty
  one is `required`. On `PATCH`, only the keys sent are checked, unknown keys or an empty body are
  `DEPARTMENT_INVALID` with `fields: []`, and `archived` must be a boolean (`field: 'archived'`,
  `invalid_format`). A change to the values already stored does nothing and records no event.
- **Prefix changes** affect new IDs only; existing usernames never change. A prefix's counter
  starts after the highest existing username with that prefix, and an old prefix that no
  department uses any more keeps its counter and can be given to another department.
- **Rename**: every employee profile (Firestore) whose `job.department` equals the old name is
  updated together with the rename. The profile update runs before the database transaction
  commits: if it fails, the rename does not happen (503/504) and a retry works; if the commit
  fails afterwards, the profiles are put back (best effort). `updatedProfiles` is the number
  updated. Profiles are matched by exact name.
- **Archive and restore**: an archived department is not a choice for a new hire
  (`invalid_department`) and not in the autofill's `enum`, but stays valid on profiles that
  already hold it (an edit may keep exactly the stored value). Its prefix stays reserved.
- **Readers**: employee creation resolves the prefix from this table, the profile edit accepts
  an active name or the stored value, and the autofill builds its `enum` and instruction per
  request from the active names (`activeDepartmentNames` on the account service). The browser
  uses `GET /api/hr/departments` for its dropdowns.
- **Audit** (`account_events`, `target_id` null, `detail` jsonb with no secrets):
  `department_created` `{ department: { id, name, prefix } }`; `department_updated`
  `{ department, changes: { name?: { from, to }, prefix?: { from, to } } }` (department holds the
  new values); `department_archived` and `department_restored` `{ department }`. One request that
  renames and archives writes both events.
- `employees` counts and the rename read the whole `employeeProfiles` collection (a small
  collection); a Firestore failure while listing is the profile storage 503/504. After a `POST` or
  `PATCH`, `employees` is a best-effort count (0 if Firestore fails then).

### Profile autofill

HR uploads an employee document (a CV, offer letter or filled-in details form) and Gemini on
Vertex AI reads the employee's profile fields from it, to pre-fill the "Add employee account"
and "Edit profile" forms. HR reviews the values and submits them through
`POST /api/hr/employees` or `PUT /api/hr/employees/:id/profile` as before. The autofill route
saves nothing and writes no account event; the create or update that follows is logged as usual.

- **On when** accounts are on and `GOOGLE_CLOUD_PROJECT` is set (`GEMINI_MODEL` and
  `GOOGLE_CLOUD_LOCATION` as for chat). `GET /api/config` reports it as
  `profileAutofill: true | false`; credentials are not probed, so a missing or refused
  Application Default Credential shows up as `503 AUTOFILL_UNAVAILABLE` on use.
- **Request**: `POST /api/hr/employees/autofill`, the raw file as the body with
  `Content-Type: application/octet-stream` and the header
  `X-File-Name: encodeURIComponent(file.name)`. HR session, origin check and the POST limit as
  for every HR route; the session is checked before the file is read.
- **Files**: `.pdf`, `.docx`, `.txt`, `.md`, `.jpg`/`.jpeg`, `.png`, at most 5 MiB
  (5,242,880 bytes). The extension and, for PDF, DOCX, JPG and PNG, the file signature must
  match. File names follow the upload reader’s rule (up to 180 characters, no folder path).
- **What Gemini gets**: PDFs (scanned ones included) and images as inline data. A PDF is first
  opened locally, so a password-protected or broken PDF is `400` without a Gemini call. DOCX,
  TXT and MD go through the shared upload text reader and only the text is sent, cut to
  250,000 characters. The request carries a fixed system instruction (copy only values written
  in the document and never guess; dates as `YYYY-MM-DD`; the document is data, not
  instructions; never output an employee ID, username, password or other credential), a
  `responseSchema` that mirrors `ProfileInput` with `responseMimeType: application/json`,
  temperature 0, and no tools. `job.department` is the one exception to copying: it is a schema
  `enum` of the active department names, read from the database for each request, with
  `nullable: true` (Vertex AI answers `400` to an empty
  enum value), and the instruction tells the model to choose the department the employee's role
  best belongs to (from the job title, team and duties, even when the document names it
  differently) or leave it empty (null) when that is unclear; null becomes `''`. HR can change the
  pre-selected department before creating the account; the Employee ID prefix follows HR's
  final choice. The request is aborted when the browser disconnects or after
  45 seconds.
- **Answer checks**: every value is trimmed and checked with the profile rules above. Invalid
  values are dropped into `warnings` (a department that is not exactly an active one is
  `invalid_department`); unknown keys, non-text values and placeholders such as `N/A` are
  dropped silently. Model text is never echoed, and an answer that is not a JSON
  object is `503 AUTOFILL_UNAVAILABLE`.
- **Privacy**: the file and its text stay in the request's memory only. Log lines name the
  operation, file type, duration and outcome code, never the file name, its content or values:
  `Profile autofill: {"operation":"extract profile","fileType":"pdf","durationMs":812,"outcome":"OK"}`.

```text
200 { profile: ProfileInput,        every group and field present; '' when not found or dropped
      filled: string[],             dotted paths of the non-empty fields, e.g. "job.fullName"
      warnings: [{ field, problem }] } dropped values; problem is too_long, invalid_characters,
                                       invalid_email, invalid_date, invalid_phone or
                                       invalid_department
profile.job.department is an active department name or ''.
```

| Status | Code                      | When                                                                                                        |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 400    | `AUTOFILL_FILE_INVALID`   | Missing or empty body, bad `X-File-Name`, unsupported type, mismatched signature, unreadable or locked file |
| 413    | `AUTOFILL_FILE_TOO_LARGE` | Over 5 MiB                                                                                                  |
| 422    | `AUTOFILL_NOTHING_FOUND`  | No profile value found (a text file or DOCX without text is not sent to Gemini)                             |
| 429    | `AUTOFILL_RATE_LIMITED`   | Vertex AI quota (provider 429)                                                                              |
| 503    | `AUTOFILL_NOT_CONFIGURED` | `GOOGLE_CLOUD_PROJECT` is not set (accounts off stays `ACCOUNTS_NOT_CONFIGURED`)                            |
| 503    | `AUTOFILL_UNAVAILABLE`    | Any other Vertex AI error, missing or refused credentials, an unusable answer, or the file reader is busy   |
| 504    | `AUTOFILL_TIMEOUT`        | No Gemini answer within 45 seconds                                                                          |

### Deleting an employee

`DELETE /api/hr/employees/:id` removes the employee's personal data, then the account. HR
accounts are never deleted here: they are `404 EMPLOYEE_NOT_FOUND`, like an unknown ID.

1. **Sign out.** Every session of the employee ends, so no new chat data appears while
   Firestore is cleaned up. The account itself stays.
2. **Firestore cleanup.** Every step is safe to repeat:
   - every conversation owned by `account:<id>` (expired and half-deleted ones included) with
     its `messages`, support observations and LangGraph checkpoints (`chatCheckpoints/{chatId}`);
   - the owner's `supportPreferences` document;
   - every `employeeImports` draft that names the account as `targetEmployee.accountId`, in
     `possibleDuplicates[].accountId` or as `createdBy.accountId` (a full scan of that small
     collection; nothing happens when it does not exist);
   - the profile `employeeProfiles/{id}`.

   If one of the employee's answers is still running, nothing is removed and the route answers
   `409 CHAT_BUSY` (that answer could still write checkpoints); try again when it finishes. If
   Firestore fails or times out the route answers `503 PROFILE_STORAGE_UNAVAILABLE` or
   `504 PROFILE_STORAGE_TIMEOUT`, the PostgreSQL account is left in place, and repeating the
   request finishes the job.

3. **PostgreSQL.** In one transaction: earlier events about the account get its username in
   `target_label`, the account is deleted (its sessions cascade), and an `employee_deleted`
   event is recorded with the HR actor, `target_id` `NULL` and `target_label` set to the
   username. The Employee ID is never assigned again (see
   [Employee IDs and temporary passwords](#employee-ids-and-temporary-passwords)).

Company documents that HR connected are company-wide and are not deleted with an employee.

### Team insights (replacing support summaries)

Decision D1 = Option A (issue #48, consent-based): HR sees an individual's struggles only when
that employee confirms a support request. The named per-employee automatic summaries and
`GET /api/hr/support-summaries` were removed (the path is now `404 NOT_FOUND`).

`GET /api/hr/team-insights` answers
`{ minimumGroup: 3, employeesWithData, available, openSupportRequests }` and, only when
`available` (at least 3 employees with recorded Alya activity), the sums over every employee:
`period: { from, to }` (calendar days, `YYYY-MM-DD`), `turns`, `feedback: { helpful, unclear }`,
`formats: { standard, steps, example, brief }`, `requests: { steps, example, brief }` and
`humanHelpRequests`. It never names anyone and holds no questions, answers or document text.
Each employee's recording choice (`POST /api/support-summary/settings`) is respected, as before.
Confirmed support requests, HR's workflow and the rest are in
[Onboarding journey and support](onboarding-journey.md).

### Company Documentation

Signed-in HR keeps one company-wide library of uploaded files, the Company Documentation page. HR
uploads PDF, Word (`.docx`), text or Markdown files (5 MiB each) under `/api/hr/company-knowledge`;
the server reads each file into plain text with the shared upload reader
(`server/read-uploaded-document.mjs`) to check it, find duplicates and count its characters, and
keeps only the document's metadata in Firestore, never the text or the file. With
`GOOGLE_CLOUD_PROJECT`, `DOCS_BUCKET` and `VERTEX_SEARCH_DATA_STORE_ID` set, the file itself goes
to the documents bucket at `gs://<DOCS_BUCKET>/<id>/<file name>` (PDF and DOCX as uploaded, text
and Markdown as UTF-8 `.txt`) and is imported into the Vertex AI Search data store: one
`documents:import` of that object, `reconciliationMode: INCREMENTAL`. Without them an upload is
listed but never reaches chats.

```text
KnowledgeSnapshot {
  topics: [{ id, title, description, icon }]   the five onboarding areas, in order (below)
  documents: [{ id, title, fileName, category, characters, bytes, created: ms since epoch,
                version: 1 | 2 | ..., connectedAt: ISO 8601 }],
                                     oldest first; never the text; never a retired entry
  limits: { files: 40, bytes: 5242880, characters: 250000, totalCharacters: 1500000 }
}
```

- **Areas** (issue #68): the library is the five onboarding areas, each a folder holding any number
  of documents, plus `additional` ("Other useful guidance"). `topics` lists the areas
  (`server/onboarding-document-topics.mjs`): `alignment` (Company Purpose & Alignment, icon
  `planet`), `documentation` (Documentation, `checklist`), `team-support` (People & Workplace
  Support, `people`), `role-tools` (Role, Tools & AI Readiness, `laptop`) and `policies`
  (Policies & Safe Practices, `shield`). The ids match the onboarding template areas. A document's
  `category` is an area id or `additional`. The six earlier topic ids (`company`, `handbook`,
  `first-week`, `role`, `it`, `communication`) are retired; Firestore migration
  `004_company_documents_areas` re-files them (`company` to `alignment`, `handbook` to `policies`,
  `first-week` to `documentation`, `role` and `it` to `role-tools`, `communication` to
  `team-support`, anything else to `additional`) and keeps every title.
- **Upload** (`POST /api/hr/company-knowledge/documents?category=<category>[&name=<title>]`): the
  body is the raw file, `Content-Type: application/octet-stream`, with the file name in
  `X-File-Name: encodeURIComponent(fileName)`. `category` is an area id or `additional`. The
  document's title is its own: `name` (trimmed, 1-80 characters, one line) when given, else the
  file name without its extension (cut to 80 characters); never the area's title. The title is
  what HR sees; Alya's sources show the **file name** (`Leave Policy 2026.docx`), with the
  section and page. Without `replaces` an upload always adds: a new document is
  `201 { id, duplicate: false, replaced: null }` (version 1). Identical text already stored in the
  same area is `200 { id, duplicate: true, replaced: null }` (no new document, nothing synced); in
  another area it is `409`. A JSON body is `415 FILE_UPLOAD_REQUIRED`. If the GCS upload or the
  import fails, the new metadata is removed again and the answer is
  `503 COMPANY_KNOWLEDGE_UNAVAILABLE` (`504 COMPANY_KNOWLEDGE_TIMEOUT` when a request ran out of
  time).
- **Replace** (`POST /api/hr/company-knowledge/documents?category=<category>[&name=<title>]&replaces=<id>`,
  the same raw body, route, proxy path and 5 MiB limit): the file becomes the next version of
  document `<id>`, which must be a current document. `category` is still required (the page sends
  the replaced document's area; another area files the new version there). Without `name` the new
  version keeps the replaced document's title, not the new file name.

  ```text
  201 { id: <newId>, duplicate: false, replaced: { id: <oldId>, cleanup: "done" | "pending" } }
  200 { id: <oldId>, duplicate: true, replaced: null }   the text is the replaced document's own
  400 DOCUMENT_TOPIC_REQUIRED | DOCUMENT_NAME_INVALID | FILE_NAME_INVALID
  404 WORKSPACE_DOCUMENT_NOT_FOUND       replaces is not a document ID, or not a current document
  409 COMPANY_DOCUMENT_DUPLICATE         the text equals another (not the replaced) document
  409 COMPANY_DOCUMENT_ALREADY_REPLACED  another HR browser replaced it first:
      "This document was just replaced. Refresh the library and try again."
  413 FILE_TOO_LARGE | WORKSPACE_TEXT_LIMIT   the text limit leaves the replaced document out
  415 FILE_UPLOAD_REQUIRED
  503 COMPANY_KNOWLEDGE_UNAVAILABLE | 504 COMPANY_KNOWLEDGE_TIMEOUT   nothing changed
  ```

  The file-count limit (`WORKSPACE_DOCUMENT_LIMIT`) never applies to a replace. The server works
  in three steps: (1) one Firestore transaction checks the library (without the replaced
  document), creates the new entry (`version` + 1, `supersedes: <oldId>`, `status: active`) and
  sets the old one to `status: retired`; (2) it uploads and imports the new version; if that
  fails, a second transaction deletes the new entry and makes the old one active again, the new
  GCS object is deleted, and the answer is the 503 or 504 with the old version still in place;
  (3) it deletes the old GCS object and Vertex AI Search document (as a delete does), then the old
  entry. The old entry goes even when that clean-up fails: the answer is then `cleanup: "pending"`
  and [document reconciliation](document-reconciliation.md) finishes it; HR does nothing. A
  successful replace writes one `company_document_replaced` audit row (`target_id` empty,
  `detail` `{ documentId: <newId>, replacedId: <oldId>, category }`, ids only); a duplicate or a
  refused replace writes none. Chat uses only active entries (the
  [retrieval allowlist](chat-and-memory.md#which-documents-chat-may-use-retrieval-allowlist)), so
  step 1 takes the old version out of chat: on the instance that handled the replace once it
  answers, and on others within 30 seconds. The new version is searchable once its import has
  indexed it (about a minute); until then neither version answers that topic.

- **Move** (`PATCH /api/hr/company-knowledge/documents/:id` with `{ "category": "<area id or additional>" }`,
  HR, same-origin): `200 { document }` with the document as in the snapshot. Moving to the area it is
  already in changes nothing. Otherwise the move writes a `company_document_moved` audit row
  (`target_id` empty, `detail` `{ documentId, from, to }`, ids only) in the same step. Errors:
  `404 WORKSPACE_DOCUMENT_NOT_FOUND` (unknown id), `400 DOCUMENT_TOPIC_REQUIRED` (invalid
  category), `409 COMPANY_DOCUMENT_DUPLICATE` (another document holds the same text). A move
  changes only the metadata; the indexed file stays as it is.
- **Delete** (`DELETE /api/hr/company-knowledge/documents/:id`, HR, same-origin): `204`. With the
  sync on, the server deletes the GCS object (a `404` counts as gone), then the Vertex AI Search
  document by its ID, the first 32 hex characters of SHA-256 of the object's `gs://` URI (a `404`
  counts as gone). Only after that `404` does it list the data store, every page, and delete any
  other document with the same URI. Only then does it delete the Firestore metadata. It never
  re-imports the bucket. Any failure is an error, never ignored: a failed or non-2xx GCS delete,
  Vertex AI Search delete or list answers `503 COMPANY_KNOWLEDGE_UNAVAILABLE`, or
  `504 COMPANY_KNOWLEDGE_TIMEOUT` when a request ran out of time, and the document stays listed so
  HR can delete it again (a retry tolerates the `404`s of what is already gone). An unknown or
  retired id is `404 WORKSPACE_DOCUMENT_NOT_FOUND` before any cloud call. Once the entry is
  gone the document leaves chat, even if a copy is still indexed: on the instance that handled the
  delete as soon as it answers, and on others within 30 seconds.
- **Storage**: Firestore `companyDocuments/{id}`, metadata only: `category`, `title`, `fileName`,
  `characters` (of the extracted text, at most 250,000), `bytes` (the file's size), `fingerprint`
  (SHA-256 of the extracted text), `connectedBy` (the HR account ID), `connectedAt` (ISO 8601, the
  upload of this version), `status` (`active` or `retired`), `version` (1, then + 1 per replace),
  `supersedes` (on a replacement: the replaced document's ID, kept for audit) and `retiredAt`
  (ISO 8601, set while a replaced version is retired). Entries stored before replace existed read
  as `active`, version 1. A retired entry is not part of the library: the snapshot, the file
  limit, the text limit and the duplicate checks leave it out, and move, delete and replace answer
  404 or 409 for it. At most forty documents and 1,500,000 characters in total; checks and writes
  run in one transaction. Documents stored before the metadata-only change may still hold a `text`
  field, which nothing reads. Documents stored before issue #35 have no `fileName` (listed as
  `''`) and still list. `listSummaries()` (for the retrieval allowlist) reads only `fileName`,
  `title`, `category`, `status`, `version`, `connectedAt` and `retiredAt` with one select query.
- **Sync log lines**: every GCS and Vertex AI Search request of the sync, successful or not, and
  each replace rollback and clean-up, writes one JSON line on standard output (Cloud Run reads it
  as `jsonPayload` with its `severity`):

  ```text
  {"severity":"INFO|WARNING","event":"onboardai_docs_sync","environment":"staging|production|local",
   "operation":"gcs.upload|gcs.delete|discoveryengine.import|discoveryengine.delete|discoveryengine.list|replace.rollback|replace.cleanup",
   "outcome":"ok|failed","status":200,"reason":null,"documentId":"<firestore id>|null"}
  ```

  `severity` is `INFO` for `ok` and `WARNING` for `failed`. `status` is the HTTP status, or `null`
  for a timeout, a network error, missing credentials or a `replace.*` step without one. `reason`
  is `null` when ok, else `http`, `timeout` or `network` (a Firestore failure in a replace step is
  `network`, or `timeout` on its deadline). A `404` on a delete is `ok` (already gone).
  `replace.cleanup` `failed` is the `cleanup: "pending"` case; `replace.rollback` `failed` means
  the rollback itself did not fully succeed. `environment` comes from `ONBOARDAI_ENVIRONMENT`
  (`staging` or `production`; anything else is `local`). No line holds a file name, title, URI,
  bucket name or text. Firestore failures still log `Firestore request failed: {...}` text lines.

- **Errors** (besides the session and route tables; file errors are the shared upload reader's):

  | Status              | Code                                                                                                                                                                                                               | When                                                           |
  | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
  | 415                 | `FILE_UPLOAD_REQUIRED`                                                                                                                                                                                             | The body is not `application/octet-stream`                     |
  | 400                 | `DOCUMENT_TOPIC_REQUIRED`                                                                                                                                                                                          | `category` is not an area ID or `additional`                   |
  | 400                 | `DOCUMENT_NAME_INVALID`                                                                                                                                                                                            | `name` is empty, over 80 characters or has a line break        |
  | 400/413/415/422/503 | `FILE_NAME_INVALID`, `FILE_EMPTY`, `FILE_TOO_LARGE`, `FILE_TYPE_UNSUPPORTED`, `FILE_INVALID`, `FILE_NO_TEXT`, `FILE_TEXT_TOO_LONG`, `FILE_UNREADABLE`, `FILE_READ_TIMEOUT`, password-protected, `FILE_READER_BUSY` | The reader refused the file (see `read-uploaded-document.mjs`) |
  | 404                 | `WORKSPACE_DOCUMENT_NOT_FOUND`                                                                                                                                                                                     | `replaces` is not a current document                           |
  | 409                 | `COMPANY_DOCUMENT_DUPLICATE`                                                                                                                                                                                       | The same text is already stored in another area                |
  | 409                 | `COMPANY_DOCUMENT_ALREADY_REPLACED`                                                                                                                                                                                | Replace: another HR browser replaced that document first       |
  | 409                 | `WORKSPACE_DOCUMENT_LIMIT`                                                                                                                                                                                         | Forty documents already                                        |
  | 413                 | `WORKSPACE_TEXT_LIMIT`                                                                                                                                                                                             | Over 1,500,000 characters in total                             |
  | 503                 | `COMPANY_KNOWLEDGE_UNAVAILABLE`                                                                                                                                                                                    | Firestore, GCS or Vertex AI Search failed                      |
  | 504                 | `COMPANY_KNOWLEDGE_TIMEOUT`                                                                                                                                                                                        | Firestore (10 s) or a sync request (15 s each) ran out of time |

- **Web service**: `server/api-proxy.mjs` forwards this path as an upload with a 5 MiB limit and
  answers `413 FILE_TOO_LARGE` for a larger file; it matches the path without its query, so
  `?replaces=` uploads take the same route.
- **Drift**: the three stores are written one after another, so a failure between them can leave
  an object or an indexed document without an entry. `npm run docs:reconcile` reports and repairs
  that drift; see [Document reconciliation](document-reconciliation.md).

### Employees' company documents (issue #126)

An employee opens their own company's documents from My Onboarding
(`server/employee-company-documents.mjs`, mounted on `/api/me` with the employee guard;
`server/company-document-files.mjs` reads the bucket).

- `GET /api/me/company-documents` lists the **active** `companyDocuments` entries of the
  signed-in account's `companyId` (none: `luna-digital`), sorted by area (`documentation`,
  `policies`, `alignment`, `role-tools`, `team-support`, `additional`; anything else last), then
  title (numeric-aware, case-insensitive):

  ```text
  CompanyDocument { id, title, category, fileName, uploadedAt: ISO 8601|null, viewUrl }
  { "documents": [ { "id": "<entry id>", "title": "02 Company Handbook", "category": "policies",
      "fileName": "02 Company Handbook.docx", "uploadedAt": "2026-10-23T13:42:10.000Z",
      "viewUrl": "/api/me/company-documents/<entry id>/file" } ] }
  ```

  `category` is as stored; `uploadedAt` is the entry's `connectedAt`. Never the text, the object
  name, the bucket, the company id or a Vertex AI Search id.

- `GET /api/me/company-documents/:id/file` sends the object the upload wrote
  (`objectName`, or `gcsObjectName(id, fileName, companyId)` for older entries) from
  `DOCS_BUCKET`, read with the api's credentials: `Content-Type` by the object's extension
  (`application/pdf`, the Word type, otherwise `text/plain; charset=utf-8`: text and Markdown
  uploads are stored as their UTF-8 text), `Content-Disposition: inline; filename*=UTF-8''<fileName>`,
  `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. The web service proxy
  streams it like any other answer.
- `404 DOCUMENT_NOT_FOUND` for every id that is not an active entry of the account's own
  company (another company's, retired, unknown or malformed), and for an entry whose object is
  gone. `503 COMPANY_DOCUMENTS_UNAVAILABLE` when Firestore or the bucket fails or times out, or
  without `DOCS_BUCKET` (the list still works then). HR, admin and signed-out requests get the
  session table's errors.
- The local preview (`npm run dev:preview`) and the tests keep uploads in memory
  (`createMemoryCompanyDocumentFiles`, passed as `companyDocumentSync` and
  `companyDocumentFiles`), so View works without a bucket.

### Account chats and the company library

Chats owned by an account (`account:<id>`, employee or HR) query Vertex AI Search (`companyRetrieve`, or the sample guide without `VERTEX_SEARCH_ENGINE_ID`) exclusively at runtime and never search or fall back to in-memory Firestore `companyDocuments`:

- `AI_MODE=gemini-chat`: up to six ranked passages from Vertex AI Search (`companyRetrieve`).
- `AI_MODE=document-search`: the two best quotes from Vertex AI Search (`companyRetrieve`).
- Single-turn Gemini and sample answers do not search documents, as before.

HR's uploads reach chats only through Vertex AI Search, once its import has indexed them. Every
chat belongs to an account.

### Account-owned chats

- `GET /api/config` gains `accounts: true | false` and `profileAutofill: true | false` (see
  [Profile autofill](#profile-autofill)). With a usable account session (signed in,
  no forced change) it also reports `conversationMemory: true` and `memoryRetentionDays: 30` in
  every `AI_MODE`; signed out they are `false` and `null` (issue #55). With accounts on it
  answers `Cache-Control: no-store` and `Vary: Cookie`. Its other fields are unchanged.
- `POST /api/chat`, every `/api/conversations*` route (including feedback, learning, human-help
  and voice-event), `POST /api/support-summary/settings`, `GET /api/employee-support-summary`,
  `POST /api/voice`, `POST /api/tts` and `POST /api/tts/local` need a usable account session
  (an employee or HR), in every `AI_MODE`. Without the `onboardai_account` cookie (or without
  accounts on this server) they answer `401 AUTH_REQUIRED` before any answer engine, voice or
  store is used; there is no anonymous fallback. An expired or invalid cookie is
  `401 SESSION_EXPIRED` (the cookie is cleared); a pending forced change is
  `403 PASSWORD_CHANGE_REQUIRED`; another site's `Origin` is `403`.
- The chats belong to the account (`account:<accountId>`), so they follow the employee to any
  browser. They are saved in every answer mode: document search, sample answers, single-turn
  Gemini and `gemini-chat`.
- `POST /api/chat` needs `conversationId` and `requestId` in every mode (400 otherwise). The
  answer has the mode's usual shape plus `conversationId` and the journey fields (`coverage`,
  `category`, `quickQuestionId`, `reexplainOf`, `proposedAction`; see
  [Onboarding journey and support](onboarding-journey.md#chat-fields)). Repeating a request ID
  returns the saved answer; a different question under the same ID is `409 REQUEST_CONFLICT`.
- Unknown `/api` paths, including the removed `/api/guest-workspace/*`, are a JSON
  `404 { code: "NOT_FOUND" }`, never the web app's page.
- `/api/employee-support-summary` stays `403 HR_ACCESS_REQUIRED` for every signed-in account,
  HR included.

### For the browser

- On load, call `GET /api/auth/session`. `account: null` means signed out.
- **Forced password change**: `account.mustChangePassword` is `true` after sign-in or in the
  session, and any other account or chat route answers `403 PASSWORD_CHANGE_REQUIRED`. Show
  the change-password form, call `POST /api/auth/password`, then fetch `/api/config` again.
- **Expired session**: any route answering `401 SESSION_EXPIRED` (chat routes included). The
  server has already cleared the cookie; show the sign-in form again.
- **Locked while signed in**: `POST /api/auth/password` answers `429 ACCOUNT_LOCKED`. Show
  the message; the session still works, so keep the user signed in.
- The cookie is HttpOnly: the browser never reads it. Same-origin `fetch` sends it.
- Route by `account.role` after sign-in; the Employee/HR selector does not decide the role.

## Files

- `server/account-settings.mjs`: when accounts are on, and the start-up guard.
- `server/account-service.mjs`: sign-in, sessions, lockout, password changes and HR actions.
- `server/account-store.mjs`: PostgreSQL queries and transactions.
- `server/account-routes.mjs`: `/api/auth`, `/api/me` and `/api/hr` routes and the session cookie.
- `server/account-errors.mjs`: account error codes and messages.
- `server/password-hashing.mjs`: scrypt hashing, password rules and generated passwords.
- `server/departments.mjs`: the six first departments and their prefixes, as seed data only
  (import-free; migration 004 seeds the same list). The `departments` table is the source of truth.
- `server/employee-ids.mjs`: the prefix rule, the reserved `HR` prefix and the Employee ID format.
- `server/employee-profiles.mjs`: profile validation and Firestore storage, and removal of an
  account's profile and import drafts.
- `server/company-knowledge.mjs`: the HR company library (snapshot, upload, replace, move,
  remove, the `onChange` hook) and the library search for account chats.
- `server/company-documents.mjs`: Firestore `companyDocuments`, the library and replace rules,
  and the GCS + Vertex AI Search sync with its `onboardai_docs_sync` lines.
- `server/discovery-engine-documents.mjs`: object names, `gs://` URIs, Vertex document IDs and
  the Discovery Engine and GCS URLs, shared with the document scripts.
- `server/onboarding-document-topics.mjs`: the five onboarding areas HR files documents under.
- `server/profile-autofill.mjs`: profile autofill (file checks, the Gemini request, answer checks).
- `server/database-migrations.mjs`, `server/migrations/*.sql`: the migration runner and SQL
  (`001` accounts, `002` deleted-account labels, `003` Employee ID counters, `004` departments; #27 uses `005` on).
- `scripts/migrate-database.mjs`: `db:migrate`; `server/migration-runner.mjs`,
  `server/firestore-migrations.mjs`, `server/migrations/firestore/`: target selection and the
  Firestore migrations; `scripts/check-migration-files.mjs`: `db:migrations:check`.
- `scripts/create-hr-account.mjs`, `scripts/reset-hr-password.mjs`, `scripts/hr-account-tool.mjs`:
  `hr:create`, `hr:reset-password` and their shared input and rules.
- `src/access/LoginPage.jsx`: workspace selection, sign-in and employee sign-up forms.
- `server/onboarding-*.mjs`, `server/support-requests.mjs`, `server/team-insights.mjs`,
  `server/knowledge-gaps.mjs`, `server/pii-redaction.mjs`: the onboarding journey (see
  [Onboarding journey and support](onboarding-journey.md)).
- `src/access/`: the sign-in screens, the HR workspace and the company document library
  (frontend; see [File guide](file-guide.md)).
- `tests/server/account-*.test.mjs`, `password-hashing.test.mjs`, `employee-profiles.test.mjs`,
  `employee-ids.test.mjs`, `departments.test.mjs`, `profile-autofill.test.mjs`, `employee-delete.test.mjs`,
  `company-knowledge.test.mjs`, `company-document-*.test.mjs`, `onboarding-*.test.mjs`, `support-requests.test.mjs`,
  `quick-questions.test.mjs`, `signed-out.test.mjs`: account tests, using pg-mem (the real migrations), an in-memory
  Firestore fake and a fake Vertex AI endpoint with synthetic documents.
