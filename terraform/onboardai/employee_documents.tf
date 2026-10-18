# Private Cloud Storage bucket for employee document submissions.
# Dedicated to employee onboarding paperwork; deliberately NEVER connected
# to Vertex AI Search or Discovery Engine.

resource "google_storage_bucket" "employee_docs" {
  name          = local.employee_documents_bucket_name
  location      = upper(var.region)
  storage_class = "STANDARD"
  labels        = merge(local.labels, { component = "employee-documents" })

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Destroy fails while the bucket holds documents.
  force_destroy = false

  # Overwritten or deleted documents stay recoverable for 30 days.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.required]
}

# Write, read and delete access on this environment's employee documents bucket
# so onboardai-api can store and serve employee submissions.
resource "google_storage_bucket_iam_member" "api_manages_employee_docs" {
  bucket = google_storage_bucket.employee_docs.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime["api"].email}"
}
