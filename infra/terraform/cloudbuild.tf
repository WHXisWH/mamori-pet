resource "google_service_account" "cloudbuild" {
  account_id   = "sa-cloudbuild"
  display_name = "Cloud Build：イメージのビルド、Cloud Run のデプロイ、terraform plan"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "cloudbuild_roles" {
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/run.developer",
    "roles/logging.logWriter",
    "roles/storage.objectViewer",
    "roles/viewer",
  ])

  project = var.project_id
  role    = each.value
  member  = google_service_account.cloudbuild.member
}

resource "google_service_account_iam_member" "cloudbuild_acts_as_services" {
  for_each = local.services

  service_account_id = google_service_account.svc[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.cloudbuild.member
}

resource "google_cloudbuild_trigger" "main" {
  count = var.cloudbuild_repository == "" ? 0 : 1

  name            = "${local.name_prefix}-${var.environment}-push"
  location        = var.region
  service_account = google_service_account.cloudbuild.id
  filename        = "cloudbuild.yaml"

  repository_event_config {
    repository = var.cloudbuild_repository
    push {
      branch = var.cloudbuild_branch
    }
  }

  substitutions = {
    _REGION      = var.region
    _REPOSITORY  = google_artifact_registry_repository.images.repository_id
    _ENVIRONMENT = var.environment
  }
}
