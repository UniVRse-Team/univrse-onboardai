# Guards the company filter schema decision (#86). The docs data store's
# default_schema gets `companyId` through the one-time schemas.patch call in the
# README ("Company filter schema"), not through Terraform: in google provider
# 8.6.0 google_discovery_engine_schema has json_schema ForceNew, a no-op update
# and a destroy that deletes default_schema, so managing default_schema would
# replace it instead of adding a field. Offline: `terraform test`.

mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  project_id   = "onboardai-test-123"
  alert_emails = ["alerts-a@example.com"]
}

override_module {
  target = module.state_guard
}

override_resource {
  target = google_service_account.deployer
  values = {
    email = "onboardai-deployer@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-deployer@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_data {
  target = data.google_project.this
  values = {
    number = "123456789012"
  }
}

run "company_schema_is_a_documented_patch_not_a_resource" {
  command = plan

  assert {
    condition = alltrue([
      for f in fileset(path.module, "*.tf") :
      length(regexall("(?m)^\\s*resource\\s+\"google_discovery_engine_schema\"", file("${path.module}/${f}"))) == 0
    ])
    error_message = "google_discovery_engine_schema must not manage default_schema: json_schema is ForceNew and destroy deletes the schema. Use the README schemas.patch runbook."
  }

  assert {
    condition = alltrue([
      for s in [
        "{\"$schema\":\"https://json-schema.org/draft-07/schema#\",\"type\":\"object\",\"properties\":{\"companyId\":{\"type\":\"string\",\"indexable\":true,\"retrievable\":true,\"searchable\":false,\"dynamicFacetable\":false}}}",
        "-X PATCH",
        "/schemas/default_schema",
        "gcloud auth print-access-token",
        "onboardai-docs-staging",
        "discoveryengine.documents.import",
      ] : strcontains(file("${path.module}/README.md"), s)
    ])
    error_message = "README.md must keep the companyId schemas.patch runbook with the exact schema JSON."
  }

  assert {
    condition     = google_discovery_engine_data_store.docs.content_config == "CONTENT_REQUIRED" && google_discovery_engine_data_store.docs.data_store_id == "onboardai-docs"
    error_message = "The docs data store the runbook patches must stay CONTENT_REQUIRED and onboardai-docs (production)."
  }
}

run "staging_data_store_id_matches_runbook" {
  command = plan

  variables {
    environment = "staging"
  }

  assert {
    condition     = google_discovery_engine_data_store.docs.data_store_id == "onboardai-docs-staging"
    error_message = "The runbook patches onboardai-docs-staging on staging."
  }
}
