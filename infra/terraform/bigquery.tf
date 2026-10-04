resource "google_bigquery_dataset" "features_deid" {
  dataset_id    = "features_deid"
  friendly_name = "非識別化した日次特徴・ベースライン・異常"
  location      = var.region

  default_encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_bigquery_dataset" "eval" {
  dataset_id    = "eval"
  friendly_name = "評価セットと評価結果"
  location      = var.region

  default_encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_bigquery_dataset" "ops_metrics" {
  dataset_id    = "ops_metrics"
  friendly_name = "危機対応経路の所要時間の監視（子どもの ID を含まない）"
  location      = var.region

  default_encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_bigquery_table" "daily_features" {
  dataset_id          = google_bigquery_dataset.features_deid.dataset_id
  table_id            = "daily_features"
  schema              = file("${path.module}/bigquery/daily_features.json")
  clustering          = ["pseudo_id", "domain"]
  deletion_protection = true

  # データセットの既定 CMEK と同じ鍵を明示する。省略するとテーブルが鍵を継承し、次の plan で再作成を求められる
  encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  time_partitioning {
    type  = "DAY"
    field = "feature_date"
  }
}

resource "google_bigquery_table" "baselines" {
  dataset_id          = google_bigquery_dataset.features_deid.dataset_id
  table_id            = "baselines"
  schema              = file("${path.module}/bigquery/baselines.json")
  deletion_protection = true

  # データセットの既定 CMEK と同じ鍵を明示する。省略するとテーブルが鍵を継承し、次の plan で再作成を求められる
  encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  time_partitioning {
    type  = "DAY"
    field = "computed_at"
  }
}

resource "google_bigquery_table" "anomalies" {
  dataset_id          = google_bigquery_dataset.features_deid.dataset_id
  table_id            = "anomalies"
  schema              = file("${path.module}/bigquery/anomalies.json")
  clustering          = ["pseudo_id", "feature_name"]
  deletion_protection = true

  # データセットの既定 CMEK と同じ鍵を明示する。省略するとテーブルが鍵を継承し、次の plan で再作成を求められる
  encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  time_partitioning {
    type  = "DAY"
    field = "feature_date"
  }
}

resource "google_bigquery_table" "risk_levels_daily" {
  dataset_id          = google_bigquery_dataset.features_deid.dataset_id
  table_id            = "risk_levels_daily"
  schema              = file("${path.module}/bigquery/risk_levels_daily.json")
  clustering          = ["pseudo_id"]
  deletion_protection = true

  # データセットの既定 CMEK と同じ鍵を明示する。省略するとテーブルが鍵を継承し、次の plan で再作成を求められる
  encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  time_partitioning {
    type  = "DAY"
    field = "date"
  }
}

resource "google_bigquery_table" "labeled_items" {
  dataset_id          = google_bigquery_dataset.eval.dataset_id
  table_id            = "labeled_items"
  schema              = file("${path.module}/bigquery/labeled_items.json")
  deletion_protection = true

  # データセットの既定 CMEK と同じ鍵を明示する。省略するとテーブルが鍵を継承し、次の plan で再作成を求められる
  encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }
}

resource "google_bigquery_table" "runs" {
  dataset_id          = google_bigquery_dataset.eval.dataset_id
  table_id            = "runs"
  schema              = file("${path.module}/bigquery/runs.json")
  deletion_protection = true

  # データセットの既定 CMEK と同じ鍵を明示する。省略するとテーブルが鍵を継承し、次の plan で再作成を求められる
  encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  time_partitioning {
    type  = "DAY"
    field = "created_at"
  }
}

resource "google_bigquery_table" "notification_latency" {
  dataset_id          = google_bigquery_dataset.ops_metrics.dataset_id
  table_id            = "notification_latency"
  schema              = file("${path.module}/bigquery/notification_latency.json")
  deletion_protection = true

  # データセットの既定 CMEK と同じ鍵を明示する。省略するとテーブルが鍵を継承し、次の plan で再作成を求められる
  encryption_configuration {
    kms_key_name = google_kms_crypto_key.storage.id
  }

  time_partitioning {
    type  = "DAY"
    field = "detected_at"
  }
}
