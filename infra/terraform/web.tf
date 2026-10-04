# 子ども側・保護者側 PWA：landing-web と同じ方式でデプロイする。Cloud Run（東京）で Next.js をリクエストごとにレンダリングし（CSP nonce）、
# Firebase Hosting サイトがすべてのリクエストを Cloud Run に転送する。実行用サービスアカウントにはロールを付けず、フロントエンドは GCP に直接接続しない。
locals {
  web_apps = {
    child-web = {
      firebase_app = google_firebase_web_app.child
      site_id      = var.hosting_site_ids.child
      origin       = var.child_web_origin
      description  = "子ども側 PWA（Next.js、リクエストごとにレンダリング）"
      env = {
        NEXT_PUBLIC_VOICE_WS_URL = local.voice_ws_url
      }
    }
    guardian-web = {
      firebase_app = google_firebase_web_app.guardian
      site_id      = var.hosting_site_ids.guardian
      origin       = var.guardian_web_origin
      description  = "保護者側 PWA（Next.js、リクエストごとにレンダリング）"
      env          = {}
    }
  }

  web_common_env = {
    NODE_ENV                         = "production"
    NEXT_TELEMETRY_DISABLED          = "1"
    NEXT_PUBLIC_API_BASE_URL         = local.api_public_url
    NEXT_PUBLIC_CHILD_APP_URL        = var.child_web_origin
    NEXT_PUBLIC_GUARDIAN_APP_URL     = var.guardian_web_origin
    NEXT_PUBLIC_FIREBASE_PROJECT_ID  = var.project_id
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "${var.project_id}.firebaseapp.com"
  }
}

data "google_firebase_web_app_config" "web" {
  for_each = local.web_apps
  provider = google-beta

  web_app_id = each.value.firebase_app.app_id
}

resource "google_firebase_hosting_site" "web" {
  for_each = local.web_apps
  provider = google-beta

  site_id = each.value.site_id
  app_id  = each.value.firebase_app.app_id

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "web" {
  for_each = local.web_apps

  account_id   = "sa-${each.key}"
  display_name = "ijime ${each.key}"
  description  = "${each.value.description}の Cloud Run 実行用サービスアカウント（ロールなし）"

  depends_on = [google_project_service.apis]
}

resource "google_service_account_iam_member" "cloudbuild_acts_as_web" {
  for_each = local.web_apps

  service_account_id = google_service_account.web[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.cloudbuild.member
}

resource "google_cloud_run_v2_service" "web" {
  for_each = local.web_apps

  name                = each.key
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  description         = each.value.description

  template {
    service_account                  = google_service_account.web[each.key].email
    max_instance_request_concurrency = 80
    timeout                          = "60s"

    scaling {
      min_instance_count = 0
      max_instance_count = var.environment == "prod" ? 10 : 2
    }

    containers {
      image = var.web_image_tag == "" ? local.placeholder_image : "${local.image_base}/${each.key}:${var.web_image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      dynamic "env" {
        for_each = merge(
          local.web_common_env,
          each.value.env,
          { NEXT_PUBLIC_FIREBASE_API_KEY = data.google_firebase_web_app_config.web[each.key].api_key },
          var.fcm_vapid_key == "" ? {} : { NEXT_PUBLIC_FIREBASE_VAPID_KEY = var.fcm_vapid_key },
        )
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [google_project_service.apis]

  lifecycle {
    ignore_changes = [client, client_version]
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public_invoker" {
  for_each = local.web_apps

  name     = google_cloud_run_v2_service.web[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
