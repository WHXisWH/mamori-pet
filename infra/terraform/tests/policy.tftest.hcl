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
    error_message = "OAuth 関連のシークレットを読めるのは api と calendar-sync だけ。"
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
    condition     = contains(keys(google_cloud_scheduler_job.jobs), "calendar-sync-daily") && toset(keys(local.secret_accessors)) == toset(["api|calendar-oauth-state", "api|google-oauth-client-secret", "calendar-sync|google-oauth-client-secret"])
    error_message = "カレンダーを有効にしたらカレンダー同期をスケジュールし、クライアントシークレットは api と calendar-sync だけに渡す。"
  }
}
