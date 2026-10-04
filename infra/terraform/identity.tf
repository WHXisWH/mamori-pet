resource "google_firebase_project" "main" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.apis]
}

resource "google_firebase_web_app" "child" {
  provider     = google-beta
  project      = var.project_id
  display_name = "まもりペット（子ども側）"

  depends_on = [google_firebase_project.main]
}

resource "google_firebase_web_app" "guardian" {
  provider     = google-beta
  project      = var.project_id
  display_name = "まもりペット 保護者（保護者側）"

  depends_on = [google_firebase_project.main]
}

resource "google_identity_platform_config" "main" {
  project = var.project_id

  autodelete_anonymous_users = true
  authorized_domains         = var.authorized_domains

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }

    anonymous {
      enabled = false
    }

    phone_number {
      enabled = false
    }
  }

  mfa {
    state = "DISABLED"
  }

  depends_on = [google_firebase_project.main]
}

resource "google_identity_platform_default_supported_idp_config" "google" {
  count = var.google_oauth_client_id == "" ? 0 : 1

  enabled       = true
  idp_id        = "google.com"
  client_id     = var.google_oauth_client_id
  client_secret = var.google_oauth_client_secret

  depends_on = [google_identity_platform_config.main]
}
