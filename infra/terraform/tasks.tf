resource "google_cloud_tasks_queue" "notify_send" {
  name     = "notify-send"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 50
    max_concurrent_dispatches = 20
  }

  retry_config {
    max_attempts       = 10
    min_backoff        = "5s"
    max_backoff        = "300s"
    max_doublings      = 5
    max_retry_duration = "86400s"
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue" "crisis_escalation" {
  name     = "crisis-escalation"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 10
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts       = -1
    min_backoff        = "10s"
    max_backoff        = "60s"
    max_retry_duration = "0s"
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue" "consultation_timeout" {
  name     = "consultation-timeout"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 10
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts       = 10
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_doublings      = 5
    max_retry_duration = "86400s"
  }

  depends_on = [google_project_service.apis]
}

# モデルが使えないあいだ保留された子どものメッセージの再審査（docs/02-agent-architecture.md「危機検知器」の保留と再審査）。
# ディスパッチ速度はモデルのクォータより低く抑える（再審査 1 回につき Flash のスクリーニング 1 回。2 回/秒 = 120 回/分、Flash のパイロットクォータは 300 回/分）。
# オンラインの会話に余裕を残し、復旧時の滞留で再びクォータを使い切らないようにする。モデルが復旧するまで上限なしでリトライする。
resource "google_cloud_tasks_queue" "crisis_recheck" {
  name     = "crisis-recheck"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 2
    max_concurrent_dispatches = 5
  }

  retry_config {
    max_attempts       = -1
    min_backoff        = "30s"
    max_backoff        = "600s"
    max_doublings      = 4
    max_retry_duration = "0s"
  }

  depends_on = [google_project_service.apis]
}

# 自発ターン（docs/02-agent-architecture.md「自発ターン（ペットから話しかける）」：api が子どもごとにキューへ入れ、pet-agent の /internal/proactive-turns を呼び出す）。
# 1 人の子どもにつき 1 日最大 3 回で、レート制限は Flash のクォータよりはるかに低い。古くなった声かけには意味がないので、短時間だけリトライする
resource "google_cloud_tasks_queue" "proactive_turns" {
  name     = "proactive-turns"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 1
    max_concurrent_dispatches = 5
  }

  retry_config {
    max_attempts       = 3
    min_backoff        = "10s"
    max_backoff        = "60s"
    max_doublings      = 2
    max_retry_duration = "600s"
  }

  depends_on = [google_project_service.apis]
}

# 週次レポートの分割（services/notifier/src/weekly.ts）：Scheduler の 1 回の呼び出しを batch.weeklyReportShards 個のタスクにファンアウトする。
# 失敗した分割だけをリトライする。月曜のうちにリトライし終われば十分
resource "google_cloud_tasks_queue" "weekly_report" {
  name     = "weekly-report"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 1
    max_concurrent_dispatches = 2
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "60s"
    max_backoff        = "600s"
    max_doublings      = 3
    max_retry_duration = "21600s"
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "tasks_invokes_pet_agent" {
  name     = google_cloud_run_v2_service.svc["pet-agent"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.tasks.member
}

resource "google_cloud_run_v2_service_iam_member" "tasks_invokes_notifier" {
  name     = google_cloud_run_v2_service.svc["notifier"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.tasks.member
}

resource "google_service_account_iam_member" "risk_engine_acts_as_tasks" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.svc["risk-engine"].member
}

resource "google_service_account_iam_member" "notifier_acts_as_tasks" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.svc["notifier"].member
}

resource "google_cloud_run_v2_service_iam_member" "tasks_invokes_signal_worker" {
  name     = google_cloud_run_v2_service.svc["signal-worker"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.tasks.member
}

resource "google_service_account_iam_member" "api_acts_as_tasks" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.svc["api"].member
}

resource "google_service_account_iam_member" "voice_relay_acts_as_tasks" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.svc["voice-relay"].member
}
