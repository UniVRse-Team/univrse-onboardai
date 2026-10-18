# Offline checks of the OnboardAi stack: `terraform test` in terraform/onboardai.
# The google and google-beta providers are mocked, so nothing is read from or
# created in GCP. `command = apply` against the mock fills computed values
# (emails, resource names) with stand-ins, so references between resources can
# be compared.
#
# This file checks the production environment (var.environment's default);
# tests/staging.tftest.hcl checks staging.

mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  project_id   = "onboardai-test-123"
  alert_emails = ["alerts-a@example.com", "alerts-b@example.com"]
}

# terraform test runs in whichever workspace is selected, so the workspace guard
# is replaced here; tests/state_guard.tftest.hcl tests it directly, and the run
# state_guard_is_wired_to_the_workspace below checks its inputs.
override_module {
  target = module.state_guard
}

override_data {
  target = data.google_project.this
  values = {
    number = "123456789012"
  }
}

# Distinct, well-formed stand-ins (the provider validates service account IDs),
# so a grant that points at the wrong account fails the assertions below.
override_resource {
  target = google_service_account.checklist_agent[0]
  values = {
    email = "onboardai-checklist@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-checklist@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.deployer
  values = {
    email = "onboardai-deployer@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-deployer@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.runtime["web"]
  values = {
    email = "onboardai-web-run@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-web-run@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.runtime["api"]
  values = {
    email = "onboardai-api-run@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-api-run@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.runtime["tts"]
  values = {
    email = "onboardai-tts-run@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-tts-run@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_iam_workload_identity_pool.github
  values = {
    name = "projects/123456789012/locations/global/workloadIdentityPools/onboardai-github"
  }
}

override_resource {
  target = google_iam_workload_identity_pool_provider.github
  values = {
    name = "projects/123456789012/locations/global/workloadIdentityPools/onboardai-github/providers/github-actions"
  }
}

override_resource {
  target = google_artifact_registry_repository.onboardai
  values = {
    name    = "onboardai"
    project = "onboardai-test-123"
  }
}

# The run.app URL Cloud Run gives web; the uptime checks use its host.
override_resource {
  target = google_cloud_run_v2_service.service["web"]
  values = {
    uri = "https://onboardai-web-abc123xyz-as.a.run.app"
  }
}

run "wif_trusts_only_main_of_this_repository" {
  command = apply

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.repository_id == '1418194026'")
    error_message = "The WIF condition must pin the numeric repository_id, not only the repository name."
  }

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.ref == 'refs/heads/main'")
    error_message = "The WIF condition must only accept tokens for refs/heads/main."
  }

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.repository_owner_id == '283518526'")
    error_message = "The WIF condition must pin the numeric owner ID."
  }

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.workflow_ref == 'UniVRse-Team/univrse-onboardai/.github/workflows/deploy.yml@refs/heads/main'")
    error_message = "The WIF condition must only accept the deploy workflow."
  }

  assert {
    condition     = !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.sub")
    error_message = "The WIF condition must not depend on the sub claim (a GitHub environment changes it)."
  }

  assert {
    condition     = !can(regex("\\|\\|\\s*assertion\\.(repository|ref)", google_iam_workload_identity_pool_provider.github.attribute_condition))
    error_message = "repository and ref checks must be AND-ed, never OR-ed."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
    error_message = "The provider must trust GitHub's OIDC issuer."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.repository_id"] == "assertion.repository_id"
    error_message = "attribute.repository_id must be mapped; the deployer binding relies on it."
  }

  assert {
    condition     = google_service_account_iam_member.deployer_federation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/1418194026"
    error_message = "Only principals of this repository ID may impersonate the deployer."
  }

  assert {
    condition     = google_service_account_iam_member.deployer_federation.role == "roles/iam.workloadIdentityUser" && google_service_account_iam_member.deployer_federation.service_account_id == google_service_account.deployer.name
    error_message = "The federation binding must grant workloadIdentityUser on the deployer only."
  }
}

run "deployer_holds_only_resource_level_roles" {
  command = apply

  assert {
    condition     = alltrue([for f in fileset(path.module, "*.tf") : !can(regex("resource\\s+\"google_(folder|organization)_iam_", file("${path.module}/${f}")))])
    error_message = "No folder- or organization-level IAM. The project-level roles are pinned in api_runtime_holds_exactly_three_project_roles; every other grant must be on a single resource."
  }

  assert {
    condition     = alltrue([for f in fileset(path.module, "*.tf") : !can(regex("roles/(owner|editor|viewer|run\\.admin|iam\\.serviceAccountTokenCreator|iam\\.serviceAccountAdmin|resourcemanager\\.|aiplatform\\.admin|cloudsql\\.admin|secretmanager\\.admin)", file("${path.module}/${f}")))])
    error_message = "Basic roles, Cloud Run Admin, token-creator and admin roles must not appear in this module."
  }

  # The only deployer role on the project is the Agent Engine deploy role
  # (intake_agent.tf, #30; #81), which production has for the checklist agent.
  assert {
    condition = (
      alltrue([for f in fileset(path.module, "*.tf") : !can(regex("google_project_iam_(binding|policy)", file("${path.module}/${f}")))]) &&
      sum([for f in fileset(path.module, "*.tf") : length(regexall("resource\\s+\"google_project_iam_member\"\\s+\"deployer", file("${path.module}/${f}")))]) == 1 &&
      sum([for f in fileset(path.module, "*.tf") : length(regexall("resource\\s+\"google_project_iam_member\"\\s+\"deployer_deploys_agents\"", file("${path.module}/${f}")))]) == 1 &&
      length(google_project_iam_member.deployer_deploys_agents) == 1 &&
      google_project_iam_member.deployer_deploys_agents[0].role == "roles/aiplatform.user"
    )
    error_message = "The production deployer holds one project-level role, roles/aiplatform.user for the checklist agent (#81); the only deployer project binding in the module is deployer_deploys_agents."
  }

  assert {
    condition     = google_service_account.deployer.account_id == "onboardai-deployer"
    error_message = "Deployer account ID is fixed by the service contract."
  }

  assert {
    condition = alltrue([
      for key, m in google_cloud_run_v2_service_iam_member.deployer :
      m.role == "roles/run.developer" && m.member == "serviceAccount:${google_service_account.deployer.email}" && m.name == google_cloud_run_v2_service.service[key].name
    ]) && length(google_cloud_run_v2_service_iam_member.deployer) == 3
    error_message = "The deployer must hold Cloud Run Developer on exactly the three OnboardAi services."
  }

  assert {
    condition     = google_artifact_registry_repository_iam_member.deployer_pushes_images.role == "roles/artifactregistry.writer" && google_artifact_registry_repository_iam_member.deployer_pushes_images.repository == google_artifact_registry_repository.onboardai.name && google_artifact_registry_repository_iam_member.deployer_pushes_images.member == "serviceAccount:${google_service_account.deployer.email}"
    error_message = "The deployer may write to the onboardai repository only."
  }

  assert {
    condition = alltrue([
      for key, m in google_service_account_iam_member.deployer_acts_as_runtime :
      m.role == "roles/iam.serviceAccountUser" && m.service_account_id == google_service_account.runtime[key].name && m.member == "serviceAccount:${google_service_account.deployer.email}"
    ]) && length(google_service_account_iam_member.deployer_acts_as_runtime) == 3
    error_message = "The deployer may act as the three runtime accounts only."
  }
}

run "api_runtime_holds_exactly_three_project_roles" {
  command = apply

  # Gemini, Firestore, Cloud SQL Client (since #45; tests/
  # accounts_production.tftest.hcl checks its condition), and Discovery Engine
  # Editor (to import/delete HR-uploaded documents in the data store).
  assert {
    condition     = toset(keys(google_project_iam_member.api_runtime)) == toset(["roles/aiplatform.user", "roles/datastore.user", "roles/cloudsql.client", "roles/discoveryengine.editor"]) && length(google_project_iam_member.api_runtime) == 4
    error_message = "onboardai-api-run holds exactly roles/aiplatform.user, roles/datastore.user, roles/cloudsql.client and roles/discoveryengine.editor on the project."
  }

  # #56: Firestore in (default) only, by project ID or number, like staging's
  # grant on its own database.
  assert {
    condition = (
      google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].expression == "resource.name == \"projects/onboardai-test-123/databases/(default)\" || resource.name == \"projects/123456789012/databases/(default)\"" &&
      google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].title == "(default) database only" &&
      !strcontains(google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].expression, "staging") &&
      !strcontains(google_project_iam_member.api_runtime["roles/datastore.user"].condition[0].expression, "startsWith")
    )
    error_message = "Production's roles/datastore.user is limited to exactly the (default) database (by project ID or number), never onboardai-staging."
  }

  assert {
    condition     = length(google_project_iam_member.api_runtime["roles/aiplatform.user"].condition) == 0
    error_message = "Gemini (roles/aiplatform.user) stays unconditioned; Vertex AI has no narrower grant."
  }

  assert {
    condition = (
      length(google_discovery_engine_search_engine_iam_member.api_searches_engine) == 1 &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].engine_id == "onboardai-search" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].collection_id == "default_collection" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].location == "global" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].role == "roles/discoveryengine.viewer" &&
      google_discovery_engine_search_engine_iam_member.api_searches_engine[0].member == "serviceAccount:${google_service_account.runtime["api"].email}"
    )
    error_message = "onboardai-api-run searches through roles/discoveryengine.viewer on onboardai-search alone."
  }

  # Adding a condition replaces a binding: the new one must be written before
  # the old one is removed, or the api loses the role in between.
  assert {
    condition     = strcontains(regex("(?s)\\nresource \"google_project_iam_member\" \"api_runtime\" \\{\\n.*?\\n\\}\\n", file("${path.module}/identity.tf")), "\n  lifecycle {\n    create_before_destroy = true\n  }\n")
    error_message = "google_project_iam_member.api_runtime needs lifecycle { create_before_destroy = true }."
  }

  assert {
    condition = alltrue([
      for role, m in google_project_iam_member.api_runtime :
      m.role == role && m.member == "serviceAccount:${google_service_account.runtime["api"].email}" && m.project == "onboardai-test-123"
    ])
    error_message = "Every project-level binding is for onboardai-api-run, on this project."
  }

  # Exactly four project-level IAM resource blocks of any flavour: the
  # api's roles (above), staging's intake agent runtime and Agent Engine
  # deploy roles (intake_agent.tf, #30), and the checklist agent's runtime
  # roles (checklist_agent.tf, #51), which have instances in production
  # unless var.checklist_agent_production is set to false (#81).
  assert {
    condition = (
      sum([for f in fileset(path.module, "*.tf") : length(regexall("resource\\s+\"google_project_iam_", file("${path.module}/${f}")))]) == 4 &&
      alltrue([
        for name in ["api_runtime", "intake_agent_runtime", "deployer_deploys_agents", "checklist_agent_runtime"] :
        sum([for f in fileset(path.module, "*.tf") : length(regexall("resource\\s+\"google_project_iam_member\"\\s+\"${name}\"", file("${path.module}/${f}")))]) == 1
      ]) &&
      length(google_project_iam_member.intake_agent_runtime) == 0 &&
      length(google_project_iam_member.checklist_agent_runtime) == 2 &&
      length(google_project_iam_member.deployer_deploys_agents) == 1
    )
    error_message = "The only project-level IAM resources are google_project_iam_member.api_runtime, checklist_agent_runtime, intake_agent_runtime and deployer_deploys_agents (no binding, policy, audit config or custom role); production has api_runtime, the checklist agent's two roles and the deployer's aiplatform.user, and no intake agent role."
  }

  assert {
    condition = alltrue([
      for m in google_project_iam_member.api_runtime :
      !contains([
        "serviceAccount:${google_service_account.deployer.email}",
        "serviceAccount:${google_service_account.runtime["web"].email}",
        "serviceAccount:${google_service_account.runtime["tts"].email}",
      ], m.member)
    ])
    error_message = "The deployer, web-run and tts-run hold no project-level role."
  }

  # The Gemini key is gone: production's only secrets are the accounts
  # database's two (#45, accounts.tf), whose values Terraform generates. The
  # intake agent's token (staging only) has no instance here.
  assert {
    condition = (
      toset(keys(google_secret_manager_secret.accounts)) == toset(["db_password", "database_url"]) &&
      length(google_secret_manager_secret_version.db_password) == 1 &&
      length(google_secret_manager_secret_version.database_url) == 1 &&
      length(google_secret_manager_secret_iam_member.api_reads_database_url) == 1 &&
      length(google_secret_manager_secret.intake_mcp_token) == 0 &&
      length(google_secret_manager_secret_version.intake_mcp_token) == 0 &&
      length(google_secret_manager_secret_iam_member.intake_mcp_token) == 0
    )
    error_message = "Production manages the accounts database's password and DATABASE_URL secrets only; its API authenticates to Google APIs with its service account."
  }

  # Wherever a secret is managed, its value never reaches state: every secret
  # version and the database password use write-only arguments, and the
  # generated values come from ephemeral resources, never stored ones.
  assert {
    condition = alltrue([
      for f in fileset(path.module, "*.tf") :
      !can(regex("(?m)^\\s*(secret_data|password|root_password)\\s*=", file("${path.module}/${f}"))) &&
      !can(regex("resource\\s+\"random_", file("${path.module}/${f}")))
    ])
    error_message = "Use secret_data_wo and password_wo with ephemeral random_password, never secret_data, password, root_password or a random_* resource (their values would be stored in state)."
  }

  assert {
    condition     = alltrue([for f in fileset(path.module, "*.tf") : !can(regex("GEMINI_API_KEY|gemini_api_key", file("${path.module}/${f}")))])
    error_message = "No Gemini API key may be referenced in the module."
  }

  assert {
    condition     = alltrue([for api in ["aiplatform.googleapis.com", "secretmanager.googleapis.com"] : contains(keys(google_project_service.required), api) && google_project_service.required[api].disable_on_destroy == false])
    error_message = "aiplatform and secretmanager APIs must be managed with disable_on_destroy = false."
  }
}

run "cloud_run_matches_service_contract" {
  command = apply

  assert {
    condition     = { for k, s in google_cloud_run_v2_service.service : k => s.name } == { web = "onboardai-web", api = "onboardai-api", tts = "onboardai-tts" }
    error_message = "Service names are fixed by the service contract."
  }

  assert {
    condition     = alltrue([for s in google_cloud_run_v2_service.service : s.location == "asia-southeast1" && s.ingress == "INGRESS_TRAFFIC_ALL"])
    error_message = "All services run in asia-southeast1 with public ingress."
  }

  assert {
    condition     = google_cloud_run_v2_service.service["api"].template[0].scaling[0].max_instance_count == 1
    error_message = "onboardai-api must be capped at one instance: the guest workspace store is SQLite on each instance's disk and the request limit is per instance (#58 lifts it)."
  }

  assert {
    condition     = alltrue([for s in google_cloud_run_v2_service.service : s.template[0].scaling[0].max_instance_count >= 1 && s.template[0].scaling[0].max_instance_count <= 3 && s.template[0].scaling[0].min_instance_count == 0])
    error_message = "Every service needs a max-instances cost cap (at most 3) and scales to zero."
  }

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.service : s.template[0].service_account == google_service_account.runtime[k].email && google_service_account.runtime[k].account_id == "onboardai-${k}-run"])
    error_message = "Each service runs as its own onboardai-<service>-run account."
  }

  assert {
    condition     = alltrue([for s in google_cloud_run_v2_service.service : s.template[0].containers[0].ports[0].container_port == 8080])
    error_message = "Containers listen on 8080 (the contract's $PORT)."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.service["web"].template[0].containers[0].startup_probe[0].http_get[0].path == "/web-health" &&
      google_cloud_run_v2_service.service["api"].template[0].containers[0].startup_probe[0].http_get[0].path == "/api/health" &&
      google_cloud_run_v2_service.service["tts"].template[0].containers[0].startup_probe[0].http_get[0].path == "/health"
    )
    error_message = "Startup probes must use the contract's health paths."
  }

  assert {
    condition     = alltrue([for s in google_cloud_run_v2_service.service : !endswith(s.template[0].containers[0].startup_probe[0].http_get[0].path, "z")])
    error_message = "The contract forbids health paths ending in z (reserved on Cloud Run)."
  }

  assert {
    condition     = google_cloud_run_v2_service.service["tts"].template[0].containers[0].resources[0].limits.memory == "2Gi"
    error_message = "tts needs 2Gi for Kokoro (measured peak about 1 GiB; 1.1 GiB was OOM-killed)."
  }

  # #57: only web is public; services_are_private_except_web checks the rest.
  assert {
    condition     = keys(google_cloud_run_v2_service_iam_member.public_invoker) == ["web"] && alltrue([for m in google_cloud_run_v2_service_iam_member.public_invoker : m.member == "allUsers" && m.role == "roles/run.invoker" && m.name == "onboardai-web"])
    error_message = "Only onboardai-web is public (allUsers roles/run.invoker); the api and tts are private (#57)."
  }

  assert {
    condition     = output.artifact_registry_image_prefix == "asia-southeast1-docker.pkg.dev/${google_artifact_registry_repository.onboardai.project}/onboardai" && google_artifact_registry_repository.onboardai.format == "DOCKER"
    error_message = "Images live in the onboardai Docker repository in the region."
  }

  assert {
    condition     = length(google_artifact_registry_repository.onboardai.cleanup_policies) == 2 && google_artifact_registry_repository.onboardai.cleanup_policy_dry_run == false
    error_message = "The repository needs its keep/delete cleanup policies, not in dry-run."
  }

  assert {
    condition     = length(google_artifact_registry_repository.onboardai.docker_config) == 0
    error_message = "Do not declare docker_config: tags are mutable by default and an explicit immutable_tags = false causes a perpetual plan diff."
  }

  assert {
    condition     = toset(keys(google_project_service.required)) == toset(["run.googleapis.com", "artifactregistry.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "secretmanager.googleapis.com", "aiplatform.googleapis.com", "discoveryengine.googleapis.com", "firestore.googleapis.com", "storage.googleapis.com", "monitoring.googleapis.com", "sqladmin.googleapis.com", "cloudscheduler.googleapis.com"]) && alltrue([for s in google_project_service.required : s.disable_on_destroy == false])
    error_message = "Exactly the required APIs are managed (no Drive API; sqladmin since #45; cloudscheduler since #79), and none is disabled on destroy."
  }

  assert {
    condition     = alltrue([for f in fileset(path.module, "*.tf") : !can(regex("(?i)google_drive|drive\\.googleapis", file("${path.module}/${f}")))])
    error_message = "Google Drive is retired: no Drive API and no folder variable."
  }
}

# #57: web is the only public service. Each runtime account may invoke the one
# service it calls (web the api, the api tts) and nothing else; allUsers is
# nowhere else. Ingress stays all: Cloud Run IAM does the gating.
run "services_are_private_except_web" {
  command = apply

  assert {
    condition = (
      length(google_cloud_run_v2_service_iam_member.runtime_invoker) == 2 &&
      google_cloud_run_v2_service_iam_member.runtime_invoker["web-to-api"].name == "onboardai-api" &&
      google_cloud_run_v2_service_iam_member.runtime_invoker["web-to-api"].member == "serviceAccount:onboardai-web-run@onboardai-test-123.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service_iam_member.runtime_invoker["api-to-tts"].name == "onboardai-tts" &&
      google_cloud_run_v2_service_iam_member.runtime_invoker["api-to-tts"].member == "serviceAccount:onboardai-api-run@onboardai-test-123.iam.gserviceaccount.com" &&
      alltrue([
        for key, m in google_cloud_run_v2_service_iam_member.runtime_invoker :
        m.role == "roles/run.invoker" && m.location == google_cloud_run_v2_service.service[{ "web-to-api" = "api", "api-to-tts" = "tts" }[key]].location && m.project == google_cloud_run_v2_service.service[{ "web-to-api" = "api", "api-to-tts" = "tts" }[key]].project
      ])
    )
    error_message = "onboardai-web-run may invoke onboardai-api and onboardai-api-run may invoke onboardai-tts, with roles/run.invoker, and nothing else."
  }

  # Every run.invoker grant in production, by service: web for everyone, the
  # api for web's account, tts for the api's account. (The deployer's Cloud
  # Run Developer, which also includes run.routes.invoke, is checked in
  # deployer_holds_only_resource_level_roles.)
  assert {
    condition = toset(concat(
      [for m in google_cloud_run_v2_service_iam_member.public_invoker : "${m.name} ${m.member}"],
      [for m in google_cloud_run_v2_service_iam_member.runtime_invoker : "${m.name} ${m.member}"],
      [for m in google_cloud_run_v2_service_iam_member.intake_agent_invokes_api : "${m.name} ${m.member}"],
      )) == toset([
      "onboardai-web allUsers",
      "onboardai-api serviceAccount:onboardai-web-run@onboardai-test-123.iam.gserviceaccount.com",
      "onboardai-tts serviceAccount:onboardai-api-run@onboardai-test-123.iam.gserviceaccount.com",
    ]) && length(google_cloud_run_v2_service_iam_member.intake_agent_invokes_api) == 0
    error_message = "Production's invokers: allUsers on web, onboardai-web-run on the api, onboardai-api-run on tts, and no intake agent."
  }

  # allUsers appears in one place in the module, the web-only public binding.
  assert {
    condition = (
      sum([for f in fileset(path.module, "*.tf") : length(regexall("\"allUsers\"|\"allAuthenticatedUsers\"", file("${path.module}/${f}")))]) == 1 &&
      strcontains(file("${path.module}/cloud_run.tf"), "  member   = \"allUsers\"\n") &&
      strcontains(file("${path.module}/cloud_run.tf"), "  public_services = [\"web\"]\n")
    )
    error_message = "allUsers (or allAuthenticatedUsers) may appear only in public_invoker, and public_services must be [\"web\"]."
  }

  assert {
    condition     = alltrue([for s in google_cloud_run_v2_service.service : s.ingress == "INGRESS_TRAFFIC_ALL"]) && alltrue([for flags in output.cloud_run_deploy_flags : strcontains(flags, "--ingress=all")])
    error_message = "Ingress stays all on every service (Terraform and deploy flags): IAM, not ingress, makes the api and tts private."
  }
}

run "firestore_keeps_its_data" {
  command = apply

  assert {
    condition     = google_firestore_database.default.name == "(default)" && google_firestore_database.default.type == "FIRESTORE_NATIVE" && google_firestore_database.default.location_id == "asia-southeast1"
    error_message = "Contract v2: the (default) database, Native mode, asia-southeast1."
  }

  assert {
    condition     = google_firestore_database.default.delete_protection_state == "DELETE_PROTECTION_ENABLED"
    error_message = "Firestore delete protection must be on."
  }

  assert {
    condition     = google_firestore_database.default.deletion_policy == "ABANDON"
    error_message = "terraform destroy must never delete the database (deletion_policy ABANDON)."
  }

  assert {
    condition     = output.firestore_database_id == "(default)"
    error_message = "FIRESTORE_DATABASE_ID is (default)."
  }

  # #56: production's data must be recoverable for 7 days.
  assert {
    condition     = google_firestore_database.default.point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_ENABLED"
    error_message = "Production Firestore keeps point-in-time recovery on (7 days of versions)."
  }
}

run "documents_bucket_is_private_and_readable_only_by_discovery_engine" {
  command = apply

  assert {
    condition     = google_storage_bucket.docs.name == "onboardai-test-123-onboardai-docs" && google_storage_bucket.docs.location == "ASIA-SOUTHEAST1" && output.docs_bucket_name == google_storage_bucket.docs.name
    error_message = "Contract v2: bucket <project>-onboardai-docs in asia-southeast1."
  }

  assert {
    condition     = google_storage_bucket.docs.uniform_bucket_level_access == true && google_storage_bucket.docs.public_access_prevention == "enforced"
    error_message = "The documents bucket needs uniform access and enforced public access prevention."
  }

  assert {
    condition     = google_storage_bucket.docs.versioning[0].enabled == true && google_storage_bucket.docs.force_destroy == false
    error_message = "The documents bucket keeps versions and is never force-destroyed."
  }

  assert {
    condition     = google_storage_bucket.employee_docs.name == "onboardai-test-123-onboardai-employee-docs" && google_storage_bucket.employee_docs.location == "ASIA-SOUTHEAST1" && output.employee_documents_bucket_name == google_storage_bucket.employee_docs.name
    error_message = "Private employee documents bucket <project>-onboardai-employee-docs in asia-southeast1."
  }

  assert {
    condition     = google_storage_bucket.employee_docs.uniform_bucket_level_access == true && google_storage_bucket.employee_docs.public_access_prevention == "enforced"
    error_message = "The employee documents bucket needs uniform access and enforced public access prevention."
  }

  assert {
    condition     = google_storage_bucket.employee_docs.versioning[0].enabled == true && google_storage_bucket.employee_docs.force_destroy == false
    error_message = "The employee documents bucket keeps versions and is never force-destroyed."
  }

  # Three bucket grants in the whole module: the Discovery Engine service agent
  # (objectViewer on docs) and onboardai-api-run (objectUser on docs and employee_docs).
  assert {
    condition     = sum([for f in fileset(path.module, "*.tf") : length(regexall("resource\\s+\"google_storage_bucket_iam_", file("${path.module}/${f}")))]) == 3
    error_message = "Exactly three bucket IAM resources may exist (Discovery Engine reads company documents; onboardai-api-run manages HR uploads and employee submissions)."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.discovery_engine_reads_docs.bucket == google_storage_bucket.docs.name &&
      google_storage_bucket_iam_member.discovery_engine_reads_docs.role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.discovery_engine_reads_docs.member == "serviceAccount:service-123456789012@gcp-sa-discoveryengine.iam.gserviceaccount.com" &&
      google_storage_bucket_iam_member.api_manages_docs.bucket == google_storage_bucket.docs.name &&
      google_storage_bucket_iam_member.api_manages_docs.role == "roles/storage.objectUser" &&
      google_storage_bucket_iam_member.api_manages_docs.member == "serviceAccount:${google_service_account.runtime["api"].email}" &&
      google_storage_bucket_iam_member.api_manages_employee_docs.bucket == google_storage_bucket.employee_docs.name &&
      google_storage_bucket_iam_member.api_manages_employee_docs.role == "roles/storage.objectUser" &&
      google_storage_bucket_iam_member.api_manages_employee_docs.member == "serviceAccount:${google_service_account.runtime["api"].email}"
    )
    error_message = "The Discovery Engine service agent gets roles/storage.objectViewer on docs, and onboardai-api-run gets roles/storage.objectUser on docs and employee_docs."
  }

  assert {
    condition     = length(google_project_service_identity.discovery_engine) == 1 && google_project_service_identity.discovery_engine[0].service == "discoveryengine.googleapis.com"
    error_message = "The service agent must be generated before the bucket grant (production's state owns it)."
  }
}

run "vertex_ai_search_matches_contract" {
  command = apply

  assert {
    condition = (
      google_discovery_engine_data_store.docs.data_store_id == "onboardai-docs" &&
      google_discovery_engine_data_store.docs.location == "global" &&
      google_discovery_engine_data_store.docs.industry_vertical == "GENERIC" &&
      google_discovery_engine_data_store.docs.content_config == "CONTENT_REQUIRED" &&
      google_discovery_engine_data_store.docs.solution_types == tolist(["SOLUTION_TYPE_SEARCH"]) &&
      output.vertex_search_data_store_id == "onboardai-docs"
    )
    error_message = "Contract v2: data store onboardai-docs, global, GENERIC, content required, search."
  }

  # Cannot be changed after creation.
  assert {
    condition = (
      length(google_discovery_engine_data_store.docs.document_processing_config[0].default_parsing_config[0].layout_parsing_config) == 1 &&
      google_discovery_engine_data_store.docs.document_processing_config[0].chunking_config[0].layout_based_chunking_config[0].chunk_size == 500 &&
      google_discovery_engine_data_store.docs.document_processing_config[0].chunking_config[0].layout_based_chunking_config[0].include_ancestor_headings == true &&
      length(google_discovery_engine_data_store.docs.document_processing_config[0].parsing_config_overrides) == 0
    )
    error_message = "Contract v2: layout parser for every file type, layout-based chunks of 500 tokens with ancestor headings."
  }

  assert {
    condition     = google_discovery_engine_data_store.docs.deletion_policy == "PREVENT" && google_discovery_engine_search_engine.docs.deletion_policy == "PREVENT"
    error_message = "Terraform must refuse to delete the data store and the engine."
  }

  assert {
    condition = (
      google_discovery_engine_search_engine.docs.engine_id == "onboardai-search" &&
      google_discovery_engine_search_engine.docs.collection_id == "default_collection" &&
      google_discovery_engine_search_engine.docs.location == "global" &&
      google_discovery_engine_search_engine.docs.data_store_ids == tolist(["onboardai-docs"]) &&
      google_discovery_engine_search_engine.docs.search_engine_config[0].search_tier == "SEARCH_TIER_ENTERPRISE"
    )
    error_message = "Contract v2: Enterprise engine onboardai-search on onboardai-docs."
  }

  assert {
    condition     = output.vertex_search_serving_config == "projects/123456789012/locations/global/collections/default_collection/engines/onboardai-search/servingConfigs/default_search"
    error_message = "The serving config must be the one in contract v2."
  }

  # #79: the bucket-wide import command is gone. The reconcile job (and the
  # api's own per-file import) are the only ways documents reach the index.
  assert {
    condition     = output.docs_reconcile_run_command == "gcloud run jobs execute onboardai-docs-reconcile --project=onboardai-test-123 --region=asia-southeast1 --wait"
    error_message = "docs_reconcile_run_command must execute the production reconcile job with --wait."
  }
}

run "alerts_are_quiet_and_reach_every_address" {
  command = apply

  assert {
    condition = (
      toset(keys(google_monitoring_notification_channel.email)) == toset(["alerts-a@example.com", "alerts-b@example.com"]) &&
      alltrue([for email, c in google_monitoring_notification_channel.email : c.type == "email" && c.labels.email_address == email])
    )
    error_message = "One email notification channel per alert address."
  }

  assert {
    condition = alltrue([
      for p in [google_monitoring_alert_policy.server_errors, google_monitoring_alert_policy.api_latency, google_monitoring_alert_policy.uptime] :
      toset(p.notification_channels) == toset([for c in google_monitoring_notification_channel.email : c.name]) && length(p.conditions) == 1
    ])
    error_message = "Every policy has one condition and notifies every channel."
  }

  # Quiet: no absence conditions on the services, missing data (scale to zero)
  # never fires. The one exception (#79) is the reconcile job's SLA: a job that
  # should run every hour and has not succeeded for 3 h / 6 h
  # (docs_reconcile_monitoring.tf; tests/docs_reconcile.tftest.hcl pins it).
  assert {
    condition     = alltrue([for f in fileset(path.module, "*.tf") : !can(regex("condition_absent|EVALUATION_MISSING_DATA_ACTIVE", file("${path.module}/${f}"))) || f == "docs_reconcile_monitoring.tf"])
    error_message = "No alert may fire on missing data (a service scaled to zero sends none), except the reconcile job's SLA in docs_reconcile_monitoring.tf."
  }

  assert {
    condition = (
      length(regexall("condition_absent \\{", file("${path.module}/docs_reconcile_monitoring.tf"))) == 1 &&
      !can(regex("EVALUATION_MISSING_DATA_ACTIVE", file("${path.module}/docs_reconcile_monitoring.tf")))
    )
    error_message = "docs_reconcile_monitoring.tf has exactly one absence condition (the SLA) and no ACTIVE missing-data setting."
  }

  assert {
    condition = alltrue([
      for p in [google_monitoring_alert_policy.server_errors, google_monitoring_alert_policy.api_latency, google_monitoring_alert_policy.uptime] :
      p.conditions[0].condition_threshold[0].evaluation_missing_data == "EVALUATION_MISSING_DATA_INACTIVE"
    ])
    error_message = "Missing data must count as no violation."
  }

  # The Monitoring API rejects evaluation_missing_data on a zero duration.
  assert {
    condition = alltrue([
      for p in [google_monitoring_alert_policy.server_errors, google_monitoring_alert_policy.api_latency, google_monitoring_alert_policy.uptime] :
      alltrue([
        for c in p.conditions :
        alltrue([
          for t in c.condition_threshold :
          t.evaluation_missing_data == null || t.evaluation_missing_data == "" || !contains(["0s", "0"], t.duration)
        ])
      ])
    ])
    error_message = "A condition that sets evaluation_missing_data needs a non-zero duration (the API returns 400 for 0s)."
  }

  assert {
    condition = (
      strcontains(google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].filter, "metric.type = \"run.googleapis.com/request_count\"") &&
      strcontains(google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].filter, "metric.label.response_code_class = \"5xx\"") &&
      strcontains(google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].filter, "resource.label.service_name = one_of(\"onboardai-api\", \"onboardai-tts\")") &&
      !strcontains(google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].filter, "onboardai-web")
    )
    error_message = "The 5xx alert watches request_count with response_code_class 5xx on onboardai-api and onboardai-tts."
  }

  assert {
    condition = (
      google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].duration == "300s" &&
      google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].comparison == "COMPARISON_GT" &&
      google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].threshold_value == 0 &&
      google_monitoring_alert_policy.server_errors.conditions[0].condition_threshold[0].aggregations[0].group_by_fields == tolist(["resource.label.service_name"])
    )
    error_message = "The 5xx alert fires on 5xx sustained for 5 minutes, per service."
  }

  assert {
    condition = (
      strcontains(google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].filter, "metric.type = \"run.googleapis.com/request_latencies\"") &&
      strcontains(google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].filter, "resource.label.service_name = \"onboardai-api\"") &&
      google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].aggregations[0].alignment_period == "300s" &&
      google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].aggregations[0].cross_series_reducer == "REDUCE_PERCENTILE_95" &&
      google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].comparison == "COMPARISON_GT" &&
      google_monitoring_alert_policy.api_latency.conditions[0].condition_threshold[0].threshold_value == 20000
    )
    error_message = "The latency alert fires when onboardai-api's p95 over 5 minutes is above 20 s (20000 ms)."
  }
}

# #56: two HTTPS checks on web's run.app host, /web-health and /api/health
# through web (so the api check outlives a public api, #57), and one alert when
# a check fails from 2 of its 3 locations. Cost: the fewest locations, every
# 5 minutes.
run "uptime_checks_watch_web_and_the_api_through_web" {
  command = apply

  assert {
    condition = (
      toset(keys(google_monitoring_uptime_check_config.health)) == toset(["web", "api"]) &&
      google_monitoring_uptime_check_config.health["web"].http_check[0].path == "/web-health" &&
      google_monitoring_uptime_check_config.health["api"].http_check[0].path == "/api/health" &&
      google_monitoring_uptime_check_config.health["web"].display_name == "OnboardAi: onboardai-web /web-health" &&
      google_monitoring_uptime_check_config.health["api"].display_name == "OnboardAi: onboardai-api /api/health through onboardai-web"
    )
    error_message = "Two uptime checks: onboardai-web /web-health, and onboardai-api /api/health through onboardai-web."
  }

  assert {
    condition = alltrue([
      for c in google_monitoring_uptime_check_config.health :
      c.monitored_resource[0].type == "uptime_url" &&
      c.monitored_resource[0].labels == tomap({ project_id = "onboardai-test-123", host = "onboardai-web-abc123xyz-as.a.run.app" }) &&
      c.http_check[0].request_method == "GET" &&
      c.http_check[0].port == 443 &&
      c.http_check[0].use_ssl == true &&
      c.http_check[0].validate_ssl == true &&
      c.http_check[0].accepted_response_status_codes[0].status_class == "STATUS_CLASS_2XX" &&
      length(c.content_matchers) == 1 &&
      c.content_matchers[0].content == "\"ok\":true" &&
      c.content_matchers[0].matcher == "CONTAINS_STRING"
    ])
    error_message = "Both checks GET over validated HTTPS on the web service's run.app host (from its uri), expect 2xx and the {\"ok\":true} body."
  }

  assert {
    condition = alltrue([
      for c in google_monitoring_uptime_check_config.health :
      contains(["300s", "600s", "900s"], c.period) &&
      toset(c.selected_regions) == toset(["ASIA_PACIFIC", "EUROPE", "USA_OREGON"]) &&
      length(c.selected_regions) == 3 &&
      c.checker_type == "STATIC_IP_CHECKERS" &&
      tonumber(trimsuffix(c.timeout, "s")) <= 60 &&
      c.user_labels == tomap({ app = "onboardai", managed-by = "terraform" })
    ])
    error_message = "Cost: each check runs at most every 5 minutes from three locations (one region each, the fewest the API accepts), with production's labels."
  }

  assert {
    condition = (
      google_monitoring_alert_policy.uptime.display_name == "OnboardAi: uptime checks failing (/web-health, /api/health)" &&
      google_monitoring_alert_policy.uptime.severity == "CRITICAL" &&
      google_monitoring_alert_policy.uptime.user_labels == tomap({ app = "onboardai", managed-by = "terraform" }) &&
      startswith(google_monitoring_alert_policy.uptime.documentation[0].subject, "OnboardAi: ")
    )
    error_message = "The uptime alert is production's: OnboardAi: title and subject, CRITICAL, production's labels."
  }

  assert {
    condition = (
      strcontains(google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].filter, "resource.type = \"uptime_url\"") &&
      strcontains(google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].filter, "metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\"") &&
      strcontains(google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].filter, format("metric.label.check_id = one_of(%s)", join(", ", [for c in google_monitoring_uptime_check_config.health : "\"${c.uptime_check_id}\""])))
    )
    error_message = "The uptime alert watches check_passed of exactly this stack's two checks."
  }

  assert {
    condition = (
      google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].aggregations[0].per_series_aligner == "ALIGN_NEXT_OLDER" &&
      google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].aggregations[0].cross_series_reducer == "REDUCE_COUNT_FALSE" &&
      google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].aggregations[0].group_by_fields == tolist(["metric.label.check_id"]) &&
      tonumber(trimsuffix(google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].aggregations[0].alignment_period, "s")) >= tonumber(trimsuffix(google_monitoring_uptime_check_config.health["web"].period, "s")) &&
      google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].comparison == "COMPARISON_GT" &&
      google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].threshold_value == 1 &&
      google_monitoring_alert_policy.uptime.conditions[0].condition_threshold[0].duration == "300s"
    )
    error_message = "The uptime alert fires per check when at least 2 of its 3 locations' latest results (over at least one period) have failed for 5 minutes."
  }
}

run "outputs_carry_the_setup_commands" {
  command = apply

  assert {
    condition = toset([for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) --repo UniVRse-Team/univrse-onboardai --body '[^']*'$", output.github_variable_commands) : m[0]]) == toset([
      "GCP_PROJECT_ID", "GCP_REGION", "GCP_WIF_PROVIDER", "GCP_DEPLOYER_SA", "AI_MODE", "GEMINI_MODEL",
      "VERTEX_SEARCH_LOCATION", "VERTEX_SEARCH_ENGINE_ID", "FIRESTORE_DATABASE_ID",
    ]) && length(split("\n", output.github_variable_commands)) == 9
    error_message = "One gh command for each of the nine repository variables, and nothing else."
  }

  assert {
    condition     = strcontains(output.github_variable_commands, "--body '${google_iam_workload_identity_pool_provider.github.name}'") && strcontains(output.github_variable_commands, "--body '${google_service_account.deployer.email}'")
    error_message = "GCP_WIF_PROVIDER and GCP_DEPLOYER_SA must come from the resources."
  }

  assert {
    condition = (
      strcontains(output.github_variable_commands, "gh variable set VERTEX_SEARCH_LOCATION --repo UniVRse-Team/univrse-onboardai --body 'global'") &&
      strcontains(output.github_variable_commands, "gh variable set VERTEX_SEARCH_ENGINE_ID --repo UniVRse-Team/univrse-onboardai --body 'onboardai-search'") &&
      strcontains(output.github_variable_commands, "gh variable set FIRESTORE_DATABASE_ID --repo UniVRse-Team/univrse-onboardai --body '(default)'") &&
      strcontains(output.github_variable_commands, "gh variable set AI_MODE --repo UniVRse-Team/univrse-onboardai --body 'gemini-chat'") &&
      strcontains(output.github_variable_commands, "gh variable set GEMINI_MODEL --repo UniVRse-Team/univrse-onboardai --body 'gemini-3.5-flash-lite'") &&
      strcontains(output.github_variable_commands, "gh variable set GCP_REGION --repo UniVRse-Team/univrse-onboardai --body 'asia-southeast1'")
    )
    error_message = "Contract v2 values: global, onboardai-search, (default), gemini-chat, gemini-3.5-flash-lite, asia-southeast1."
  }
}

run "rejects_repository_name_as_id" {
  command = plan

  variables {
    github_repository_id = "UniVRse-Team/univrse-onboardai"
  }

  expect_failures = [var.github_repository_id]
}

run "rejects_unknown_ai_mode" {
  command = plan

  variables {
    ai_mode = "gemini-chat,EXTRA=1"
  }

  expect_failures = [var.ai_mode]
}

run "rejects_malformed_alert_email" {
  command = plan

  variables {
    alert_emails = ["alerts-a@example.com", "not-an-address"]
  }

  expect_failures = [var.alert_emails]
}

run "rejects_empty_alert_emails" {
  command = plan

  variables {
    alert_emails = []
  }

  expect_failures = [var.alert_emails]
}

# ---------------------------------------------------------------------------
# Production keeps exactly what it was applied with (issue #20)
# ---------------------------------------------------------------------------

run "production_keeps_its_names_labels_and_grants" {
  command = apply

  assert {
    condition = alltrue([
      for labels in concat(
        [for s in google_cloud_run_v2_service.service : s.labels],
        [google_artifact_registry_repository.onboardai.labels, google_storage_bucket.docs.labels, google_storage_bucket.employee_docs.labels],
      ) : !contains(keys(labels), "environment")
    ]) && google_monitoring_alert_policy.server_errors.user_labels == tomap({ app = "onboardai", managed-by = "terraform" })
    error_message = "Production resources carry no environment label: adding one would update every production resource."
  }

  assert {
    condition = (
      google_service_account.deployer.account_id == "onboardai-deployer" &&
      { for k, a in google_service_account.runtime : k => a.account_id } == { web = "onboardai-web-run", api = "onboardai-api-run", tts = "onboardai-tts-run" } &&
      google_artifact_registry_repository.onboardai.repository_id == "onboardai" &&
      google_iam_workload_identity_pool.github.workload_identity_pool_id == "onboardai-github" &&
      google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id == "github-actions"
    )
    error_message = "Production IDs never carry a suffix."
  }

  assert {
    condition = (
      google_iam_workload_identity_pool.github.display_name == "OnboardAi GitHub Actions" &&
      google_iam_workload_identity_pool_provider.github.display_name == "GitHub Actions" &&
      google_service_account.deployer.display_name == "OnboardAi: GitHub Actions deployer" &&
      google_service_account.deployer.description == "Impersonated by the deploy workflow on main through Workload Identity Federation. Pushes images and deploys the three OnboardAi services. Has no key." &&
      google_cloud_run_v2_service.service["web"].description == "OnboardAi web: serves the built frontend and avatar, proxies /api/* to onboardai-api." &&
      google_monitoring_alert_policy.api_latency.display_name == "OnboardAi: onboardai-api p95 latency above 20 s" &&
      google_monitoring_alert_policy.server_errors.display_name == "OnboardAi: sustained 5xx responses (api, tts)"
    )
    error_message = "Production display names and descriptions are the ones it was applied with."
  }

  # #56 narrowed production's api to staging's pattern: every Firestore,
  # Discovery Engine or Cloud SQL role it holds on the project is conditioned
  # (Gemini is not), and it searches through its engine grant.
  assert {
    condition = alltrue([
      for role, m in google_project_iam_member.api_runtime :
      length(m.condition) == (contains(["roles/aiplatform.user", "roles/discoveryengine.editor"], role) ? 0 : 1)
    ]) && !contains(keys(google_project_iam_member.api_runtime), "roles/discoveryengine.viewer")
    error_message = "Production's api holds Gemini and Discovery Engine Editor unconditioned and its Firestore and Cloud SQL roles with an IAM condition."
  }

  assert {
    condition     = length(google_discovery_engine_search_engine_iam_member.api_searches_engine) == 1
    error_message = "Production searches through the engine-level grant on onboardai-search, like staging on its own engine."
  }

  assert {
    condition     = output.github_environment_commands == null
    error_message = "Production keeps its repository variables; the GitHub environment setup output is staging's only (null keeps production's outputs unchanged)."
  }

  # Employee accounts run in production since #45 (only new resources; tests/
  # accounts_production.tftest.hcl checks them). The intake agent (#30) stays
  # staging's.
  assert {
    condition = (
      length(google_sql_database_instance.accounts) == 1 &&
      length(google_sql_database.accounts) == 1 &&
      length(google_sql_user.accounts) == 1 &&
      length(google_cloud_run_v2_job.db_migrate) == 1 &&
      length(google_cloud_run_v2_job_iam_member.deployer_runs_migrations) == 1 &&
      length(google_logging_log_view.db_migrate) == 1 &&
      length(google_logging_log_view_iam_member.deployer_reads_migration_log) == 1 &&
      length(google_service_account.intake_agent) == 0 &&
      length(google_service_account_iam_member.deployer_acts_as_intake_agent) == 0 &&
      length(google_firestore_field.employee_imports_ttl) == 0
    )
    error_message = "Production gets the accounts database, its migration job and log view (#45), and none of the intake agent's resources (#30)."
  }

  assert {
    condition = (
      output.cloud_sql_instance_connection_name != null &&
      output.db_migrate_job_name == "onboardai-db-migrate" &&
      output.intake_agent_service_account_email == null &&
      output.intake_agent_deploy_settings == null
    )
    error_message = "The accounts outputs name production's resources; the intake agent outputs are null in production."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.service["api"].deletion_protection == true &&
      google_discovery_engine_search_engine.docs.deletion_policy == "PREVENT"
    )
    error_message = "deletion_protection defaults to true."
  }
}

run "state_guard_is_wired_to_the_workspace" {
  command = plan

  assert {
    condition     = can(regex("module \"state_guard\" \\{\\s*source\\s*=\\s*\"\\./modules/state_guard\"\\s*environment\\s*=\\s*var\\.environment\\s*workspace\\s*=\\s*terraform\\.workspace\\s*\\}", file("${path.module}/environment.tf")))
    error_message = "module.state_guard must receive environment = var.environment and workspace = terraform.workspace."
  }

  assert {
    condition     = sum([for f in fileset("${path.module}/modules/state_guard", "*.tf") : length(regexall("(?m)^\\s*(resource|data)\\s+\"", file("${path.module}/modules/state_guard/${f}")))]) == 0
    error_message = "The guard manages and reads nothing, so it adds nothing to either state."
  }
}

run "deletion_protection_can_be_lifted_for_tear_down" {
  command = plan

  variables {
    deletion_protection = false
  }

  assert {
    condition = (
      alltrue([for s in google_cloud_run_v2_service.service : s.deletion_protection == false]) &&
      google_discovery_engine_data_store.docs.deletion_policy == "DELETE" &&
      google_discovery_engine_search_engine.docs.deletion_policy == "DELETE" &&
      google_firestore_database.default.delete_protection_state == "DELETE_PROTECTION_DISABLED" &&
      google_firestore_database.default.deletion_policy == "DELETE" &&
      google_storage_bucket.docs.force_destroy == false
    )
    error_message = "deletion_protection = false lifts every delete guard except the bucket's (documents are emptied by hand)."
  }
}

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "prod"
  }

  expect_failures = [var.environment]
}
