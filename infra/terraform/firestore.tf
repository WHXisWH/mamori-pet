resource "google_firestore_database" "main" {
  provider = google-beta

  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "OPTIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  deletion_policy                   = "ABANDON"

  # CMEK はデータベース作成時にだけ指定でき、あとから変更できない。プロジェクトに Firestore CMEK のクォータがない場合は var.firestore_cmek_enabled を参照
  dynamic "cmek_config" {
    for_each = var.firestore_cmek_enabled ? [1] : []
    content {
      kms_key_name = google_kms_crypto_key.storage.id
    }
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.storage_key_service_agents,
  ]
}

resource "google_firestore_backup_schedule" "weekly" {
  provider = google-beta
  database = google_firestore_database.main.name

  retention = "${var.backup_retention_days * 24 * 60 * 60}s"

  weekly_recurrence {
    day = "SUNDAY"
  }
}

locals {
  ttl_fields = {
    messages          = "expireAt"
    sessions          = "expireAt"
    signals           = "expireAt"
    artworks          = "expireAt"
    islandScenes      = "expireAt"
    pairingCodes      = "expiresAt"
    invitations       = "expiresAt"
    invitationLookup  = "expiresAt"
    voiceTickets      = "expiresAt"
    toolUsage         = "expireAt"
    toolReceipts      = "expireAt"
    chatUsage         = "expireAt"
    toolBudgets       = "expireAt"
    memoryProposals   = "expiresAt"
    petRequests       = "expiresAt"
    pairingCodeLookup = "expiresAt"
    pairingAttempts   = "expiresAt"
    jobRuns           = "expiresAt"
  }

  # コレクショングループに対する単一フィールドの等価クエリ用（既定では単一コレクション向けの単一フィールドインデックスしか作られない）
  collection_group_fields = {
    children            = "childId"
    guardians           = "guardianId"
    calendarConnections = "status"
    devices             = "fcmToken"
  }
  # 同じコレクションに対する 2 つ目の家庭横断クエリ用フィールド（上の表はコレクションごとに 1 フィールドしか置けず、キー名を変えると既存のインデックスが作り直される）
  # children.status：api の自発ターン配信が status == active の子ども全員を検索する（services/api/src/routes/proactive.ts）
  collection_group_extra_fields = {
    "children.status" = { collection = "children", field = "status" }
  }
}

resource "google_firestore_field" "ttl" {
  provider = google-beta
  for_each = local.ttl_fields

  database   = google_firestore_database.main.name
  collection = each.key
  field      = each.value

  ttl_config {}

  index_config {}
}

resource "google_firestore_field" "collection_group" {
  provider = google-beta
  for_each = local.collection_group_fields

  database   = google_firestore_database.main.name
  collection = each.key
  field      = each.value

  index_config {
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION"
    }
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION_GROUP"
    }
  }
}

resource "google_firestore_index" "signals_domain_date" {
  database    = google_firestore_database.main.name
  collection  = "signals"
  query_scope = "COLLECTION"

  fields {
    field_path = "domain"
    order      = "ASCENDING"
  }
  fields {
    field_path = "localDate"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "risk_assessments_computed" {
  database    = google_firestore_database.main.name
  collection  = "riskAssessments"
  query_scope = "COLLECTION"

  fields {
    field_path = "trigger"
    order      = "ASCENDING"
  }
  fields {
    field_path = "computedAt"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "notifications_recipient_created" {
  database    = google_firestore_database.main.name
  collection  = "notifications"
  query_scope = "COLLECTION"

  fields {
    field_path   = "recipientIds"
    array_config = "CONTAINS"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "notifications_kind_status_created" {
  database    = google_firestore_database.main.name
  collection  = "notifications"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "kind"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "consultations_choice_followup" {
  database    = google_firestore_database.main.name
  collection  = "consultations"
  query_scope = "COLLECTION_GROUP"

  fields {
    field_path = "choice"
    order      = "ASCENDING"
  }
  fields {
    field_path = "followUpAt"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "context_events_child_start" {
  database    = google_firestore_database.main.name
  collection  = "contextEvents"
  query_scope = "COLLECTION"

  fields {
    field_path   = "childIds"
    array_config = "CONTAINS"
  }
  fields {
    field_path = "startDate"
    order      = "ASCENDING"
  }
}

# 日次のリスクレベル判定とペットのコンテキストは、まだ終わっていない状況（endDate >= ウィンドウの開始）だけを取る
resource "google_firestore_index" "context_events_child_end" {
  database    = google_firestore_database.main.name
  collection  = "contextEvents"
  query_scope = "COLLECTION"

  fields {
    field_path   = "childIds"
    array_config = "CONTAINS"
  }
  fields {
    field_path = "endDate"
    order      = "ASCENDING"
  }
}

resource "google_firebaserules_ruleset" "firestore" {
  provider = google-beta

  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/firestore.rules")
    }
  }

  depends_on = [google_firebase_project.main]
}

resource "google_firebaserules_release" "firestore" {
  provider = google-beta

  name         = "cloud.firestore"
  ruleset_name = google_firebaserules_ruleset.firestore.name

  lifecycle {
    replace_triggered_by = [google_firebaserules_ruleset.firestore]
  }
}

resource "google_firestore_index" "kb_chunks_vector" {
  provider    = google-beta
  database    = google_firestore_database.main.name
  collection  = "kbChunks"
  query_scope = "COLLECTION"
  api_scope   = "ANY_API"

  fields {
    field_path = "kbVersion"
    order      = "ASCENDING"
  }
  fields {
    field_path = "approved"
    order      = "ASCENDING"
  }
  # Firestore はベクトルフィールドの前に __name__ を自動で補う。明示しないと plan のたびにインデックスの再作成を求められる
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768
      flat {}
    }
  }
}

resource "google_firestore_index" "memories_vector" {
  count       = var.memory_vector_search ? 1 : 0
  provider    = google-beta
  database    = google_firestore_database.main.name
  collection  = "memories"
  query_scope = "COLLECTION"
  api_scope   = "ANY_API"

  fields {
    field_path = "characterId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "petId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "embeddingModel"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768
      flat {}
    }
  }
}

resource "google_firestore_field" "collection_group_extra" {
  provider = google-beta
  for_each = local.collection_group_extra_fields

  database   = google_firestore_database.main.name
  collection = each.value.collection
  field      = each.value.field

  index_config {
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION"
    }
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION_GROUP"
    }
  }
}
