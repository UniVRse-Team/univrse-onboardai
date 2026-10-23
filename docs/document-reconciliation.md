# Document reconciliation

HR's company library lives in three places that are written one after another, with no shared
transaction: Firestore `companyDocuments` (what HR published), the documents bucket (the files)
and the Vertex AI Search data store (what chat can find). `npm run docs:reconcile`
(`scripts/reconcile-company-documents.mjs`) compares the three and prints the drift between them.
By default it only reads (report mode). With `--apply` it repairs what it safely can.

Firestore is the truth. The job never writes Firestore: an entry is created, replaced or removed
only by HR on the Company Documentation page ([Account access](account-access.md#company-documentation)).

## Command

```bash
npm run docs:reconcile -- [--apply] [--max-deletes <n>] [--allow-empty-library]
                          [--grace-minutes <n>] [--skip-gcs] [--show-names]
                          [--timeout-minutes <n>] [--help]
# = node scripts/reconcile-company-documents.mjs ...
```

As a Cloud Run job (owned by DevOps): command `["node"]`, args
`["scripts/reconcile-company-documents.mjs"]`, plus `"--apply"` only in apply mode, on the api
image and as the api runtime account (Application Default Credentials). It needs no secret and no
Cloud SQL. Locally it uses your own Application Default Credentials
(`gcloud auth application-default login`); a quota project in those credentials is sent as
`x-goog-user-project`. It does not read `.env`: pass every setting on the command line.

| Setting                       | Required | Meaning                                                                  |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `ONBOARDAI_ENVIRONMENT`       | yes      | `staging` or `production`                                                |
| `GOOGLE_CLOUD_PROJECT`        | yes      | The project of the data store                                            |
| `FIRESTORE_DATABASE_ID`       | yes      | Production `(default)`, staging `onboardai-staging`                      |
| `DOCS_BUCKET`                 | yes      | The environment's documents bucket                                       |
| `VERTEX_SEARCH_DATA_STORE_ID` | yes      | The environment's data store                                             |
| `FIRESTORE_PROJECT_ID`        | no       | Default `GOOGLE_CLOUD_PROJECT`                                           |
| `VERTEX_SEARCH_LOCATION`      | no       | Default `global`; `us` and `eu` use their regional Discovery Engine host |

**Environment guard** (exit 2, nothing is read): with `staging`, `FIRESTORE_DATABASE_ID`,
`DOCS_BUCKET` and `VERTEX_SEARCH_DATA_STORE_ID` must each end in `-staging`; with `production`,
none of them may. IAM cannot stop one environment's account reaching the other's data store yet,
so this check does.

| Flag                    | Default | Meaning                                                                                       |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `--apply`               | off     | Off: report mode, read only. On: perform the planned actions                                  |
| `--max-deletes <n>`     | 10      | More planned Vertex + GCS deletes than `n`: exit 3, nothing changed                           |
| `--allow-empty-library` | off     | Without it, 0 Firestore entries and at least 1 planned delete: exit 3, nothing changed        |
| `--grace-minutes <n>`   | 15      | Entries, objects and documents younger than this are `pending`, never acted on                |
| `--skip-gcs`            | off     | GCS orphans are reported with result `skipped`, never deleted, and are not counted as deletes |
| `--show-names`          | off     | Operator only: adds `name` (the object name) to item lines. The scheduled job never passes it |
| `--timeout-minutes <n>` | 10      | Overall deadline; actions not finished by then count as failed                                |
| `--help`                |         | Prints the usage text (not JSON) and exits 0, with no summary line                            |

## What it reads

In this order, so an upload in flight is never mistaken for an orphan (an entry is always written
before its object and its Vertex document):

1. The Vertex AI Search documents list, every page (`id`, `content.uri`, `indexTime`).
2. The live objects in the bucket, every page (`name`, `timeCreated`; no older versions).
3. Firestore `companyDocuments` with a select-only `runQuery` of `fileName`, `title`,
   `category`, `status`, `version`, `connectedAt`, `retiredAt` and `companyId`. The legacy `text` field of
   old entries is never read.

An **active** entry (`status` missing or `active`) with a file name expects one object,
`<document id>/<file name>` (or `companies/<company id>/<document id>/<file name>` for tenant companies,
`.md` and other unparsed types as `.txt`), and one Vertex document,
whose ID is the first 32 hex characters of SHA-256 of `gs://<bucket>/<object name>`.

## One-off repair

To tag documents that lost or never had their `companyId` (the report shows `untaggedIndex` > 0),
run the job once in apply mode, then check the next report is clean:

```bash
gcloud run jobs execute onboardai-docs-reconcile[-staging] --region asia-southeast1 \
  --args=scripts/reconcile-company-documents.mjs,--apply --wait
```

## Item kinds

| Kind               | When                                                                                                                                                                                                                                              | Action with `--apply`                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vertex_orphan`    | A Vertex document whose URI is not the expected URI of an active entry and is not unmanaged, for example a root-level file whose object is gone                                                                                                   | `delete_vertex` (404 counts as done). For a `<document id>/` URI, Firestore is read again first and the item is `skipped` if that entry now expects it                                                                                                                    |
| `vertex_duplicate` | More than one Vertex document for one expected URI                                                                                                                                                                                                | `delete_vertex` each one except the one whose ID is the URI hash (when none has it, the lowest ID is kept)                                                                                                                                                                |
| `gcs_orphan`       | A live object under `<document id>/` whose ID has no active entry, or whose name is not that entry's expected name                                                                                                                                | `delete_gcs` (bucket versioning keeps it 30 days). Re-checked in Firestore first, like a `vertex_orphan`. With `--skip-gcs`: result `skipped`                                                                                                                             |
| `missing_index`    | An active entry and its live object, but no Vertex document                                                                                                                                                                                       | `reimport`: inline `documents:import` of explicit gs:// URIs only (at most 100 per call), each document carrying `id` (the Firestore entry id), `structData.companyId`, `content.uri` and `content.mimeType`, `INCREMENTAL`; the operation is polled for up to 10 minutes |
| `untagged_index`   | The Vertex document of an active entry has no `structData.companyId`, or one other than its entry's company (an entry without a company counts as the default company). Chat searches filter on that tag, so the company cannot find the document | `retag`: the same inline import, with the existing Vertex document `id`, in place. Not a delete: it does not count toward `--max-deletes`. A document without `indexTime` is `pending` instead; of several documents for one URI only the kept one is checked             |
| `missing_object`   | An active entry with a file name and no live object                                                                                                                                                                                               | none: HR must upload the file again                                                                                                                                                                                                                                       |
| `retired_entry`    | An entry with `status: retired` (a replaced version whose clean-up did not finish). Its object and Vertex document are orphans                                                                                                                    | none                                                                                                                                                                                                                                                                      |
| `pending`          | Anything younger than the grace period (a retired entry by `retiredAt`), or a Vertex document without `indexTime`                                                                                                                                 | none                                                                                                                                                                                                                                                                      |
| `unmanaged`        | A live object outside the `<document id>/` namespace, with or without a Vertex document (one item per URI)                                                                                                                                        | none, ever. Never deleted, never counted toward a safety stop or the exit code                                                                                                                                                                                            |

- Entries without a file name (Google Docs entries from before issue #35) have no object: they are
  counted in `firestore` and produce no item.
- Production's legacy `onboarding/*.pdf` files (live and indexed, with no Firestore entry) are
  `unmanaged`: listed, never acted on. If such an object is deleted, its Vertex document becomes a
  `vertex_orphan` (that is the case of staging's four root-level PDFs).

**Tagging.** Every import the job makes is an inline import that carries
`structData.companyId`; no code path imports an untagged document (a `gcsSource` import would
leave the tag empty and hide the document from its company's filtered search). `reimported`
counts `missing_index` items done, `retagged` counts `untagged_index` items done.

**Invariants.** Never `reconciliationMode: FULL`, never a wildcard or prefix URI, never a
Firestore write. Only items in the printed plan are acted on. A second run after a successful apply
plans nothing.

**Report mode is read-only by construction.** Its HTTP layer lets through `GET` requests to the
Firestore, Cloud Storage and Discovery Engine APIs and the Firestore `…/documents:runQuery`
`POST`, and throws for any other method or URL before anything is sent.

## Safety stops

Both are evaluated in both modes, after the reads:

- **Empty library**: 0 Firestore entries and at least 1 planned delete, without
  `--allow-empty-library` (a wrong `FIRESTORE_DATABASE_ID` or an empty read must not empty the
  index).
- **Too many deletes**: planned Vertex + GCS deletes above `--max-deletes`.

In report mode the item lines still print (result `planned`) and the summary carries exit code 3.
In apply mode nothing is changed and the actionable items print result `skipped`.

## Exit codes

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0    | Completed. Report: the plan was printed; drift shows in the counts, not the exit code. Apply: every planned action succeeded |
| 1    | Apply: at least one action failed (or the deadline passed); the rest were done. A re-run is safe                             |
| 2    | Usage or configuration error, or the environment guard. Nothing was read                                                     |
| 3    | Safety stop. Nothing was changed                                                                                             |
| 4    | A source could not be read (credentials, 403, 404, timeout). Nothing was changed                                             |

## Log lines

Standard output holds only JSON, one object per line, so Cloud Run reads each as `jsonPayload`
with its `severity`. Error text for a person (usage, which source failed) goes to standard error
and names settings, never their values.

One line per item:

```json
{
  "severity": "WARNING",
  "event": "onboardai_docs_reconcile_item",
  "environment": "staging",
  "mode": "report",
  "kind": "vertex_orphan",
  "action": "delete_vertex",
  "result": "planned",
  "firestoreId": null,
  "vertexId": "<32 hex>",
  "status": null
}
```

- `action`: `delete_vertex` | `delete_gcs` | `reimport` | `retag` | `none`.
- `result`: `planned` (an actionable item in report mode), `done`, `failed`, `skipped` or
  `reported` (a report-only kind).
- `firestoreId`: the document ID of the entry, or of the `<document id>/` folder the object or URI
  lies in (even when no entry exists), else `null`. `vertexId`: the Vertex document the item is
  about, else `null`.
- `status`: the HTTP status of a failed action, else `null`.
- `severity`: `ERROR` when the result is `failed`; `WARNING` for drift that is still there (any
  kind but `unmanaged` and `pending`, with a result other than `done`); otherwise `INFO`.

Exactly one summary line, always the last line, also on exits 2 to 4 (zeros for what was not read):

```json
{
  "severity": "WARNING",
  "event": "onboardai_docs_reconcile",
  "environment": "staging",
  "mode": "report",
  "exitCode": 0,
  "reason": null,
  "firestore": 8,
  "gcsLive": 9,
  "vertex": 13,
  "unmanaged": 0,
  "vertexOrphans": 5,
  "vertexDuplicates": 0,
  "gcsOrphans": 1,
  "missingIndex": 0,
  "untaggedIndex": 0,
  "missingObject": 0,
  "retiredEntries": 0,
  "pending": 0,
  "deletedVertex": 0,
  "deletedGcs": 0,
  "reimported": 0,
  "retagged": 0,
  "failed": 0,
  "unrepaired": 6,
  "durationMs": 2140
}
```

- `reason`: `null` | `usage` | `env_mismatch` | `max_deletes` | `empty_library` |
  `source_unreadable` | `actions_failed` | `timeout`.
- `unrepaired`: items still drift after this run (every kind except `unmanaged` and `pending`,
  minus those `done`).
- `severity`: `ERROR` when `exitCode` is not 0; else `WARNING` when `unrepaired` > 0; else `INFO`.
- Every count is an integer and always present. No line holds a file name, title, URI, bucket name
  or document text, unless `--show-names` adds `name` to the item lines.

## The api's sync lines

The api logs every request of its own GCS + Vertex AI Search sync (uploads, replacements and
deletes) the same way, one JSON line on standard output each:

```json
{
  "severity": "INFO|WARNING",
  "event": "onboardai_docs_sync",
  "environment": "staging|production|local",
  "operation": "gcs.upload",
  "outcome": "ok|failed",
  "status": 200,
  "reason": null,
  "documentId": "<uuid>"
}
```

See [Account access](account-access.md#company-documentation) for the operations and fields.

## Running it

Report mode is the safe default for any environment:

```bash
ONBOARDAI_ENVIRONMENT=staging GOOGLE_CLOUD_PROJECT=<project> \
  FIRESTORE_DATABASE_ID=onboardai-staging DOCS_BUCKET=<project>-onboardai-docs-staging \
  VERTEX_SEARCH_DATA_STORE_ID=onboardai-docs-staging npm run docs:reconcile
```

`--apply` changes the bucket and the data store. Run it only from the scheduled job or with the
operator's explicit decision, after a report run of the same environment has been read.
