resource "google_cloud_run_v2_service" "svc" {
  for_each = local.services

  name                = each.key
  location            = var.region
  ingress             = each.value.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false
  description         = each.value.description

  template {
    service_account                  = google_service_account.svc[each.key].email
    max_instance_request_concurrency = local.capacity[each.key].concurrency
    timeout                          = each.key == "voice-relay" ? "3600s" : "300s"

    dynamic "vpc_access" {
      for_each = contains(local.vpc_egress_services, each.key) ? [1] : []
      content {
        egress = "ALL_TRAFFIC"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.run_egress.id
        }
      }
    }

    scaling {
      min_instance_count = local.capacity[each.key].min_instances
      max_instance_count = local.capacity[each.key].max_instances
    }

    containers {
      image = var.image_tag == "" ? local.placeholder_image : "${local.image_base}/${each.key}:${var.image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = each.key != "voice-relay"
        limits = {
          cpu    = "1"
          memory = each.key == "pet-agent" || each.key == "voice-relay" ? "1Gi" : "512Mi"
        }
      }

      dynamic "env" {
        for_each = merge(local.common_env, {
          SERVICE_NAME = each.key
          WEB_ORIGINS  = "${var.child_web_origin},${var.guardian_web_origin}"
        }, local.service_env[each.key])
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = lookup(local.service_secret_env, each.key, {})
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 0
        period_seconds        = 3
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds = 30
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.service_roles,
    google_secret_manager_secret_iam_member.accessors,
    google_secret_manager_secret_version.secrets,
  ]

  lifecycle {
    ignore_changes = [client, client_version]
  }
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  for_each = { for k, v in local.services : k => v if v.public }

  name     = google_cloud_run_v2_service.svc[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "api_invokes_pet_agent" {
  name     = google_cloud_run_v2_service.svc["pet-agent"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.svc["api"].member
}

resource "google_cloud_run_v2_service_iam_member" "voice_relay_invokes_pet_agent" {
  name     = google_cloud_run_v2_service.svc["pet-agent"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.svc["voice-relay"].member
}

resource "google_cloud_run_v2_service_iam_member" "api_invokes_signal_worker" {
  name     = google_cloud_run_v2_service.svc["signal-worker"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.svc["api"].member
}

resource "google_cloud_run_v2_job" "jobs" {
  for_each = local.jobs

  name                = each.key
  location            = var.region
  deletion_protection = false

  template {
    task_count = each.value.task_count

    template {
      service_account = google_service_account.svc[each.value.service].email
      max_retries     = 1
      timeout         = "1800s"

      containers {
        image   = var.image_tag == "" ? local.placeholder_image : "${local.image_base}/${each.value.service}:${var.image_tag}"
        command = var.image_tag == "" ? null : ["node", "dist/job.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        dynamic "env" {
          for_each = merge(local.common_env, { SERVICE_NAME = each.value.service }, local.service_env[each.value.service])
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = lookup(local.service_secret_env, each.value.service, {})
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.secrets[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.service_roles,
    google_secret_manager_secret_iam_member.accessors,
    google_secret_manager_secret_version.secrets,
  ]

  lifecycle {
    ignore_changes = [client, client_version]
  }
}
