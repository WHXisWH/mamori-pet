# 東京のログバケット（すべての GCP リソースを asia-northeast1 に置くため）。
# _Default バケットの場所はプロジェクト作成時に決まり変更できないため、東京にバケットを新設し、同じフィルタ条件でログを送ったうえで、_Default シンクではそのログを除外する。
# google_logging_project_exclusion は _Default シンクにだけ作用し、ここで新設するシンクには影響しない。
# _Required バケット（管理アクティビティの監査ログ）は Google が固定の場所に保存し、変更できない。アプリケーションログは含まれない。
# アプリケーションログ自体に子どもの入力は含まれない（service-kit Logger の assertLoggable）。

locals {
  # _Default シンクの既定のフィルタ条件と同じ：_Required が受け取る監査ログ以外のすべてのログ
  default_sink_filter = join(" AND ", [
    for id in [
      "cloudaudit.googleapis.com/activity",
      "externalaudit.googleapis.com/activity",
      "cloudaudit.googleapis.com/system_event",
      "externalaudit.googleapis.com/system_event",
      "cloudaudit.googleapis.com/access_transparency",
      "externalaudit.googleapis.com/access_transparency",
    ] : "NOT LOG_ID(\"${id}\")"
  ])
}

resource "google_logging_project_bucket_config" "tokyo" {
  count = var.log_bucket_tokyo_enabled ? 1 : 0

  project        = var.project_id
  location       = var.region
  bucket_id      = "${local.name_prefix}-tokyo"
  retention_days = var.log_retention_days
  description    = "アプリケーションとプラットフォームのログ（東京）。子どもの入力は含まない"

  depends_on = [google_project_service.apis]
}

resource "google_logging_project_sink" "tokyo" {
  count = var.log_bucket_tokyo_enabled ? 1 : 0

  name                   = "${local.name_prefix}-tokyo"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.tokyo[0].id}"
  filter                 = local.default_sink_filter
  unique_writer_identity = true
}

# 東京のシンクを作ってから除外する。切り替え中にログを失わない
resource "google_logging_project_exclusion" "default_routed_to_tokyo" {
  count = var.log_bucket_tokyo_enabled ? 1 : 0

  name        = "${local.name_prefix}-routed-to-tokyo"
  description = "これらのログは ${local.name_prefix}-tokyo シンクが東京のバケットに保存済み"
  filter      = local.default_sink_filter

  depends_on = [google_logging_project_sink.tokyo]
}
