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
