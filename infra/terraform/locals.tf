locals {
  name_prefix = "ijime"

  services = {
    api = {
      public      = true
      description = "REST API（応答前の危機検知と SSE を含む）"
    }
    voice-relay = {
      public      = true
      description = "音声 WebSocket の中継（Google ADK runLive + Live API）"
    }
    pet-agent = {
      public      = false
      description = "ペット Agent のテキストモード（Google ADK runAsync）"
    }
    signal-worker = {
      public      = false
      description = "シグナル抽出と作品特徴抽出"
    }
    risk-engine = {
      public      = false
      description = "リスクエンジンの内部サービス（イベントを受けてリスクレベルを判定）"
    }
    notifier = {
      public      = false
      description = "通知文の作成と送信"
    }
    calendar-sync = {
      public      = false
      description = "Google カレンダーの同期"
    }
  }

  jobs = {
    risk-engine-daily = {
      service  = "risk-engine"
      schedule = "0 2 * * *"
    }
    calendar-sync-daily = {
      service  = "calendar-sync"
      schedule = "0 3 * * *"
    }
  }

  pubsub_topics = [
    "message.created",
    "artwork.created",
    "checkin.created",
    "signal.extracted",
    "risk.level_changed",
    "crisis.detected",
    "consultation.resolved",
    "data.deletion_requested",
  ]

  pubsub_subscriptions = {
    "message.created--signal-worker"  = { topic = "message.created", subscriber = "signal-worker", path = "/internal/events/message-created" }
    "artwork.created--signal-worker"  = { topic = "artwork.created", subscriber = "signal-worker", path = "/internal/events/artwork-created" }
    "checkin.created--signal-worker"  = { topic = "checkin.created", subscriber = "signal-worker", path = "/internal/events/checkin-created" }
    "signal.extracted--risk-engine"   = { topic = "signal.extracted", subscriber = "risk-engine", path = "/internal/assess" }
    "crisis.detected--notifier"       = { topic = "crisis.detected", subscriber = "notifier", path = "/internal/events/crisis-detected" }
    "crisis.detected--risk-engine"    = { topic = "crisis.detected", subscriber = "risk-engine", path = "/internal/events/crisis-detected" }
    "consultation.resolved--notifier" = { topic = "consultation.resolved", subscriber = "notifier", path = "/internal/events/consultation-resolved" }
    "data.deletion_requested--api"    = { topic = "data.deletion_requested", subscriber = "api", path = "/internal/events/data-deletion-requested" }
  }

  key_access = jsondecode(file("${path.module}/policy/key_access.json"))

  # Cloud Run の決定的な URL（https://<サービス名>-<プロジェクト番号>.<リージョン>.run.app）。サービス同士が参照し合っても依存の循環が起きない
  service_urls = {
    for k in keys(local.services) : k => "https://${k}-${data.google_project.current.number}.${var.region}.run.app"
  }
  api_public_url = var.api_public_url != "" ? var.api_public_url : local.service_urls["api"]
  voice_ws_url   = var.voice_ws_url != "" ? var.voice_ws_url : "${replace(local.service_urls["voice-relay"], "https://", "wss://")}/v1/voice"

  calendar_enabled = var.google_oauth_client_id != ""
  calendar_env = local.calendar_enabled ? {
    GOOGLE_OAUTH_CLIENT_ID      = var.google_oauth_client_id
    CALENDAR_OAUTH_REDIRECT_URI = "${local.api_public_url}/v1/calendar/callback"
  } : {}

  # common_env 以外のサービスごとの環境変数（名前は services/*/src/runtime.ts と一致させる）
  service_env = {
    api = merge(local.calendar_env, {
      PET_AGENT_URL       = local.service_urls["pet-agent"]
      SIGNAL_WORKER_URL   = local.service_urls["signal-worker"]
      VOICE_WS_URL        = local.voice_ws_url
      ARTWORKS_BUCKET     = google_storage_bucket.artworks.name
      GUARDIAN_WEB_ORIGIN = var.guardian_web_origin
      # 子どもの仮名ID（pseudoId）は pseudo 鍵の HMAC で作る。バージョン 1 に固定する（バージョンを変えると同じ子どもの仮名ID が変わるため）
      PSEUDO_KMS_KEY_VERSION = "${google_kms_crypto_key.pseudo.id}/cryptoKeyVersions/1"
    })
    voice-relay = {
      PET_AGENT_URL    = local.service_urls["pet-agent"]
      CHILD_WEB_ORIGIN = var.child_web_origin
      VOICE_MODEL_MODE = "vertex"
    }
    pet-agent = {
      PET_MODEL_MODE = "vertex"
    }
    signal-worker = {}
    risk-engine = {
      NOTIFIER_URL     = local.service_urls["notifier"]
      TASKS_INVOKER_SA = google_service_account.tasks.email
      BIGQUERY_DATASET = google_bigquery_dataset.features_deid.dataset_id
    }
    notifier = {
      SELF_URL            = local.service_urls["notifier"]
      TASKS_INVOKER_SA    = google_service_account.tasks.email
      GUARDIAN_WEB_ORIGIN = var.guardian_web_origin
      BIGQUERY_DATASET    = google_bigquery_dataset.features_deid.dataset_id
    }
    calendar-sync = local.calendar_env
  }

  # Secret Manager から渡す環境変数：変数名 → secrets.tf のシークレット
  service_secret_env = {
    api = merge(
      { CALENDAR_OAUTH_STATE_SECRET = "calendar-oauth-state" },
      local.calendar_enabled ? { GOOGLE_OAUTH_CLIENT_SECRET = "google-oauth-client-secret" } : {},
    )
    calendar-sync = local.calendar_enabled ? { GOOGLE_OAUTH_CLIENT_SECRET = "google-oauth-client-secret" } : {}
  }

  # ほかの内部サービスを呼び出すサービスは Direct VPC egress を使う（内部サービスは内部トラフィックだけを受け付けるため）
  vpc_egress_services = toset(["api", "voice-relay"])

  common_env = merge({
    NODE_ENV                             = "production"
    GCP_PROJECT_ID                       = var.project_id
    GCP_REGION                           = var.region
    KMS_KEY_RING                         = google_kms_key_ring.main.name
    KB_BUCKET                            = google_storage_bucket.kb.name
    ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = "false"
  }, { for k, v in var.gemini_models : "GEMINI_MODEL_${k}" => v })
}
