resource "google_service_account" "svc" {
  for_each = local.services

  account_id   = "sa-${each.key}"
  display_name = "ijime ${each.key}"
  description  = each.value.description

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "pubsub_push" {
  account_id   = "sa-pubsub-push"
  display_name = "Pub/Sub push から Cloud Run を呼び出す"

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "scheduler" {
  account_id   = "sa-scheduler"
  display_name = "Cloud Scheduler から Cloud Run Job を起動し、notifier の週次レポートを呼び出す"

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "tasks" {
  account_id   = "sa-tasks"
  display_name = "Cloud Tasks から notifier を呼び出す"

  depends_on = [google_project_service.apis]
}

locals {
  kms_bindings = merge([
    for key_name, roles in local.key_access : {
      for pair in flatten([
        for role, sas in roles : [for sa in sas : { key = key_name, role = role, sa = sa }]
      ]) : "${pair.key}|${pair.role}|${pair.sa}" => pair
    }
  ]...)

  kms_keys = {
    content = google_kms_crypto_key.content.id
    tokens  = google_kms_crypto_key.tokens.id
    pseudo  = google_kms_crypto_key.pseudo.id
  }

  project_roles = {
    api = [
      "roles/datastore.user",
      "roles/pubsub.publisher",
      "roles/cloudtasks.enqueuer",
      "roles/aiplatform.user",
      "roles/firebaseauth.admin",
      "roles/logging.logWriter",
      "roles/cloudtrace.agent",
      "roles/monitoring.metricWriter",
      "roles/firebaseappcheck.tokenVerifier",
    ]
    voice-relay = [
      "roles/datastore.user",
      "roles/pubsub.publisher",
      "roles/cloudtasks.enqueuer",
      "roles/aiplatform.user",
      "roles/logging.logWriter",
      "roles/cloudtrace.agent",
      "roles/monitoring.metricWriter",
    ]
    pet-agent = concat([
      "roles/datastore.user",
      "roles/aiplatform.user",
      "roles/logging.logWriter",
      "roles/cloudtrace.agent",
      "roles/monitoring.metricWriter",
      ],
      var.child_push_enabled ? ["roles/firebasecloudmessaging.admin"] : [],
      var.model_armor_template == "" ? [] : ["roles/modelarmor.user", "roles/modelarmor.viewer"],
    )
    signal-worker = [
      "roles/datastore.user",
      "roles/pubsub.publisher",
      "roles/aiplatform.user",
      "roles/bigquery.jobUser",
      "roles/logging.logWriter",
      "roles/cloudtrace.agent",
      "roles/monitoring.metricWriter",
    ]
    risk-engine = [
      "roles/datastore.user",
      "roles/pubsub.publisher",
      "roles/cloudtasks.enqueuer",
      "roles/bigquery.jobUser",
      "roles/logging.logWriter",
      "roles/cloudtrace.agent",
      "roles/monitoring.metricWriter",
    ]
    # 保護者向けの危機 webpush は notifier が送る（docs/04-backend-api.md「危機対応経路とエラーコード」手順4）ため FCM の送信権限が要る
    notifier = [
      "roles/datastore.user",
      "roles/cloudtasks.enqueuer",
      "roles/aiplatform.user",
      "roles/bigquery.jobUser",
      "roles/logging.logWriter",
      "roles/cloudtrace.agent",
      "roles/monitoring.metricWriter",
      "roles/firebasecloudmessaging.admin",
    ]
    calendar-sync = [
      "roles/datastore.user",
      "roles/logging.logWriter",
      "roles/cloudtrace.agent",
      "roles/monitoring.metricWriter",
    ]
  }

  project_role_bindings = merge([
    for sa, roles in local.project_roles : { for role in roles : "${sa}|${role}" => { sa = sa, role = role } }
  ]...)
}

resource "google_kms_crypto_key_iam_member" "service_keys" {
  for_each = local.kms_bindings

  crypto_key_id = local.kms_keys[each.value.key]
  role          = each.value.role
  member        = google_service_account.svc[each.value.sa].member
}

resource "google_project_iam_member" "service_roles" {
  for_each = local.project_role_bindings

  project = var.project_id
  role    = each.value.role
  member  = google_service_account.svc[each.value.sa].member
}

resource "google_bigquery_dataset_iam_member" "features_signal_worker" {
  dataset_id = google_bigquery_dataset.features_deid.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_service_account.svc["signal-worker"].member
}

resource "google_bigquery_dataset_iam_member" "features_risk_engine" {
  dataset_id = google_bigquery_dataset.features_deid.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_service_account.svc["risk-engine"].member
}

resource "google_bigquery_dataset_iam_member" "features_notifier" {
  dataset_id = google_bigquery_dataset.features_deid.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = google_service_account.svc["notifier"].member
}

resource "google_bigquery_dataset_iam_member" "ops_notifier" {
  dataset_id = google_bigquery_dataset.ops_metrics.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_service_account.svc["notifier"].member
}

resource "google_storage_bucket_iam_member" "artworks_api" {
  bucket = google_storage_bucket.artworks.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.svc["api"].member
}

resource "google_storage_bucket_iam_member" "kb_readers" {
  for_each = local.services

  bucket = google_storage_bucket.kb.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.svc[each.key].member
}

resource "google_storage_bucket_iam_member" "exports_api" {
  bucket = google_storage_bucket.exports.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.svc["api"].member
}

resource "google_service_account_iam_member" "api_signs_blobs" {
  service_account_id = google_service_account.svc["api"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = google_service_account.svc["api"].member
}
