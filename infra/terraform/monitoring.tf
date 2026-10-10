# 予算と運用アラート（docs/02-agent-architecture.md「評価・リリース基準・オブザーバビリティ」のアラートの段落）。
# 指標は構造化ログの event、method、latencyMs などのフィールドとプラットフォーム指標からだけ作り、子どもの入力は一切読まない

locals {
  alert_channels = [for c in google_monitoring_notification_channel.email : c.id]

  # 値は packages/config の pilot、crisis と一致させる。infra/tests が検証する
  alert_thresholds = {
    first_token_p95_ms    = 6000  # pilot.firstTokenP95Ms
    crisis_check_p95_ms   = 10000 # pilot.crisisCheckP95Ms
    crisis_notify_late_ms = 60000 # crisis.notifyWithinSeconds
    http_5xx_ratio        = 0.01
    http_429_ratio        = 0.05
    crisis_paused_ratio   = 0.05
    recheck_queue_depth   = 50
  }

  # 発生したら必ず人が対応するログイベント（service-kit Logger の event フィールド）。infra/tests がそれぞれサービスのコードにあることを検証する
  alert_events = {
    crisis_unacknowledged = ["crisis.resent", "crisis.escalation_exhausted"]
    crisis_delivery = [
      "crisis.guardian_unreachable",
      "notify.guardian_unreachable",
      "notify.channel_not_configured",
      "notify.email_auth_failed",
      "notify.email_quota_exhausted",
      "notify.email_rejected",
      "crisis.recheck_enqueue_failed",
    ]
  }

  run_logs = "resource.type=\"cloud_run_revision\""
}

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_notification_emails)

  display_name = "ops ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }
}

# ---- 予算：50/90/100% でメールを送り budget-alerts に発行する。notifier がこのトピックを購読し、100% で opsFlags/voice を書いて新しい音声セッションの受け付けを止める ----

resource "google_pubsub_topic" "budget_alerts" {
  name         = "budget-alerts"
  kms_key_name = google_kms_crypto_key.storage.id

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_pubsub_topic_iam_member" "budget_publisher" {
  topic  = google_pubsub_topic.budget_alerts.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"
}

# 予算通知は毎日何度も再送されるため、最新の 1 件だけを見ればよく、デッドレターは不要
resource "google_pubsub_subscription" "budget_alerts_notifier" {
  name                       = "budget-alerts--notifier"
  topic                      = google_pubsub_topic.budget_alerts.id
  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.svc["notifier"].uri}/internal/events/budget-alert"

    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = google_cloud_run_v2_service.svc["notifier"].uri
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_billing_budget" "monthly" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "${local.name_prefix}-${var.environment}-monthly"

  budget_filter {
    projects        = ["projects/${data.google_project.current.number}"]
    calendar_period = "MONTH"
  }

  amount {
    specified_amount {
      currency_code = "JPY"
      units         = tostring(var.budget_amount_jpy)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_alert_thresholds
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  all_updates_rule {
    pubsub_topic                     = google_pubsub_topic.budget_alerts.id
    schema_version                   = "1.0"
    monitoring_notification_channels = local.alert_channels
  }

  depends_on = [google_project_service.apis, google_pubsub_topic_iam_member.budget_publisher]
}

# ---- ログベースの指標 ----

resource "google_logging_metric" "crisis_check_count" {
  name   = "crisis_check_count"
  filter = "${local.run_logs} AND jsonPayload.event=\"crisis.check\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "method"
      value_type = "STRING"
    }
    labels {
      key        = "service"
      value_type = "STRING"
    }
  }

  label_extractors = {
    method  = "EXTRACT(jsonPayload.method)"
    service = "EXTRACT(resource.labels.service_name)"
  }
}

resource "google_logging_metric" "crisis_check_latency" {
  name            = "crisis_check_latency"
  filter          = "${local.run_logs} AND jsonPayload.event=\"crisis.check\""
  value_extractor = "EXTRACT(jsonPayload.latencyMs)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
    labels {
      key        = "service"
      value_type = "STRING"
    }
  }

  label_extractors = {
    service = "EXTRACT(resource.labels.service_name)"
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 32
      growth_factor      = 1.4
      scale              = 50
    }
  }
}

resource "google_logging_metric" "chat_first_token_latency" {
  name            = "chat_first_token_latency"
  filter          = "${local.run_logs} AND jsonPayload.event=\"chat.turn\" AND jsonPayload.firstVisibleTextMs>=0"
  value_extractor = "EXTRACT(jsonPayload.firstVisibleTextMs)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 32
      growth_factor      = 1.4
      scale              = 50
    }
  }
}

# 危機通知の初回が、通知の作成からいずれかのチャネルへの到達までに期限を超えた
resource "google_logging_metric" "crisis_notify_late" {
  name   = "crisis_notify_late"
  filter = "${local.run_logs} AND jsonPayload.event=\"notify.sent\" AND jsonPayload.kind=\"crisis\" AND jsonPayload.round=0 AND jsonPayload.latencyMs>${local.alert_thresholds.crisis_notify_late_ms}"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "ops_event_count" {
  name = "ops_event_count"
  filter = join("", [
    "${local.run_logs} AND jsonPayload.event=(",
    join(" OR ", [for e in flatten([local.alert_events.crisis_unacknowledged, local.alert_events.crisis_delivery]) : "\"${e}\""]),
    ")",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "event"
      value_type = "STRING"
    }
  }

  label_extractors = {
    event = "EXTRACT(jsonPayload.event)"
  }
}

# ---- アラートポリシー ----

resource "google_monitoring_alert_policy" "http_5xx_ratio" {
  display_name          = "Cloud Run 5xx の割合"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "全リクエストに占める 5xx の割合"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.label.response_code_class=\"5xx\""
      denominator_filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = local.alert_thresholds.http_5xx_ratio
      duration           = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "http_429_ratio" {
  display_name          = "Cloud Run 429 の割合"
  combiner              = "OR"
  severity              = "WARNING"
  notification_channels = local.alert_channels

  documentation {
    content = "子どもまたは保護者がレート制限される割合が高い：packages/config のレート制限の値とモデルの利用枠（chatUsage）を確認する。"
  }

  conditions {
    display_name = "全リクエストに占める 429 の割合"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.label.response_code=\"429\""
      denominator_filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = local.alert_thresholds.http_429_ratio
      duration           = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "first_token_p95" {
  display_name          = "会話の初回表示 p95"
  combiner              = "OR"
  severity              = "WARNING"
  notification_channels = local.alert_channels

  conditions {
    display_name = "chat.turn の firstVisibleTextMs p95 がパイロット目標を超えた"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.chat_first_token_latency.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.alert_thresholds.first_token_p95_ms
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "crisis_check_p95" {
  display_name          = "危機検知 p95"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "crisis.check の latencyMs p95 がパイロット目標を超えた"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.crisis_check_latency.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.alert_thresholds.crisis_check_p95_ms
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
        group_by_fields      = ["metric.label.service"]
      }
    }
  }
}

# モデルのスクリーニングまたは再確認が使えず、入力が保留された割合（docs/02-agent-architecture.md「危機検知器」の保留と再審査。アラートの段落の「モデルのエラー率の上昇」）
resource "google_monitoring_alert_policy" "crisis_paused_ratio" {
  display_name          = "危機検知の保留割合（モデルが使えない）"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  documentation {
    content = "保留されたメッセージは crisis-recheck で再審査される。Gemini のクォータ、リージョンの状態、crisis.model_unavailable のログを確認する。"
  }

  conditions {
    display_name = "全危機検知に占める method=paused の割合"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.crisis_check_count.name}\" AND metric.label.method=\"paused\""
      denominator_filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.crisis_check_count.name}\""
      comparison         = "COMPARISON_GT"
      threshold_value    = local.alert_thresholds.crisis_paused_ratio
      duration           = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

# キーワード一致後の再確認がタイムアウトした：危機は通常どおり other として扱い保護者に通知するが、カテゴリはモデルで確認されていない。
# 再確認を通過した検知はログでは screen と記録され、「再確認の回数」という分母を出せないため、回数でアラートを出す
resource "google_monitoring_alert_policy" "crisis_review_timeout" {
  display_name          = "危機の再確認タイムアウト（review_timeout）"
  combiner              = "OR"
  severity              = "WARNING"
  notification_channels = local.alert_channels

  conditions {
    display_name = "method=review_timeout が発生した"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.crisis_check_count.name}\" AND metric.label.method=\"review_timeout\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "crisis_notify_late" {
  display_name          = "危機対応経路が期限を超えた"
  combiner              = "OR"
  severity              = "CRITICAL"
  notification_channels = local.alert_channels

  documentation {
    content = "危機通知の初回が、検知から crisis.notifyWithinSeconds を超えてから到達した。notify-send キューの滞留、notifier のインスタンス、プッシュのチャネルを確認する。"
  }

  conditions {
    display_name = "初回の危機通知の到達が遅れた"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.crisis_notify_late.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "crisis_unacknowledged" {
  display_name          = "危機通知が未確認"
  combiner              = "OR"
  severity              = "CRITICAL"
  notification_channels = local.alert_channels

  documentation {
    content = "crisis.resent：規定時間内に保護者の確認がなく、第二の保護者を加えて再送した。crisis.escalation_exhausted：再送回数を使い切っても確認がなく、人による対応が必要。"
  }

  conditions {
    display_name = "危機通知の再送、または再送回数の枯渇"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.ops_event_count.name}\" AND metric.label.event=one_of(${join(",", [for e in local.alert_events.crisis_unacknowledged : "\"${e}\""])})"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.event"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "crisis_delivery" {
  display_name          = "危機対応経路で到達できない、または再審査できない"
  combiner              = "OR"
  severity              = "CRITICAL"
  notification_channels = local.alert_channels

  documentation {
    content = "保護者に使えるチャネルがない、通知チャネルが未設定、Gmail の送信用認証情報が無効か 1 日の送信上限を超えた、または保留されたメッセージを crisis-recheck キューに入れられなかった。危機通知は引き続き一定間隔で再送される。"
  }

  conditions {
    display_name = "危機通知の到達または再審査のキュー投入に失敗した"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.ops_event_count.name}\" AND metric.label.event=one_of(${join(",", [for e in local.alert_events.crisis_delivery : "\"${e}\""])})"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.event"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "dead_letter_backlog" {
  display_name          = "Pub/Sub デッドレターの滞留"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  documentation {
    content = "イベントが pubsub_max_delivery_attempts 回リトライしても失敗し、*-dead-letter-keep に入った。メッセージには ID しかない。該当サービスのエラーログを確認してから再発行するか削除する。"
  }

  conditions {
    display_name = "デッドレターのサブスクリプションに未処理のメッセージがある"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.label.subscription_id=ends_with(\"-dead-letter-keep\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.subscription_id"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recheck_backlog" {
  display_name          = "crisis-recheck の再審査の滞留"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "crisis-recheck のキューの深さ"
    condition_threshold {
      filter          = "resource.type=\"cloud_tasks_queue\" AND metric.type=\"cloudtasks.googleapis.com/queue/depth\" AND resource.label.queue_id=\"${google_cloud_tasks_queue.crisis_recheck.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.alert_thresholds.recheck_queue_depth
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}
