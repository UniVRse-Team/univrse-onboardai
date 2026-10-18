# Offline checks of the staging environment (issue #20): `terraform test` in
# terraform/onboardai. Providers are mocked as in tests/onboardai.tftest.hcl,
# which keeps checking production; nothing here relaxes a production check.
#
# Staging shares the OnBoard AI project with production, so these runs check
# that every staging name is its own, that the staging deploy identity reaches
# only staging resources, and that the staging api cannot reach production's
# Firestore database or search engine.

mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  environment  = "staging"
  project_id   = "onboardai-test-123"
  alert_emails = ["alerts-a@example.com", "alerts-b@example.com"]
}

# terraform test runs in whichever workspace is selected; the guard is tested
# on its own in tests/state_guard.tftest.hcl.
override_module {
  target = module.state_guard
}

override_data {
  target = data.google_project.this
  values = {
    number = "123456789012"
  }
}

# Well-formed staging stand-ins, distinct from production's, so a grant that
# points at the wrong account or resource fails the assertions below.
override_resource {
  target = google_service_account.deployer
  values = {
    email = "onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.runtime["web"]
  values = {
    email = "onboardai-web-run-staging@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-web-run-staging@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.runtime["api"]
  values = {
    email = "onboardai-api-run-staging@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-api-run-staging@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.runtime["tts"]
  values = {
    email = "onboardai-tts-run-staging@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-tts-run-staging@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.checklist_agent[0]
  values = {
    email = "onboardai-checklist-staging@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-checklist-staging@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.intake_agent[0]
  values = {
    email = "onboardai-intake-staging@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-intake-staging@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_iam_workload_identity_pool.github
  values = {
    name = "projects/123456789012/locations/global/workloadIdentityPools/onboardai-github-staging"
  }
}

override_resource {
  target = google_iam_workload_identity_pool_provider.github
  values = {
    name = "projects/123456789012/locations/global/workloadIdentityPools/onboardai-github-staging/providers/github-actions-staging"
  }
}

override_resource {
  target = google_artifact_registry_repository.onboardai
  values = {
    name    = "onboardai-staging"
    project = "onboardai-test-123"
  }
}

override_resource {
  target = google_cloud_run_v2_service.service["web"]
  values = {
    uri = "https://onboardai-web-staging-abc123xyz-as.a.run.app"
  }
}

# Production's values, for the parity checks below.
run "production_reference" {
  command = plan

  variables {
    environment = "production"
  }
}

run "staging_names_carry_the_suffix" {
  command = apply

  assert {
    condition = (
      { for k, s in google_cloud_run_v2_service.service : k => s.name } == { web = "onboardai-web-staging", api = "onboardai-api-staging", tts = "onboardai-tts-staging" } &&
      { for k, a in google_service_account.runtime : k => a.account_id } == { web = "onboardai-web-run-staging", api = "onboardai-api-run-staging", tts = "onboardai-tts-run-staging" } &&
      google_service_account.deployer.account_id == "onboardai-deployer-staging" &&
      google_artifact_registry_repository.onboardai.repository_id == "onboardai-staging" &&
      google_iam_workload_identity_pool.github.workload_identity_pool_id == "onboardai-github-staging" &&
      google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id == "github-actions-staging" &&
      google_storage_bucket.docs.name == "onboardai-test-123-onboardai-docs-staging" &&
      google_storage_bucket.employee_docs.name == "onboardai-test-123-onboardai-employee-docs-staging" &&
      google_discovery_engine_data_store.docs.data_store_id == "onboardai-docs-staging" &&
      google_discovery_engine_search_engine.docs.engine_id == "onboardai-search-staging" &&
      google_discovery_engine_search_engine.docs.data_store_ids == tolist(["onboardai-docs-staging"]) &&
      google_firestore_database.default.name == "onboardai-staging"
    )
    error_message = "Every staging resource ID is its production ID with -staging appended (Firestore: the named database onboardai-staging)."
  }

  # GCP limits: service account IDs 6-30, pool and provider IDs 4-32 and their
  # display names at most 32, bucket names at most 63 characters.
  assert {
    condition = (
      alltrue([for id in concat([for a in google_service_account.runtime : a.account_id], [google_service_account.deployer.account_id]) : length(id) >= 6 && length(id) <= 30]) &&
      length(google_iam_workload_identity_pool.github.workload_identity_pool_id) <= 32 &&
      length(google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id) <= 32 &&
      length(google_iam_workload_identity_pool.github.display_name) <= 32 &&
      length(google_iam_workload_identity_pool_provider.github.display_name) <= 32 &&
      length(google_storage_bucket.docs.name) <= 63 &&
      length(google_storage_bucket.employee_docs.name) <= 63
    )
    error_message = "A staging ID or display name exceeds its GCP length limit."
  }

  assert {
    condition = alltrue([
      for labels in concat(
        [for s in google_cloud_run_v2_service.service : s.labels],
        [google_artifact_registry_repository.onboardai.labels, google_storage_bucket.docs.labels, google_storage_bucket.employee_docs.labels, google_monitoring_alert_policy.server_errors.user_labels, google_monitoring_alert_policy.api_latency.user_labels, google_monitoring_alert_policy.uptime.user_labels],
        [for c in google_monitoring_notification_channel.email : c.user_labels],
        [for c in google_monitoring_uptime_check_config.health : c.user_labels],
      ) : labels.environment == "staging" && labels.app == "onboardai" && labels["managed-by"] == "terraform"
    ])
    error_message = "Every labelled staging resource carries environment = staging."
  }

  assert {
    condition = alltrue([
      for n in concat(
        [for a in google_service_account.runtime : a.display_name],
        [for c in google_monitoring_notification_channel.email : c.display_name],
        [for c in google_monitoring_uptime_check_config.health : c.display_name],
        [google_service_account.deployer.display_name, google_discovery_engine_data_store.docs.display_name, google_discovery_engine_search_engine.docs.display_name, google_monitoring_alert_policy.server_errors.display_name, google_monitoring_alert_policy.api_latency.display_name, google_monitoring_alert_policy.uptime.display_name, google_iam_workload_identity_pool.github.display_name, google_iam_workload_identity_pool_provider.github.display_name],
      ) : strcontains(n, "[staging]")
    ])
    error_message = "Every staging display name says [staging]."
  }

  assert {
    condition = (
      output.artifact_registry_image_prefix == "asia-southeast1-docker.pkg.dev/onboardai-test-123/onboardai-staging" &&
      output.vertex_search_serving_config == "projects/123456789012/locations/global/collections/default_collection/engines/onboardai-search-staging/servingConfigs/default_search" &&
      output.firestore_database_id == "onboardai-staging" &&
      output.docs_bucket_name == "onboardai-test-123-onboardai-docs-staging" &&
      output.employee_documents_bucket_name == "onboardai-test-123-onboardai-employee-docs-staging" &&
      output.docs_reconcile_run_command == "gcloud run jobs execute onboardai-docs-reconcile-staging --project=onboardai-test-123 --region=asia-southeast1 --wait"
    )
    error_message = "Staging outputs point at staging resources only."
  }
}

run "staging_wif_trusts_only_the_staging_branch" {
  command = apply

  assert {
    condition = google_iam_workload_identity_pool_provider.github.attribute_condition == join(" && ", [
      "assertion.repository_id == '1418194026'",
      "assertion.repository_owner_id == '283518526'",
      "assertion.ref == 'refs/heads/staging'",
      "assertion.workflow_ref == 'UniVRse-Team/univrse-onboardai/.github/workflows/deploy.yml@refs/heads/staging'",
      "(assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')",
    ])
    error_message = "The staging provider accepts only repository 1418194026 (owner 283518526), ref refs/heads/staging, deploy.yml on staging, push or workflow_dispatch."
  }

  assert {
    condition     = !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "refs/heads/main") && !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.sub")
    error_message = "The staging provider must never accept main, and must not depend on the sub claim (the GitHub environment changes it)."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.repository_id"] == "assertion.repository_id" && google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
    error_message = "The staging provider maps repository_id and trusts GitHub's OIDC issuer."
  }

  assert {
    condition = (
      google_service_account_iam_member.deployer_federation.member == "principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/onboardai-github-staging/attribute.repository_id/1418194026" &&
      google_service_account_iam_member.deployer_federation.role == "roles/iam.workloadIdentityUser" &&
      google_service_account_iam_member.deployer_federation.service_account_id == google_service_account.deployer.name
    )
    error_message = "Only principals of the staging pool (this repository ID) may impersonate the staging deployer, and only it."
  }
}

run "staging_deployer_has_no_production_binding" {
  command = apply

  # Production's names, which no staging grant may name.
  assert {
    condition = (
      length(google_cloud_run_v2_service_iam_member.deployer) == 3 &&
      alltrue([
        for key, m in google_cloud_run_v2_service_iam_member.deployer :
        m.role == "roles/run.developer" && m.member == "serviceAccount:onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com" && m.name == "onboardai-${key}-staging"
      ])
    )
    error_message = "The staging deployer holds Cloud Run Developer on the three staging services only."
  }

  assert {
    condition = (
      google_artifact_registry_repository_iam_member.deployer_pushes_images.repository == google_artifact_registry_repository.onboardai.name &&
      google_artifact_registry_repository.onboardai.repository_id == "onboardai-staging" &&
      google_artifact_registry_repository_iam_member.deployer_pushes_images.role == "roles/artifactregistry.writer" &&
      google_artifact_registry_repository_iam_member.deployer_pushes_images.member == "serviceAccount:onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com"
    )
    error_message = "The staging deployer writes to onboardai-staging only, never to onboardai."
  }

  assert {
    condition = (
      length(google_service_account_iam_member.deployer_acts_as_runtime) == 3 &&
      alltrue([
        for key, m in google_service_account_iam_member.deployer_acts_as_runtime :
        m.role == "roles/iam.serviceAccountUser" && m.service_account_id == "projects/onboardai-test-123/serviceAccounts/onboardai-${key}-run-staging@onboardai-test-123.iam.gserviceaccount.com" && m.member == "serviceAccount:onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com"
      ])
    )
    error_message = "The staging deployer may act as the three staging runtime accounts only."
  }

  assert {
    condition = alltrue(flatten([
      [for m in google_cloud_run_v2_service_iam_member.deployer : !contains(["onboardai-web", "onboardai-api", "onboardai-tts"], m.name)],
      [google_artifact_registry_repository_iam_member.deployer_pushes_images.repository != "onboardai"],
      [for m in google_service_account_iam_member.deployer_acts_as_runtime : !can(regex("/onboardai-(web|api|tts)-run@", m.service_account_id))],
    ]))
    error_message = "No staging deployer grant names a production service, repository or service account."
  }

  assert {
    condition     = alltrue([for m in google_project_iam_member.api_runtime : m.member == "serviceAccount:onboardai-api-run-staging@onboardai-test-123.iam.gserviceaccount.com"])
    error_message = "The web and tts accounts hold no project-level role, and api_runtime is the staging api's only."
  }

  # #30: the staging deployer's one project role, for creating and updating the
  # intake agent on Agent Engine (no resource-level grant exists for that).
  assert {
    condition = (
      length(google_project_iam_member.deployer_deploys_agents) == 1 &&
      google_project_iam_member.deployer_deploys_agents[0].role == "roles/aiplatform.user" &&
      google_project_iam_member.deployer_deploys_agents[0].member == "serviceAccount:onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com" &&
      length(google_project_iam_member.deployer_deploys_agents[0].condition) == 0
    )
    error_message = "The staging deployer holds exactly one project role, roles/aiplatform.user, to deploy the intake agent."
  }

  assert {
    condition = (
      length(google_service_account_iam_member.deployer_acts_as_intake_agent) == 1 &&
      google_service_account_iam_member.deployer_acts_as_intake_agent[0].role == "roles/iam.serviceAccountUser" &&
      google_service_account_iam_member.deployer_acts_as_intake_agent[0].service_account_id == "projects/onboardai-test-123/serviceAccounts/onboardai-intake-staging@onboardai-test-123.iam.gserviceaccount.com" &&
      google_service_account_iam_member.deployer_acts_as_intake_agent[0].member == "serviceAccount:onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com"
    )
    error_message = "The staging deployer may act as the staging intake agent account, and as no production account."
  }
}

# The reverse holds since #56: production's onboardai-api-run reaches only
# (default) and onboardai-search (tests/onboardai.tftest.hcl,
# api_runtime_holds_exactly_three_project_roles).
run "staging_api_cannot_reach_production_data" {
  command = apply

  assert {
    condition     = toset(keys(google_project_iam_member.api_runtime)) == toset(["roles/aiplatform.user", "roles/datastore.user", "roles/cloudsql.client", "roles/discoveryengine.editor"])
    error_message = "On the project, the staging api holds Gemini and Discovery Engine Editor (unconditioned), and Firestore and Cloud SQL Client (both conditioned)."
  }

  assert {
    condition = alltrue([
      for role, m in google_project_iam_member.api_runtime :
      length(m.condition) == 1 if can(regex("^roles/(datastore|firestore|cloudsql)\\.", role))
    ])
    error_message = "Every Firestore or Cloud SQL role the staging api holds on the project carries an IAM condition."
  }

  assert {
    condition = (
      google_project_iam_member.api_runtime["roles/cloudsql.client"].condition[0].expression == "resource.name == \"projects/onboardai-test-123/instances/onboardai-db-staging\" && resource.type == \"sqladmin.googleapis.com/Instance\"" &&
      google_sql_database_instance.accounts[0].name == "onboardai-db-staging"
    )
    error_message = "roles/cloudsql.client is limited to exactly the staging accounts instance, onboardai-db-staging."
  }

  assert {
    condition     = length(google_project_iam_member.api_runtime["roles/aiplatform.user"].condition) == 0
    error_message = "Gemini (roles/aiplatform.user) stays unconditioned; Vertex AI has no narrower grant."
  }

  assert {
    condition = (
      google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].expression == "resource.name == \"projects/onboardai-test-123/databases/onboardai-staging\" || resource.name == \"projects/123456789012/databases/onboardai-staging\"" &&
      !strcontains(google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].expression, "(default)") &&
      !strcontains(google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].expression, "startsWith")
    )
    error_message = "roles/datastore.user is limited to exactly the onboardai-staging database (by project ID or number), never (default)."
  }

  # Title and description are part of the binding: changing either would
  # replace staging's grant, so they stay as applied (#20).
  assert {
    condition = (
      google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].title == "onboardai-staging database only" &&
      google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].description == "Firestore access for the staging api: the onboardai-staging database, never (default)."
    )
    error_message = "Staging's Firestore condition keeps the title and description it was applied with."
  }

  assert {
    condition = (
      length(google_discovery_engine_search_engine_iam_member.api_searches_engine) == 1 &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].engine_id == "onboardai-search-staging" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].collection_id == "default_collection" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].location == "global" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].role == "roles/discoveryengine.viewer" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].member == "serviceAccount:onboardai-api-run-staging@onboardai-test-123.iam.gserviceaccount.com"
    )
    error_message = "The staging api searches through roles/discoveryengine.viewer on onboardai-search-staging alone."
  }
}

# #57: staging's invokers are production's on the staging services, plus the
# intake agent on the staging api (its /mcp calls). No staging account may
# invoke a production service.
run "staging_services_are_private_except_web" {
  command = apply

  assert {
    condition = toset(concat(
      [for m in google_cloud_run_v2_service_iam_member.public_invoker : "${m.name} ${m.member}"],
      [for m in google_cloud_run_v2_service_iam_member.runtime_invoker : "${m.name} ${m.member}"],
      [for m in google_cloud_run_v2_service_iam_member.intake_agent_invokes_api : "${m.name} ${m.member}"],
      )) == toset([
      "onboardai-web-staging allUsers",
      "onboardai-api-staging serviceAccount:onboardai-web-run-staging@onboardai-test-123.iam.gserviceaccount.com",
      "onboardai-tts-staging serviceAccount:onboardai-api-run-staging@onboardai-test-123.iam.gserviceaccount.com",
      "onboardai-api-staging serviceAccount:onboardai-intake-staging@onboardai-test-123.iam.gserviceaccount.com",
    ])
    error_message = "Staging's invokers: allUsers on web, onboardai-web-run-staging on the api, onboardai-api-run-staging on tts, onboardai-intake-staging on the api."
  }

  assert {
    condition = alltrue([
      for m in concat(
        values(google_cloud_run_v2_service_iam_member.runtime_invoker),
        google_cloud_run_v2_service_iam_member.intake_agent_invokes_api,
      ) : m.role == "roles/run.invoker" && endswith(m.name, "-staging") && endswith(split("@", m.member)[0], "-staging")
    ]) && length(google_cloud_run_v2_service_iam_member.intake_agent_invokes_api) == 1
    error_message = "Every staging invoker grant is roles/run.invoker from a staging account on a staging service."
  }
}

run "singletons_stay_in_production_state" {
  command = apply

  assert {
    condition     = length(google_project_service.required) == 0
    error_message = "API enablement is project-wide: production's state manages it, staging's must not."
  }

  # The Cloud SQL Admin API, enabled by staging's state for #30, is
  # production's since #45 (local.apis); main.tf's removed block drops it from
  # staging's state without disabling it.
  assert {
    condition = (
      can(regex("(?m)^removed \\{\\n  from = google_project_service\\.accounts\\n\\n  lifecycle \\{\\n    destroy = false\\n  \\}\\n\\}", file("${path.module}/main.tf"))) &&
      !can(regex("resource\\s+\"google_project_service\"\\s+\"accounts\"", file("${path.module}/main.tf")))
    )
    error_message = "Staging's state no longer manages the Cloud SQL Admin API: google_project_service.accounts is a removed block with destroy = false."
  }

  assert {
    condition     = length(google_project_service_identity.discovery_engine) == 0
    error_message = "The Discovery Engine service agent is project-wide: production's state manages it, staging's must not."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.discovery_engine_reads_docs.member == "serviceAccount:service-123456789012@gcp-sa-discoveryengine.iam.gserviceaccount.com" &&
      google_storage_bucket_iam_member.discovery_engine_reads_docs.bucket == "onboardai-test-123-onboardai-docs-staging" &&
      google_storage_bucket_iam_member.discovery_engine_reads_docs.role == "roles/storage.objectViewer"
    )
    error_message = "Staging's bucket grant goes to the existing service agent, on the staging bucket only."
  }
}

run "staging_has_production_shape" {
  command = apply

  assert {
    condition     = output.cloud_run_deploy_flags == run.production_reference.cloud_run_deploy_flags
    error_message = "Staging's Cloud Run settings must equal production's (one set of *_RUN_FLAGS in deploy.yml serves both)."
  }

  assert {
    condition = alltrue([
      for k, s in google_cloud_run_v2_service.service :
      s.location == "asia-southeast1" && s.ingress == "INGRESS_TRAFFIC_ALL" && s.template[0].service_account == google_service_account.runtime[k].email && s.template[0].scaling[0].min_instance_count == 0 && s.deletion_protection == true
    ]) && google_cloud_run_v2_service.service["api"].template[0].scaling[0].max_instance_count == 1
    error_message = "Staging services run like production's: region, public ingress, own runtime account, scale to zero, api capped at one, deletion protection."
  }

  assert {
    condition     = keys(google_cloud_run_v2_service_iam_member.public_invoker) == ["web"] && alltrue([for m in google_cloud_run_v2_service_iam_member.public_invoker : m.member == "allUsers" && m.name == "onboardai-web-staging"])
    error_message = "Like production's, only staging's web is public; its api and tts are private (#57)."
  }

  assert {
    condition = (
      google_firestore_database.default.type == "FIRESTORE_NATIVE" &&
      google_firestore_database.default.location_id == "asia-southeast1" &&
      google_firestore_database.default.delete_protection_state == "DELETE_PROTECTION_ENABLED" &&
      google_firestore_database.default.deletion_policy == "ABANDON"
    )
    error_message = "Staging Firestore: Native mode, asia-southeast1, delete protection and ABANDON like production."
  }

  # Unlike production (#56, tests/onboardai.tftest.hcl): staging's data needs
  # no recovery, so it skips the PITR version storage.
  assert {
    condition     = google_firestore_database.default.point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_DISABLED"
    error_message = "Staging Firestore keeps point-in-time recovery off (production has it on)."
  }

  assert {
    condition = (
      length(google_discovery_engine_data_store.docs.document_processing_config[0].default_parsing_config[0].layout_parsing_config) == 1 &&
      google_discovery_engine_data_store.docs.document_processing_config[0].chunking_config[0].layout_based_chunking_config[0].chunk_size == 500 &&
      google_discovery_engine_data_store.docs.document_processing_config[0].chunking_config[0].layout_based_chunking_config[0].include_ancestor_headings == true &&
      google_discovery_engine_data_store.docs.content_config == "CONTENT_REQUIRED" &&
      google_discovery_engine_search_engine.docs.search_engine_config[0].search_tier == "SEARCH_TIER_ENTERPRISE" &&
      google_discovery_engine_data_store.docs.deletion_policy == "PREVENT" &&
      google_discovery_engine_search_engine.docs.deletion_policy == "PREVENT"
    )
    error_message = "Staging search has production's parity: layout parser, 500-token chunks with headings, Enterprise tier, PREVENT."
  }

  assert {
    condition = (
      google_storage_bucket.docs.uniform_bucket_level_access == true &&
      google_storage_bucket.docs.public_access_prevention == "enforced" &&
      google_storage_bucket.docs.versioning[0].enabled == true &&
      google_storage_bucket.docs.force_destroy == false &&
      google_storage_bucket.employee_docs.uniform_bucket_level_access == true &&
      google_storage_bucket.employee_docs.public_access_prevention == "enforced" &&
      google_storage_bucket.employee_docs.versioning[0].enabled == true &&
      google_storage_bucket.employee_docs.force_destroy == false &&
      google_storage_bucket_iam_member.api_manages_employee_docs.bucket == "onboardai-test-123-onboardai-employee-docs-staging" &&
      google_storage_bucket_iam_member.api_manages_employee_docs.role == "roles/storage.objectUser" &&
      google_storage_bucket_iam_member.api_manages_employee_docs.member == "serviceAccount:onboardai-api-run-staging@onboardai-test-123.iam.gserviceaccount.com" &&
      length(google_artifact_registry_repository.onboardai.cleanup_policies) == 2
    )
    error_message = "Staging bucket and repository keep production's protections, cleanup policies and employee documents IAM."
  }
}

run "staging_alerts_watch_staging_services" {
  command = apply

  assert {
    condition = (
      strcontains(google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].filter, "resource.label.service_name = one_of(\"onboardai-api-staging\", \"onboardai-tts-staging\")") &&
      strcontains(google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].filter, "resource.label.service_name = \"onboardai-api-staging\"") &&
      !strcontains(google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].filter, "\"onboardai-api\"") &&
      !strcontains(google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].filter, "\"onboardai-api\"")
    )
    error_message = "Staging alerts watch the staging services only."
  }

  assert {
    condition = (
      startswith(google_monitoring_alert_policy.server_errors.display_name, "OnboardAi [staging]: ") &&
      startswith(google_monitoring_alert_policy.api_latency.display_name, "OnboardAi [staging]: ") &&
      startswith(google_monitoring_alert_policy.api_latency.documentation[0].subject, "OnboardAi [staging]: ") &&
      toset(keys(google_monitoring_notification_channel.email)) == toset(["alerts-a@example.com", "alerts-b@example.com"]) &&
      alltrue([for p in [google_monitoring_alert_policy.server_errors, google_monitoring_alert_policy.api_latency] : toset(p.notification_channels) == toset([for c in google_monitoring_notification_channel.email : c.name])])
    )
    error_message = "Staging alerts say [staging] and reach every alert address through staging's own channels."
  }

  # #56: staging's own uptime checks, on the staging web host only.
  assert {
    condition = (
      toset(keys(google_monitoring_uptime_check_config.health)) == toset(["web", "api"]) &&
      google_monitoring_uptime_check_config.health["web"].display_name == "OnboardAi [staging]: onboardai-web-staging /web-health" &&
      google_monitoring_uptime_check_config.health["api"].display_name == "OnboardAi [staging]: onboardai-api-staging /api/health through onboardai-web-staging" &&
      alltrue([
        for c in google_monitoring_uptime_check_config.health :
        c.monitored_resource[0].labels == tomap({ project_id = "onboardai-test-123", host = "onboardai-web-staging-abc123xyz-as.a.run.app" })
      ])
    )
    error_message = "Staging's uptime checks are its own ([staging]) and check the staging web host only."
  }

  assert {
    condition = (
      google_monitoring_alert_policy.uptime.display_name == "OnboardAi [staging]: uptime checks failing (/web-health, /api/health)" &&
      startswith(google_monitoring_alert_policy.uptime.documentation[0].subject, "OnboardAi [staging]: ") &&
      strcontains(google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].filter, format("metric.label.check_id = one_of(%s)", join(", ", [for c in google_monitoring_uptime_check_config.health : "\"${c.uptime_check_id}\""]))) &&
      toset(google_monitoring_alert_policy.uptime.notification_channels) == toset([for c in google_monitoring_notification_channel.email : c.name])
    )
    error_message = "Staging's uptime alert says [staging], watches staging's two checks and reaches staging's channels."
  }
}

run "staging_outputs_carry_the_setup_commands" {
  command = apply

  assert {
    condition = toset([for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) --env staging --repo UniVRse-Team/univrse-onboardai --body '[^']*'$", output.github_variable_commands) : m[0]]) == toset([
      "GCP_PROJECT_ID", "GCP_REGION", "GCP_WIF_PROVIDER", "GCP_DEPLOYER_SA", "AI_MODE", "GEMINI_MODEL",
      "VERTEX_SEARCH_LOCATION", "VERTEX_SEARCH_ENGINE_ID", "FIRESTORE_DATABASE_ID",
    ]) && length(split("\n", output.github_variable_commands)) == 9
    error_message = "One gh command per variable, each scoped to the staging GitHub environment (--env staging), and nothing else."
  }

  assert {
    condition = (
      strcontains(output.github_variable_commands, "gh variable set GCP_WIF_PROVIDER --env staging --repo UniVRse-Team/univrse-onboardai --body 'projects/123456789012/locations/global/workloadIdentityPools/onboardai-github-staging/providers/github-actions-staging'") &&
      strcontains(output.github_variable_commands, "gh variable set GCP_DEPLOYER_SA --env staging --repo UniVRse-Team/univrse-onboardai --body 'onboardai-deployer-staging@onboardai-test-123.iam.gserviceaccount.com'") &&
      strcontains(output.github_variable_commands, "gh variable set VERTEX_SEARCH_ENGINE_ID --env staging --repo UniVRse-Team/univrse-onboardai --body 'onboardai-search-staging'") &&
      strcontains(output.github_variable_commands, "gh variable set FIRESTORE_DATABASE_ID --env staging --repo UniVRse-Team/univrse-onboardai --body 'onboardai-staging'") &&
      strcontains(output.github_variable_commands, "gh variable set VERTEX_SEARCH_LOCATION --env staging --repo UniVRse-Team/univrse-onboardai --body 'global'") &&
      strcontains(output.github_variable_commands, "gh variable set GCP_PROJECT_ID --env staging --repo UniVRse-Team/univrse-onboardai --body 'onboardai-test-123'")
    )
    error_message = "Staging variables name staging's provider, deployer, engine and database."
  }

  assert {
    condition = output.github_environment_commands == join("\n", [
      "gh api -X PUT repos/UniVRse-Team/univrse-onboardai/environments/staging -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'",
      "gh api -X POST repos/UniVRse-Team/univrse-onboardai/environments/staging/deployment-branch-policies -f name=staging -f type=branch",
    ])
    error_message = "The staging setup creates the staging GitHub environment and lets only the staging branch deploy to it."
  }
}

# ---------------------------------------------------------------------------
# deploy.yml against staging (tests/workflows.tftest.hcl covers production)
# ---------------------------------------------------------------------------

# The suffix and branch deploy.yml uses for staging are the ones Terraform gives
# staging's names and WIF condition.
run "staging_deploy_names_match_terraform" {
  command = apply

  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).env.NAME_SUFFIX == format("$${{ github.ref == '%s' && '%s' || '' }}", regex("assertion\\.ref == '([^']+)'", google_iam_workload_identity_pool_provider.github.attribute_condition)[0], trimprefix(google_service_account.deployer.account_id, "onboardai-deployer")) &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).env.DEPLOY_ENV == format("$${{ github.ref == '%s' && '%s' || 'production' }}", regex("assertion\\.ref == '([^']+)'", google_iam_workload_identity_pool_provider.github.attribute_condition)[0], var.environment)
    )
    error_message = "deploy.yml's NAME_SUFFIX and DEPLOY_ENV must map the branch staging's WIF provider trusts to staging's suffix and name."
  }

  assert {
    condition = alltrue([
      for key, s in google_cloud_run_v2_service.service :
      s.name == "onboardai-${key}-staging" && google_service_account.runtime[key].account_id == "onboardai-${key}-run-staging"
    ]) && google_artifact_registry_repository.onboardai.repository_id == "onboardai-staging"
    error_message = "Staging's services, runtime accounts and repository must be the names deploy.yml computes with NAME_SUFFIX=-staging."
  }

  # Every staging value Terraform hands out passes the config job's checks.
  assert {
    condition = toset(flatten([
      for f in fileset("${path.module}/../../.github/workflows", "*.{yml,yaml}") : [
        for m in regexall("vars\\.([A-Za-z0-9_]+)", file("${path.module}/../../.github/workflows/${f}")) : m[0]
      ]
      ])) == setunion(
      toset([for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) --env staging ", output.github_variable_commands) : m[0]]),
      toset(["VOICE_PROVIDER", "GEMINI_TTS_MODEL", "GEMINI_TTS_LOCATION", "GEMINI_TTS_VOICE", "CHECKLIST_AGENT_ENABLED"])
    )
    error_message = "The staging gh commands must cover exactly the vars.* the workflows read, except the optional voice (#52) and CHECKLIST_AGENT_ENABLED (#51) variables, which have defaults in deploy.yml."
  }

  assert {
    condition = alltrue([
      for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) --env staging --repo [^ ]+ --body '([^']*)'$", output.github_variable_commands) :
      can(regex(regex(format("check %s \"\\$%s\" '([^']+)'", m[0], m[0]), file("${path.module}/../../.github/workflows/deploy.yml"))[0], m[1]))
      if contains(["GCP_PROJECT_ID", "GCP_REGION", "AI_MODE", "GEMINI_MODEL", "VERTEX_SEARCH_LOCATION", "VERTEX_SEARCH_ENGINE_ID", "FIRESTORE_DATABASE_ID"], m[0])
    ])
    error_message = "A staging value Terraform hands out would fail the config job's check in deploy.yml."
  }

  assert {
    condition = alltrue([
      for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) --env staging --repo [^ ]+ --body '([^']*)'$", output.github_variable_commands) :
      endswith(m[1], "-staging") if contains(["GCP_WIF_PROVIDER", "VERTEX_SEARCH_ENGINE_ID", "FIRESTORE_DATABASE_ID"], m[0])
    ]) && can(regex("^onboardai-deployer-staging@onboardai-test-123\\.iam\\.gserviceaccount\\.com$", google_service_account.deployer.email))
    error_message = "Staging's provider, engine, database and deployer pass the config job's staging checks."
  }
}
