# サービス用のシークレット。レプリカは東京だけに置く。アクセス権はシークレットごとに付与し、プロジェクト単位の secretAccessor は付けない。
resource "random_password" "calendar_oauth_state" {
  length  = 48
  special = false
}

# 自発ターン配信エンドポイントの内部トークン：Cloud Scheduler のリクエストヘッダーと api が読むシークレットは同じ値。
# 変数で指定しなければ Terraform が生成し、state ファイルと Secret Manager にだけ保存する。環境変数に平文では書かない。
resource "random_password" "proactive_dispatch_token" {
  length  = 48
  special = false
}

locals {
  secret_ids = toset(concat(
    ["calendar-oauth-state", "proactive-dispatch-token"],
    local.calendar_enabled ? ["google-oauth-client-secret"] : [],
    local.gmail_enabled ? ["gmail-sender-credentials"] : [],
  ))
  secret_values = {
    calendar-oauth-state       = random_password.calendar_oauth_state.result
    proactive-dispatch-token   = var.proactive_dispatch_token != "" ? var.proactive_dispatch_token : random_password.proactive_dispatch_token.result
    google-oauth-client-secret = var.google_oauth_client_secret
    gmail-sender-credentials   = var.gmail_sender_credentials
  }
  secret_accessors = merge([
    for svc, envs in local.service_secret_env : {
      for secret in distinct(values(envs)) : "${svc}|${secret}" => { svc = svc, secret = secret }
    }
  ]...)
}

resource "google_secret_manager_secret" "secrets" {
  for_each = local.secret_ids

  secret_id = each.key

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "secrets" {
  for_each = local.secret_ids

  secret      = google_secret_manager_secret.secrets[each.key].id
  secret_data = local.secret_values[each.key]
}

resource "google_secret_manager_secret_iam_member" "accessors" {
  for_each = local.secret_accessors

  secret_id = google_secret_manager_secret.secrets[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.svc[each.value.svc].member
}
