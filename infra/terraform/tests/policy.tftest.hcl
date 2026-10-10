mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id  = "ijime-test"
  environment = "dev"
}

run "risk_engine_and_notifier_cannot_touch_content_key" {
  command = plan

  assert {
    condition = length([
      for k, b in local.kms_bindings : k
      if b.key == "content" && contains(["risk-engine", "notifier"], b.sa)
    ]) == 0
    error_message = "docs/03-database.md「アクセス制御・インデックス・保存期間・削除」：リスクエンジンと通知サービスには content 鍵の権限を一切付けない。"
  }

  assert {
    condition = length([
      for k, b in local.kms_bindings : k
      if b.key == "content" && contains(["risk-engine", "notifier", "calendar-sync"], b.sa)
    ]) == 0
    error_message = "calendar-sync が使えるのは tokens 鍵だけ。"
  }

  assert {
    condition     = alltrue([for k, b in local.kms_bindings : contains(keys(local.services), b.sa)])
    error_message = "key_access.json に未知のサービスアカウントがある。"
  }
}

run "only_api_and_voice_relay_are_public" {
  command = plan

  assert {
    condition     = toset([for k, s in google_cloud_run_v2_service.svc : k if s.ingress == "INGRESS_TRAFFIC_ALL"]) == toset(["api", "voice-relay"])
    error_message = "docs/04-backend-api.md「サービス構成と共通規約」：外部に公開するのは api と voice-relay だけ。"
  }

  assert {
    condition     = toset(keys(google_cloud_run_v2_service_iam_member.public_invoker)) == toset(["api", "voice-relay"])
    error_message = "allUsers を付与できるのは api と voice-relay だけ。"
  }

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : s.location == "asia-northeast1"])
    error_message = "すべての Cloud Run サービスは asia-northeast1 に置く。"
  }
}

run "web_apps_follow_landing_pattern" {
  command = plan

  assert {
    condition     = toset(keys(google_cloud_run_v2_service.web)) == toset(["child-web", "guardian-web"]) && toset(keys(google_cloud_run_v2_service_iam_member.web_public_invoker)) == toset(["child-web", "guardian-web"])
    error_message = "子ども側と保護者側にそれぞれ 1 つの Cloud Run サービスがあり、Firebase Hosting から転送されるため allUsers に公開する。"
  }

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.web : s.location == "asia-northeast1" && s.ingress == "INGRESS_TRAFFIC_ALL"])
    error_message = "フロントエンドの Cloud Run サービスも asia-northeast1 に置く。"
  }

  assert {
    condition     = toset([for k, sa in google_service_account.web : sa.account_id]) == toset(["sa-child-web", "sa-guardian-web"])
    error_message = "フロントエンドの実行用サービスアカウントは専用の sa-child-web / sa-guardian-web で、ロールを持たない。"
  }

  assert {
    condition     = length([for k, b in local.project_role_bindings : k if startswith(b.sa, "child-web") || startswith(b.sa, "guardian-web")]) == 0
    error_message = "フロントエンドのサービスアカウントにはプロジェクト単位のロールを付けない（フロントエンドは GCP に直接接続しない）。"
  }

  assert {
    condition     = toset(values(var.hosting_site_ids)) == toset([for k, s in google_firebase_hosting_site.web : s.site_id])
    error_message = "Hosting のサイト ID は hosting_site_ids から取り、apps/*/firebase.json と一致させる。"
  }
}

run "firestore_rules_deny_everything" {
  command = plan

  assert {
    condition     = can(regex("allow read, write: if false;", file("${path.module}/firestore.rules")))
    error_message = "Firestore のセキュリティルールは、クライアントからのアクセスをすべて拒否する。"
  }

  assert {
    condition     = length(regexall("allow [a-z, ]+: if (?:true|request)", file("${path.module}/firestore.rules"))) == 0
    error_message = "Firestore のルールに許可条件を一切書かない。"
  }
}

run "every_event_topic_has_a_dead_letter" {
  command = plan

  assert {
    condition     = length(local.pubsub_topics) == 8 && toset(keys(google_pubsub_topic.dead_letter)) == toset(local.pubsub_topics)
    error_message = "docs/04-backend-api.md「内部イベントと Agent ツール」：トピックは 8 つで、それぞれにデッドレタートピックが必要。"
  }

  assert {
    condition     = alltrue([for k, t in google_pubsub_topic.events : length(t.message_storage_policy[0].allowed_persistence_regions) == 1 && contains(t.message_storage_policy[0].allowed_persistence_regions, "asia-northeast1")])
    error_message = "Pub/Sub のメッセージは東京リージョンだけに保存する。"
  }
}

run "adk_never_captures_content_in_spans" {
  command = plan

  assert {
    condition     = local.common_env["ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS"] == "false"
    error_message = "ADK のテレメトリーでプロンプトと応答の内容を収集しない。"
  }
}

run "event_routing_matches_services" {
  command = plan

  assert {
    condition     = toset([for k, s in local.pubsub_subscriptions : s.subscriber if s.topic == "crisis.detected"]) == toset(["notifier", "risk-engine"])
    error_message = "crisis.detected は notifier（通知）と risk-engine（L4 の記録）がサブスクライブする。"
  }

  assert {
    condition     = length([for k, s in local.pubsub_subscriptions : k if s.topic == "risk.level_changed"]) == 0
    error_message = "リスクレベルの変化は risk-engine が直接書き込み、相談をスケジュールする。api / notifier のサブスクリプションは置かない。"
  }

  assert {
    condition     = toset([for q in [google_cloud_tasks_queue.notify_send, google_cloud_tasks_queue.crisis_escalation, google_cloud_tasks_queue.consultation_timeout] : q.name]) == toset(["notify-send", "crisis-escalation", "consultation-timeout"])
    error_message = "Cloud Tasks のキュー名は、services/*/src で enqueue する queue と一致させる。"
  }
}

run "internal_calls_go_through_vpc" {
  command = plan

  assert {
    condition     = toset([for k, s in google_cloud_run_v2_service.svc : k if length(s.template[0].vpc_access) > 0]) == toset(["api", "voice-relay"])
    error_message = "Direct VPC egress を使うのは、内部サービスを呼び出す api と voice-relay だけ。"
  }

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : alltrue([for v in s.template[0].vpc_access : v.egress == "ALL_TRAFFIC"])])
    error_message = "内部サービスは内部トラフィックだけを受け付けるため、VPC egress は ALL_TRAFFIC にする。"
  }

  assert {
    condition     = google_compute_subnetwork.run_egress.region == "asia-northeast1" && google_compute_subnetwork.run_egress.private_ip_google_access
    error_message = "egress 用サブネットは東京に置き、Private Google Access を有効にする。"
  }
}

run "secrets_stay_in_tokyo_and_are_scoped" {
  command = plan

  assert {
    condition     = alltrue([for k, s in google_secret_manager_secret.secrets : alltrue([for r in s.replication[0].user_managed[0].replicas : r.location == "asia-northeast1"])])
    error_message = "シークレットのレプリカは asia-northeast1 だけに置く。"
  }

  assert {
    condition     = length([for k, b in local.project_role_bindings : k if b.role == "roles/secretmanager.secretAccessor"]) == 0
    error_message = "シークレットへのアクセス権はシークレットごとに付与し、プロジェクト単位の secretAccessor は付けない。"
  }

  assert {
    condition     = alltrue([for k, a in local.secret_accessors : contains(["api", "calendar-sync"], a.svc)])
    error_message = "OAuth 関連のシークレットを読めるのは api と calendar-sync だけ。Gmail の認証情報がないときは notifier はシークレットを一切読まない。"
  }
}

run "calendar_off_without_oauth_client" {
  command = plan

  assert {
    condition     = !contains(keys(google_cloud_scheduler_job.jobs), "calendar-sync-daily") && !contains(keys(google_secret_manager_secret.secrets), "google-oauth-client-secret")
    error_message = "OAuth クライアントがないときは、カレンダー同期をスケジュールせず、クライアントシークレットも作らない。"
  }

  assert {
    condition     = !contains(keys(local.service_env["api"]), "GOOGLE_OAUTH_CLIENT_ID")
    error_message = "OAuth クライアントがないときは、api にカレンダー OAuth の設定を渡さない（api はこれを見てカレンダーのエンドポイントを無効にする）。"
  }
}

run "calendar_on_with_oauth_client" {
  command = plan

  variables {
    google_oauth_client_id     = "test-client.apps.googleusercontent.com"
    google_oauth_client_secret = "test-secret"
    api_public_url             = "https://api.example.jp"
  }

  assert {
    condition     = local.service_env["api"]["CALENDAR_OAUTH_REDIRECT_URI"] == "https://api.example.jp/v1/calendar/callback"
    error_message = "カレンダーのコールバック URL は api の公開 URL から組み立てる。"
  }

  assert {
    condition     = contains(keys(google_cloud_scheduler_job.jobs), "calendar-sync-daily") && toset(keys(local.secret_accessors)) == toset(["api|calendar-oauth-state", "api|proactive-dispatch-token", "api|google-oauth-client-secret", "calendar-sync|google-oauth-client-secret"])
    error_message = "カレンダーを有効にしたらカレンダー同期をスケジュールし、クライアントシークレットは api と calendar-sync だけに渡す。"
  }
}

run "capacity_per_service" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.svc["voice-relay"].template[0].max_instance_request_concurrency == var.voice_relay_concurrency && var.voice_relay_concurrency < var.service_concurrency
    error_message = "voice-relay は 1 インスタンスあたり少数の音声セッションだけを受け持つ（低い同時実行数）。"
  }

  assert {
    condition     = toset([for k, s in google_cloud_run_v2_service.svc : k if s.template[0].scaling[0].min_instance_count > 0]) == toset(["api", "notifier"])
    error_message = "最小インスタンスを確保するのは危機対応経路（api、notifier）だけで、ほかのサービスは 0 までスケールインする。"
  }

  assert {
    condition     = alltrue([for k in ["api", "notifier"] : google_cloud_run_v2_service.svc[k].template[0].scaling[0].min_instance_count == var.crisis_path_min_instances])
    error_message = "危機対応経路の最小インスタンス数は crisis_path_min_instances から取る。"
  }
}

run "queues_for_recheck_and_proactive_turns" {
  command = plan

  assert {
    condition     = google_cloud_tasks_queue.crisis_recheck.name == "crisis-recheck" && google_cloud_tasks_queue.proactive_turns.name == "proactive-turns"
    error_message = "再審査と自発ターンにはそれぞれ 1 つのキューがあり、名前はサービスのコードと一致させる。"
  }

  assert {
    condition     = alltrue([for q in [google_cloud_tasks_queue.crisis_recheck, google_cloud_tasks_queue.proactive_turns] : q.rate_limits[0].max_dispatches_per_second * 60 <= 300 / 2 && q.location == "asia-northeast1"])
    error_message = "バックグラウンドキューのディスパッチ速度は Flash のクォータ（pilot.flashRequestsPerMinute = 300 回/分）の半分以下に抑え、オンラインの会話に余裕を残す。キューは東京に置く。"
  }

  assert {
    condition     = alltrue([for b in [google_cloud_run_v2_service_iam_member.tasks_invokes_pet_agent, google_cloud_run_v2_service_iam_member.tasks_invokes_signal_worker] : b.role == "roles/run.invoker"]) && google_cloud_run_v2_service_iam_member.tasks_invokes_pet_agent.name == "pet-agent" && google_cloud_run_v2_service_iam_member.tasks_invokes_signal_worker.name == "signal-worker"
    error_message = "Cloud Tasks の呼び出し用サービスアカウントは pet-agent（自発ターン）と signal-worker（再審査）を呼び出せる。"
  }
}

run "budget_off_without_billing_account" {
  command = plan

  assert {
    condition     = length(google_billing_budget.monthly) == 0
    error_message = "請求先アカウントがないときは予算を作らない。"
  }

  assert {
    condition     = google_pubsub_topic.budget_alerts.message_storage_policy[0].allowed_persistence_regions == toset(["asia-northeast1"])
    error_message = "budget-alerts トピックは常に作る（音声のサーキットブレーカーが購読する）。メッセージは東京だけに保存する。"
  }

  assert {
    condition     = google_pubsub_subscription.budget_alerts_notifier.name == "budget-alerts--notifier" && google_pubsub_subscription.budget_alerts_notifier.expiration_policy[0].ttl == ""
    error_message = "請求先アカウントがないときも予算通知の push サブスクリプションは作る（内部イングレスの notifier に push し、公開されている voice-relay には push しない）。期限切れにしない。"
  }

  assert {
    condition     = length(google_logging_project_bucket_config.tokyo) == 0 && length(google_logging_project_exclusion.default_routed_to_tokyo) == 0
    error_message = "東京のログバケットを有効にしていないときは _Default のルーティングを変えない。"
  }
}

run "budget_and_alerts_on" {
  command = plan

  variables {
    billing_account_id        = "000000-000000-000000"
    alert_notification_emails = ["ops@example.jp"]
    log_bucket_tokyo_enabled  = true
  }

  assert {
    condition     = google_billing_budget.monthly[0].amount[0].specified_amount[0].currency_code == "JPY" && google_billing_budget.monthly[0].amount[0].specified_amount[0].units == "75000"
    error_message = "月予算は 7.5 万円（pilot.monthlyBudgetJpy）。"
  }

  assert {
    condition     = [for r in google_billing_budget.monthly[0].threshold_rules : r.threshold_percent] == [0.5, 0.9, 1.0]
    error_message = "予算の 50%、90%、100% でアラートを出す（pilot.budgetAlertThresholds）。"
  }

  assert {
    condition     = google_billing_budget.monthly[0].budget_filter[0].calendar_period == "MONTH"
    error_message = "予算は暦月で集計する。"
  }

  assert {
    condition     = length(google_monitoring_notification_channel.email) == 1 && google_monitoring_notification_channel.email["ops@example.jp"].labels.email_address == "ops@example.jp" && length(local.alert_channels) == 1
    error_message = "アラートの送信先メールアドレスを設定できる。"
  }

  assert {
    condition     = google_logging_project_bucket_config.tokyo[0].location == "asia-northeast1" && google_logging_project_sink.tokyo[0].filter == google_logging_project_exclusion.default_routed_to_tokyo[0].filter
    error_message = "ログバケットは東京に置く。東京へ送るログと _Default から除外するログは完全に一致させ、欠落も重複も起こさない。"
  }
}

run "gmail_sender_only_for_notifier" {
  command = plan

  variables {
    gmail_sender_credentials = "{\"clientId\":\"c\",\"clientSecret\":\"s\",\"refreshToken\":\"r\",\"sender\":\"n@example.jp\"}"
  }

  assert {
    condition     = [for k, a in local.secret_accessors : a.svc if a.secret == "gmail-sender-credentials"] == ["notifier"]
    error_message = "Gmail の送信用認証情報を読めるのは sa-notifier だけ。"
  }

  assert {
    condition     = local.service_secret_env["notifier"]["GMAIL_CREDENTIALS"] == "gmail-sender-credentials" && length(local.service_secret_env["notifier"]) == 1
    error_message = "notifier は GMAIL_CREDENTIALS を Secret Manager から受け取る。"
  }

  assert {
    condition     = alltrue([for r in google_secret_manager_secret.secrets["gmail-sender-credentials"].replication[0].user_managed[0].replicas : r.location == "asia-northeast1"])
    error_message = "シークレットのレプリカは東京だけに置く。"
  }
}

run "daily_job_sharded_and_weekly_fanout_queue" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_job.jobs["risk-engine-daily"].template[0].task_count == var.risk_daily_task_count && google_cloud_run_v2_job.jobs["calendar-sync-daily"].template[0].task_count == 1
    error_message = "日次のリスクレベル判定は risk_daily_task_count で分割する。カレンダー同期は分割しない。"
  }

  assert {
    condition     = google_cloud_tasks_queue.weekly_report.name == "weekly-report" && google_cloud_tasks_queue.weekly_report.location == "asia-northeast1"
    error_message = "週次レポートのファンアウトには weekly-report キューを使い、東京に置く。"
  }

  assert {
    condition     = local.ttl_fields["jobRuns"] == "expiresAt"
    error_message = "分割処理の調整用ドキュメント jobRuns は TTL で削除する。"
  }
}
