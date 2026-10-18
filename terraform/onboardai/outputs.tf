output "workload_identity_provider" {
  description = "Full resource name of the GitHub OIDC provider (repository variable GCP_WIF_PROVIDER)."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account_email" {
  description = "Service account the deploy workflow impersonates (repository variable GCP_DEPLOYER_SA)."
  value       = google_service_account.deployer.email
}

output "web_runtime_service_account_email" {
  description = "Runtime identity of onboardai-web. Holds no roles."
  value       = google_service_account.runtime["web"].email
}

output "api_runtime_service_account_email" {
  description = "Runtime identity of the api service and the migration job. production: roles/aiplatform.user, roles/discoveryengine.viewer and roles/datastore.user on the project. staging: roles/aiplatform.user on the project, roles/datastore.user limited to its own database by an IAM condition, roles/discoveryengine.viewer on its own engine only. Both: roles/cloudsql.client limited to their own accounts instance by an IAM condition."
  value       = google_service_account.runtime["api"].email
}

output "tts_runtime_service_account_email" {
  description = "Runtime identity of onboardai-tts. Holds no roles."
  value       = google_service_account.runtime["tts"].email
}

output "artifact_registry_image_prefix" {
  description = "Image path prefix; images are <prefix>/<web|api|tts>:<git-sha>."
  value       = "${google_artifact_registry_repository.onboardai.location}-docker.pkg.dev/${google_artifact_registry_repository.onboardai.project}/${google_artifact_registry_repository.onboardai.repository_id}"
}

output "service_urls" {
  description = "HTTPS URL of each Cloud Run service."
  value       = { for key, service in google_cloud_run_v2_service.service : service.name => service.uri }
}

output "github_variable_commands" {
  description = "Run these yourself (needs gh with admin rights on the repository) to set every variable the workflows read: repository variables for production, variables of the GitHub environment of the same name for staging (create it first: github_environment_commands)."
  value       = join("\n", [for name, value in local.github_variables : "gh variable set ${name}${local.github_variable_scope} --repo ${var.github_repository} --body '${value}'"])
}

# null in production, which keeps its repository variables and needs no setup.
output "github_environment_commands" {
  description = "Staging only (null in production). Run these yourself before github_variable_commands: they create the GitHub environment the deploy jobs read staging's variables from, and let only the staging branch deploy to it."
  value = local.is_production ? null : join("\n", [
    "gh api -X PUT repos/${var.github_repository}/environments/${var.environment} -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'",
    "gh api -X POST repos/${var.github_repository}/environments/${var.environment}/deployment-branch-policies -f name=${local.github_deploy_branch} -f type=branch",
  ])
}

output "cloud_run_deploy_flags" {
  description = "gcloud run deploy flags per service. .github/workflows/deploy.yml must carry the same strings (checked by terraform test)."
  value       = local.cloud_run_deploy_flags
}

output "docs_bucket_name" {
  description = "Bucket the team uploads documents to (gs://<name>/). HR uploads through the app; docs_reconcile_run_command checks the bucket, Firestore and the index against each other."
  value       = google_storage_bucket.docs.name
}

output "employee_documents_bucket_name" {
  description = "Private bucket for employee document submissions (never attached to Vertex AI Search)."
  value       = google_storage_bucket.employee_docs.name
}

output "vertex_search_data_store_id" {
  description = "Vertex AI Search data store ID (location global, collection default_collection)."
  value       = google_discovery_engine_data_store.docs.data_store_id
}

output "vertex_search_serving_config" {
  description = "Full serving config name onboardai-api searches (VERTEX_SEARCH_LOCATION and VERTEX_SEARCH_ENGINE_ID point at it)."
  value       = local.serving_config_name
}

output "firestore_database_id" {
  description = "Firestore database of the API (repository variable FIRESTORE_DATABASE_ID)."
  value       = google_firestore_database.default.name
}

# Replaces import_documents_command (#79), which imported the whole bucket and so
# put orphaned and retired files back into the index. The reconcile job only
# ever imports the explicit URIs of active entries.
output "docs_reconcile_run_command" {
  description = "Runs the document reconciliation job once and waits for it (read-only while the job is in report mode, docs_reconcile_mode). Needs gcloud logged in as a user with Cloud Run Developer on the job. Read the result in Cloud Logging: event onboardai_docs_reconcile."
  value       = "gcloud run jobs execute ${google_cloud_run_v2_job.docs_reconcile.name} --project=${var.project_id} --region=${var.region} --wait"
}

output "docs_reconcile_mode" {
  description = "Mode of the document reconciliation job: report (reads, changes nothing) or apply (repairs drift). Set in docs_reconcile.tf."
  value       = local.docs_reconcile_mode
}

# ---------------------------------------------------------------------------
# Employee accounts (every environment, #45) and the intake agent (staging
# only, #30). Names only, never a secret value. The intake agent's are null in
# production.
# ---------------------------------------------------------------------------

output "cloud_sql_instance_connection_name" {
  description = "Connection name of the accounts Cloud SQL instance (project:region:instance). The deploy workflow passes it to the api as --set-cloudsql-instances; the HR bootstrap passes it to the Cloud SQL Auth Proxy."
  value       = local.employee_accounts ? google_sql_database_instance.accounts[0].connection_name : null
}

output "accounts_secret_ids" {
  description = "Secret Manager secret IDs (values are never output): db_password (the database user's, for the HR bootstrap), database_url (DATABASE_URL of the api and the migration job), intake_mcp_token (INTAKE_MCP_TOKEN of the api and the agent; null where the intake agent does not run)."
  value = local.employee_accounts ? {
    db_password      = google_secret_manager_secret.accounts["db_password"].secret_id
    database_url     = google_secret_manager_secret.accounts["database_url"].secret_id
    intake_mcp_token = local.intake_agent ? google_secret_manager_secret.intake_mcp_token[0].secret_id : null
  } : null
}

output "db_migrate_job_name" {
  description = "Cloud Run job that runs npm run db:migrate (Cloud SQL, then Firestore) from the api image before each deploy."
  value       = local.employee_accounts ? google_cloud_run_v2_job.db_migrate[0].name : null
}

output "db_migrate_log_view" {
  description = "Cloud Logging view (bucket _Default, location global) of the migration job's output; the deploy workflow reads it with gcloud logging read --view."
  value       = local.employee_accounts ? google_logging_log_view.db_migrate[0].name : null
}

output "intake_agent_service_account_email" {
  description = "Runtime service account of the intake agent on Agent Engine (--service-account of npm run intake-agent:deploy)."
  value       = local.intake_agent ? google_service_account.intake_agent[0].email : null
}

output "intake_agent_deploy_settings" {
  description = "What the deploy workflow passes to npm run intake-agent:deploy, besides --mcp-url (<api URL>/mcp, read at deploy time) and --model."
  value = local.intake_agent ? {
    location         = var.intake_agent_location
    display_name     = local.intake_agent_display_name
    service_account  = google_service_account.intake_agent[0].email
    mcp_token_secret = google_secret_manager_secret.intake_mcp_token[0].secret_id
  } : null
}

output "checklist_agent_service_account_email" {
  description = "Runtime service account of the onboarding checklist agent on Agent Engine (--service-account of npm run checklist-agent:deploy); null where the agent is off."
  value       = local.checklist_agent ? google_service_account.checklist_agent[0].email : null
}

output "checklist_agent_deploy_settings" {
  description = "What the deploy workflow passes to npm run checklist-agent:deploy; null where the agent is off."
  value = local.checklist_agent ? {
    location           = var.intake_agent_location
    display_name       = local.checklist_agent_display_name
    service_account    = google_service_account.checklist_agent[0].email
    firestore_database = local.firestore_database_name
  } : null
}
