output "service_urls" {
  description = "Cloud Run サービスの URL。外部に公開するのは api と voice-relay だけ"
  value       = { for k, s in google_cloud_run_v2_service.svc : k => s.uri }
}

output "calendar_oauth_redirect_uri" {
  description = "OAuth クライアントの「承認済みのリダイレクト URI」に登録する値。OAuth クライアントが未設定のときは空"
  value       = lookup(local.service_env["api"], "CALENDAR_OAUTH_REDIRECT_URI", "")
}

output "service_accounts" {
  value = { for k, sa in google_service_account.svc : k => sa.email }
}

output "kms_keys" {
  value = {
    content = google_kms_crypto_key.content.id
    tokens  = google_kms_crypto_key.tokens.id
    storage = google_kms_crypto_key.storage.id
    pseudo  = google_kms_crypto_key.pseudo.id
  }
}

output "buckets" {
  value = {
    artworks = google_storage_bucket.artworks.name
    kb       = google_storage_bucket.kb.name
    eval     = google_storage_bucket.eval.name
    exports  = google_storage_bucket.exports.name
  }
}

output "artifact_registry" {
  value = local.image_base
}

output "firebase_web_apps" {
  value = {
    child    = google_firebase_web_app.child.app_id
    guardian = google_firebase_web_app.guardian.app_id
  }
}

output "firebase_web_config" {
  description = "フロントエンドのビルド引数（NEXT_PUBLIC_FIREBASE_*）。Web API key はページと一緒にブラウザーへ配信される値で、機密ではない。measurementId は出力しない（Analytics を使わないため）"
  value = {
    for k, c in data.google_firebase_web_app_config.web : k => {
      app_id              = local.web_apps[k].firebase_app.app_id
      api_key             = c.api_key
      auth_domain         = c.auth_domain
      messaging_sender_id = c.messaging_sender_id
    }
  }
}

output "web_service_urls" {
  description = "子ども側・保護者側 Cloud Run の直接 URL（正式な入口は Hosting サイト）"
  value       = { for k, s in google_cloud_run_v2_service.web : k => s.uri }
}

output "hosting_sites" {
  description = "Firebase Hosting サイトの URL。child_web_origin / guardian_web_origin と一致させる"
  value       = { for k, s in google_firebase_hosting_site.web : k => s.default_url }
}

output "cloudbuild_source_bucket" {
  description = "gcloud builds submit のソースを一時保存するバケット（東京）。--gcs-source-staging-dir に指定する"
  value       = google_storage_bucket.cloudbuild_source.name
}

output "cloudbuild_service_account" {
  value = google_service_account.cloudbuild.email
}

output "vpc_service_controls" {
  description = "組織のないプロジェクトでは VPC Service Controls を設定しない"
  value       = var.organization_id == "" ? "skipped (no organization)" : "TODO: configure perimeter"
}
