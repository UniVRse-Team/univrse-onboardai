locals {
  # Common labels, merged with a per-component label where a resource accepts
  # labels. Staging adds environment = staging; production keeps the labels it
  # was applied with (adding one would update every production resource).
  labels = merge(
    {
      app        = "onboardai"
      managed-by = "terraform"
    },
    { for k, v in { environment = var.environment } : k => v if !local.is_production },
  )

  apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com", # GitHub Actions impersonates the deployer
    "sts.googleapis.com",            # exchanges the GitHub OIDC token
    # Platform service of the architecture; no secret exists yet (the API
    # authenticates to Google APIs with its service account).
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",      # the API calls Gemini on Vertex AI
    "discoveryengine.googleapis.com", # Vertex AI Search over the documents
    "firestore.googleapis.com",
    "storage.googleapis.com",    # documents bucket
    "monitoring.googleapis.com", # alert policies and email channels
    # Cloud SQL, the Cloud Run Cloud SQL connection and the Cloud SQL Auth
    # Proxy (accounts.tf, #45). Enabled by staging's state until #45 (main.tf).
    "sqladmin.googleapis.com",
    # Cloud Scheduler starts the document reconciliation job every hour
    # (docs_reconcile.tf, #79). Only production's state manages APIs, so
    # staging's apply needs it enabled first (README, Document reconciliation).
    "cloudscheduler.googleapis.com",
  ]

  # Project-level roles of the api runtime account. With the intake agent's
  # two (staging only, intake_agent.tf) they are the only project-level
  # bindings in this module (tests/onboardai.tftest.hcl enforces it).
  #
  # Every environment holds the same three (#56 narrowed production to
  # staging's pattern):
  # - Gemini on the project, unconditioned: Vertex AI has no narrower grant.
  #   The same role lets staging's api query the intake agent on Agent Engine
  #   and delete the agent's sessions.
  # - Firestore only in its own database (IAM condition below).
  # - Cloud SQL Client only on its own accounts instance (IAM condition below).
  # No Discovery Engine role on the project: each api searches through a grant
  # on its own engine (vertex_ai_search.tf), so neither can search the other
  # environment's engine.
  api_project_roles = {
    for role, purpose in {
      "roles/aiplatform.user"        = "Gemini generateContent on Vertex AI"
      "roles/datastore.user"         = "Firestore: read and write documents"
      "roles/cloudsql.client"        = "Cloud SQL: the Cloud Run connection to the accounts instance"
      "roles/discoveryengine.editor" = "Vertex AI Search: import and delete HR-uploaded documents"
    } : role => purpose
    if !contains(local.api_project_roles_left_out, role)
  }

  # Cloud SQL only where accounts run.
  api_project_roles_left_out = local.employee_accounts ? [] : ["roles/cloudsql.client"]

  # IAM conditions on api_project_roles, by role. Adding a condition to a
  # binding that already exists replaces it; api_runtime (identity.tf) creates
  # the conditioned binding before it removes the old one
  # (create_before_destroy).
  # - roles/datastore.user: Firestore evaluates resource.name for
  #   database-level IAM conditions, so each api reaches its own database only:
  #   production (default), staging onboardai-staging. Both spellings of the
  #   project are accepted; each one names that database only. The migration
  #   job runs as the same account, against the same database.
  # - roles/cloudsql.client (wherever accounts run): Cloud SQL evaluates
  #   resource.name and resource.type of the instance (Cloud SQL docs, "IAM
  #   Conditions": allow connecting to specific instances), so the api can
  #   connect to its own accounts instance and no other.
  api_project_role_conditions = merge(
    {
      "roles/datastore.user" = {
        title = "${local.firestore_database_name} database only"
        # Staging's text is the one it was applied with; changing it would
        # replace staging's binding.
        description = "Firestore access for the ${var.environment} api: the ${local.firestore_database_name} database, ${local.is_production ? "no other" : "never (default)"}."
        expression = join(" || ", [
          for p in distinct([var.project_id, data.google_project.this.number]) :
          "resource.name == \"projects/${p}/databases/${local.firestore_database_name}\""
        ])
      }
    },
    local.employee_accounts ? {
      "roles/cloudsql.client" = {
        title       = "${local.sql_instance_name} instance only"
        description = "Cloud SQL connections of the ${var.environment} api: the ${local.sql_instance_name} accounts instance, no other."
        expression  = "resource.name == \"projects/${var.project_id}/instances/${local.sql_instance_name}\" && resource.type == \"sqladmin.googleapis.com/Instance\""
      }
    } : {},
  )

  # (default) is production's; a project holds only one, so staging gets a
  # named database.
  firestore_database_name = local.is_production ? "(default)" : "onboardai${local.name_suffix}"

  # ---------------------------------------------------------------------------
  # Employee accounts (every environment, #45) and the form intake agent
  # (staging only, #30). deploy.yml computes the same names from NAME_SUFFIX;
  # tests/accounts.tftest.hcl checks that they match.
  # ---------------------------------------------------------------------------
  sql_instance_name = "onboardai-db${local.name_suffix}"
  # The database and its user (the app's DATABASE_URL user) inside it.
  sql_database_name = "onboardai"
  sql_user_name     = "onboardai"
  # Cloud Run job that runs `npm run db:migrate` from the api image, and the
  # Cloud Logging view of its output that the deploy workflow reads.
  db_migrate_job_name      = "onboardai-db-migrate${local.name_suffix}"
  db_migrate_log_view_name = "onboardai-db-migrate${local.name_suffix}"
  # What the migration job migrates (the runner's MIGRATION_TARGETS): Cloud SQL,
  # then the environment's Firestore database. Listing both makes the runner
  # fail before touching either database if one is not configured.
  db_migrate_targets = "sql,firestore"

  # Automated backups of the accounts instance. Staging keeps what it was
  # applied with (#30). Production keeps a week of daily backups and point-in-
  # time recovery over that week, so a bad migration or deletion can be undone
  # by cloning the instance to the moment before it (README, Roll back a
  # migration).
  sql_backups = local.is_production ? {
    retained_backups               = 7
    point_in_time_recovery_enabled = true
    transaction_log_retention_days = 7
    } : {
    retained_backups               = 3
    point_in_time_recovery_enabled = false
    transaction_log_retention_days = null # the API's default; staging has no PITR
  }

  # Secret Manager secret IDs. Values are generated during apply and written
  # with write-only arguments, so none of them is in state.
  secret_ids = {
    db_password      = "onboardai-db-password${local.name_suffix}"      # the database user's password, for the HR bootstrap
    database_url     = "onboardai-database-url${local.name_suffix}"     # DATABASE_URL of the api and the migration job
    intake_mcp_token = "onboardai-intake-mcp-token${local.name_suffix}" # INTAKE_MCP_TOKEN of the api and the agent
  }

  # The agent's runtime service account, and the display name the deploy
  # command creates or updates the reasoning engine by (it stops if two
  # engines share it). deploy.yml passes the same: "... ($DEPLOY_ENV)".
  intake_agent_account_id   = "onboardai-intake${local.name_suffix}"
  intake_agent_display_name = "OnboardAi employee form intake (${var.environment})"

  # ---------------------------------------------------------------------------
  # Vertex AI Search, Firestore and the documents bucket (contract v2).
  # ---------------------------------------------------------------------------
  search_location                = "global"
  search_collection_id           = "default_collection" # the only collection data stores are created in
  data_store_id                  = "onboardai-docs${local.name_suffix}"
  search_engine_id               = "onboardai-search${local.name_suffix}"
  docs_bucket_name               = "${var.project_id}-onboardai-docs${local.name_suffix}"
  employee_documents_bucket_name = "${var.project_id}-onboardai-employee-docs${local.name_suffix}"

  # Service agent that Discovery Engine reads Cloud Storage imports as.
  discovery_engine_service_agent = "service-${data.google_project.this.number}@gcp-sa-discoveryengine.iam.gserviceaccount.com"

  # Full names use the project number, like the API returns them.
  data_store_name     = "projects/${data.google_project.this.number}/locations/${google_discovery_engine_data_store.docs.location}/collections/${local.search_collection_id}/dataStores/${google_discovery_engine_data_store.docs.data_store_id}"
  serving_config_name = "projects/${data.google_project.this.number}/locations/${google_discovery_engine_search_engine.docs.location}/collections/${google_discovery_engine_search_engine.docs.collection_id}/engines/${google_discovery_engine_search_engine.docs.engine_id}/servingConfigs/default_search"

  # Service contract v1: Artifact Registry repository and image path.
  repository_id = "onboardai${local.name_suffix}"
  image_prefix  = "${var.region}-docker.pkg.dev/${var.project_id}/${local.repository_id}"

  # ---------------------------------------------------------------------------
  # GitHub Actions identity. Each environment has its own pool, provider and
  # deployer. Only the deploy workflow on the environment's branch (main for
  # production, staging for staging) of this one repository (pinned by numeric
  # ID), started by a push or a manual dispatch, can exchange its OIDC token.
  # Pull requests (refs/pull/...), other branches, other workflows on that
  # branch (e.g. a future issue_comment or pull_request_target workflow that
  # outsiders can trigger) and forks are refused.
  # ---------------------------------------------------------------------------
  github_deploy_branch       = local.is_production ? "main" : var.environment
  github_deploy_ref          = "refs/heads/${local.github_deploy_branch}"
  github_deploy_workflow_ref = "${var.github_repository}/.github/workflows/deploy.yml@${local.github_deploy_ref}"
  wif_pool_id                = "onboardai-github${local.name_suffix}"
  wif_provider_id            = "github-actions${local.name_suffix}"

  wif_attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.repository_owner_id == '${var.github_repository_owner_id}'",
    "assertion.ref == '${local.github_deploy_ref}'",
    "assertion.workflow_ref == '${local.github_deploy_workflow_ref}'",
    "(assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')",
  ])

  # ---------------------------------------------------------------------------
  # Cloud Run services (service contract v1). Terraform creates them with a
  # placeholder image; .github/workflows/deploy.yml deploys the real images with
  # exactly these settings (its WEB_/API_/TTS_RUN_FLAGS lines). The test in
  # tests/workflows.tftest.hcl fails if the two disagree, so neither undoes the
  # other on the next apply or deploy.
  # ---------------------------------------------------------------------------
  placeholder_image     = "us-docker.pkg.dev/cloudrun/container/hello"
  container_port        = 8080
  probe_period_seconds  = 5
  probe_timeout_seconds = 3

  # Every environment gets the same shape: only names and descriptions differ.
  # account_id is the runtime service account (6-30 characters).
  services = {
    web = {
      name        = "onboardai-web${local.name_suffix}"
      account_id  = "onboardai-web-run${local.name_suffix}"
      description = "${local.display_name} web: serves the built frontend and avatar, proxies /api/* to onboardai-api${local.name_suffix}."
      cpu         = "1"
      memory      = "512Mi"
      concurrency = 80
      # Cost cap. Static files and a streaming proxy: three instances carry a demo.
      min_instances = 0
      max_instances = 3
      # Above the proxy's 290 s upstream timeout, so the proxy answers 504 itself.
      timeout_seconds           = 300
      cpu_boost                 = false
      health_path               = "/web-health"
      startup_failure_threshold = 12 # 60 s
    }

    api = {
      name        = "onboardai-api${local.name_suffix}"
      account_id  = "onboardai-api-run${local.name_suffix}"
      description = "${local.display_name} API: /api/* routes, Gemini chat and Vertex AI Search retrieval."
      cpu         = "1"
      # The guest workspace store's SQLite file (written to the in-memory
      # filesystem) lives in this limit.
      memory      = "1Gi"
      concurrency = 80
      # Contract: exactly one instance. Saved chats are in Firestore (#9), but
      # the guest workspace store (server/guest-workspace-store.mjs: guest
      # workspaces, their employees, documents, chats and checkpoints) is a
      # SQLite file on each instance's local disk, wiped on restart, and the
      # per-IP limit on POST and PATCH requests is counted per instance. A
      # second instance would split both. Lifting the cap is #58.
      min_instances             = 0
      max_instances             = 1
      timeout_seconds           = 300
      cpu_boost                 = true # shortens the cold start before the first chat
      health_path               = "/api/health"
      startup_failure_threshold = 12 # 60 s
    }

    tts = {
      name        = "onboardai-tts${local.name_suffix}"
      account_id  = "onboardai-tts-run${local.name_suffix}"
      description = "${local.display_name} TTS: Kokoro voice (model baked into the image)."
      # Measured (README "Cloud Run settings"): one Kokoro q8 render of the longest
      # input peaks near 1 GiB RSS and an 1100 MiB limit was OOM-killed, so 2 GiB.
      # A second vCPU rendered about 17% faster and keeps the event loop free
      # while ONNX Runtime fills a core.
      cpu    = "2"
      memory = "2Gi"
      # Renders run one at a time and the app refuses a 9th queued request with
      # VOICE_BUSY, so never route more than 8 to one instance.
      concurrency               = 8
      min_instances             = 0
      max_instances             = 2 # cost cap
      timeout_seconds           = 300
      cpu_boost                 = true # model load is CPU-bound
      health_path               = "/health"
      startup_failure_threshold = 48 # 240 s for the model to load (503 until then)
    }
  }

  # Flags the deploy workflow must pass to `gcloud run deploy` for each service.
  cloud_run_deploy_flags = {
    for key, s in local.services : key => join(" ", [
      "--cpu=${s.cpu}",
      "--memory=${s.memory}",
      "--concurrency=${s.concurrency}",
      "--min-instances=${s.min_instances}",
      "--max-instances=${s.max_instances}",
      "--timeout=${s.timeout_seconds}",
      "--port=${local.container_port}",
      "--execution-environment=gen2",
      "--ingress=all",
      "--cpu-throttling",
      s.cpu_boost ? "--cpu-boost" : "--no-cpu-boost",
      join(",", [
        "--startup-probe=httpGet.path=${s.health_path}",
        "httpGet.port=${local.container_port}",
        "initialDelaySeconds=0",
        "periodSeconds=${local.probe_period_seconds}",
        "timeoutSeconds=${local.probe_timeout_seconds}",
        "failureThreshold=${s.startup_failure_threshold}",
      ]),
    ])
  }

  # Every variable the workflows read (tests/workflows.tftest.hcl checks both
  # directions). Values come from this module. Production keeps them as
  # repository variables; any other environment sets the same names in the
  # GitHub environment of its own name, which the deploy jobs select by branch.
  github_variable_scope = local.is_production ? "" : " --env ${var.environment}"

  github_variables = {
    GCP_PROJECT_ID          = var.project_id
    GCP_REGION              = var.region
    GCP_WIF_PROVIDER        = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA         = google_service_account.deployer.email
    AI_MODE                 = var.ai_mode
    GEMINI_MODEL            = var.gemini_model
    VERTEX_SEARCH_LOCATION  = google_discovery_engine_search_engine.docs.location
    VERTEX_SEARCH_ENGINE_ID = google_discovery_engine_search_engine.docs.engine_id
    FIRESTORE_DATABASE_ID   = google_firestore_database.default.name
  }
}
