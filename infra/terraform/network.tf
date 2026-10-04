# api と voice-relay は、内部トラフィックだけを受け付けるサービス（pet-agent、signal-worker）を呼び出す。
# Direct VPC egress ですべてのトラフィックを VPC に通し、サブネットの Private Google Access で run.app と Google API に到達する。
# これでリクエストは内部トラフィックとして扱われる。この 2 つのサービスは外部に出る必要がないため、Cloud NAT は作らない。
resource "google_compute_network" "main" {
  name                    = "${local.name_prefix}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "run_egress" {
  name                     = "${local.name_prefix}-run-egress"
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = "10.8.0.0/24"
  private_ip_google_access = true
}
