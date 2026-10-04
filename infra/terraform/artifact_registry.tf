resource "google_artifact_registry_repository" "images" {
  repository_id = local.name_prefix
  location      = var.region
  format        = "DOCKER"
  description   = "Cloud Run サービスのイメージ"

  kms_key_name = google_kms_crypto_key.storage.id

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "2592000s"
    }
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.storage_key_artifact_registry,
  ]
}

resource "google_project_service_identity" "artifactregistry" {
  provider = google-beta
  service  = "artifactregistry.googleapis.com"

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key_iam_member" "storage_key_artifact_registry" {
  crypto_key_id = google_kms_crypto_key.storage.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.artifactregistry.email}"
}

locals {
  image_base        = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"
}
