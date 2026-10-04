resource "google_kms_key_ring" "main" {
  name     = "${local.name_prefix}-${var.environment}"
  location = var.region

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "content" {
  name            = "content"
  key_ring        = google_kms_key_ring.main.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "tokens" {
  name            = "tokens"
  key_ring        = google_kms_key_ring.main.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "storage" {
  name            = "storage"
  key_ring        = google_kms_key_ring.main.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "pseudo" {
  name     = "pseudo"
  key_ring = google_kms_key_ring.main.id
  purpose  = "MAC"

  version_template {
    algorithm        = "HMAC_SHA256"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

data "google_project" "current" {}

resource "google_project_service_identity" "firestore" {
  provider = google-beta
  service  = "firestore.googleapis.com"

  depends_on = [google_project_service.apis]
}

resource "google_project_service_identity" "pubsub" {
  provider = google-beta
  service  = "pubsub.googleapis.com"

  depends_on = [google_project_service.apis]
}

data "google_storage_project_service_account" "gcs" {
  depends_on = [google_project_service.apis]
}

data "google_bigquery_default_service_account" "bq" {
  depends_on = [google_project_service.apis]
}

locals {
  cmek_service_agents = {
    firestore = "serviceAccount:${google_project_service_identity.firestore.email}"
    pubsub    = "serviceAccount:${google_project_service_identity.pubsub.email}"
    gcs       = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
    bigquery  = "serviceAccount:${data.google_bigquery_default_service_account.bq.email}"
  }
}

resource "google_kms_crypto_key_iam_member" "storage_key_service_agents" {
  for_each = local.cmek_service_agents

  crypto_key_id = google_kms_crypto_key.storage.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = each.value
}
