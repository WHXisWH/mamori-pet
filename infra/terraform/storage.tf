locals {
  bucket_defaults = {
    location                    = var.region
    uniform_bucket_level_access = true
    public_access_prevention    = "enforced"
  }
}

resource "google_storage_bucket" "artworks" {
  name                        = "${var.project_id}-artworks"
  location                    = local.bucket_defaults.location
  uniform_bucket_level_access = local.bucket_defaults.uniform_bucket_level_access
  public_access_prevention    = local.bucket_defaults.public_access_prevention
  force_destroy               = false

  encryption {
    default_kms_key_name = google_kms_crypto_key.storage.id
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = var.artworks_retention_days
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_storage_bucket" "kb" {
  name                        = "${var.project_id}-kb"
  location                    = local.bucket_defaults.location
  uniform_bucket_level_access = local.bucket_defaults.uniform_bucket_level_access
  public_access_prevention    = local.bucket_defaults.public_access_prevention
  force_destroy               = false

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.storage.id
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_storage_bucket" "eval" {
  name                        = "${var.project_id}-eval"
  location                    = local.bucket_defaults.location
  uniform_bucket_level_access = local.bucket_defaults.uniform_bucket_level_access
  public_access_prevention    = local.bucket_defaults.public_access_prevention
  force_destroy               = false

  encryption {
    default_kms_key_name = google_kms_crypto_key.storage.id
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_storage_bucket" "exports" {
  name                        = "${var.project_id}-exports"
  location                    = local.bucket_defaults.location
  uniform_bucket_level_access = local.bucket_defaults.uniform_bucket_level_access
  public_access_prevention    = local.bucket_defaults.public_access_prevention
  force_destroy               = true

  encryption {
    default_kms_key_name = google_kms_crypto_key.storage.id
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 7
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_storage_bucket" "cloudbuild_source" {
  name                        = "${var.project_id}-cloudbuild-source"
  location                    = local.bucket_defaults.location
  uniform_bucket_level_access = local.bucket_defaults.uniform_bucket_level_access
  public_access_prevention    = local.bucket_defaults.public_access_prevention
  force_destroy               = true

  encryption {
    default_kms_key_name = google_kms_crypto_key.storage.id
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 7
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_storage_bucket_iam_member" "cloudbuild_source_reader" {
  bucket = google_storage_bucket.cloudbuild_source.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.cloudbuild.member
}
