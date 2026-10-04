resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_jobs" {
  for_each = local.jobs

  name     = google_cloud_run_v2_job.jobs[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.scheduler.member
}

resource "google_cloud_scheduler_job" "jobs" {
  # OAuth クライアントがなければカレンダー連携は存在しないため、カレンダー同期はスケジュールしない
  for_each = { for k, v in local.jobs : k => v if v.service != "calendar-sync" || local.calendar_enabled }

  name             = each.key
  region           = var.region
  schedule         = each.value.schedule
  time_zone        = "Asia/Tokyo"
  attempt_deadline = "320s"
  paused           = var.scheduler_paused

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.jobs[each.key].name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_jobs]
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invokes_notifier" {
  name     = google_cloud_run_v2_service.svc["notifier"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.scheduler.member
}

# 週次レポート：毎週月曜の朝に前の週（月曜〜日曜、日本時間）を集計する。services/notifier/src/weekly.ts を参照
resource "google_cloud_scheduler_job" "weekly_report" {
  name             = "notifier-weekly-report"
  region           = var.region
  schedule         = "0 7 * * 1"
  time_zone        = "Asia/Tokyo"
  attempt_deadline = "320s"
  paused           = var.scheduler_paused

  retry_config {
    retry_count = 2
  }

  http_target {
    http_method = "POST"
    uri         = "${local.service_urls["notifier"]}/internal/jobs/weekly-report"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.service_urls["notifier"]
    }
  }

  depends_on = [google_cloud_run_v2_service_iam_member.scheduler_invokes_notifier]
}
