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

  # サービスごとのキャパシティ。パイロットのピークはテキスト 40 セッション、音声 10 セッション（packages/config の pilot）
  max_instances = var.service_max_instances > 0 ? var.service_max_instances : (var.environment == "prod" ? 20 : 3)
  crisis_path   = toset(["api", "notifier"])
  capacity = {
    for k in keys(local.services) : k => {
      concurrency   = k == "voice-relay" ? var.voice_relay_concurrency : var.service_concurrency
      min_instances = contains(local.crisis_path, k) ? var.crisis_path_min_instances : 0
      max_instances = local.max_instances
    }
  }

  jobs = {
    risk-engine-daily = {
      service    = "risk-engine"
      schedule   = "0 2 * * *"
      task_count = var.risk_daily_task_count
    }
    calendar-sync-daily = {
      service    = "calendar-sync"
      schedule   = "0 3 * * *"
      task_count = 1
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
    # 削除リクエストの外部データ（作品バケット、BigQuery の特徴）は risk-engine が消す：内部イングレスで BigQuery 権限も持つ
    "data.deletion_requested--risk-engine" = { topic = "data.deletion_requested", subscriber = "risk-engine", path = "/internal/events/data-deletion-requested" }
  }

  key_access = jsondecode(file("${path.module}/policy/key_access.json"))

  # Cloud Run の決定的な URL（https://<サービス名>-<プロジェクト番号>.<リージョン>.run.app）。サービス同士が参照し合っても依存の循環が起きない
  service_urls = {
    for k in keys(local.services) : k => "https://${k}-${data.google_project.current.number}.${var.region}.run.app"
  }
  api_public_url = var.api_public_url != "" ? var.api_public_url : local.service_urls["api"]
  voice_ws_url   = var.voice_ws_url != "" ? var.voice_ws_url : "${replace(local.service_urls["voice-relay"], "https://", "wss://")}/v1/voice"

  gmail_enabled = nonsensitive(var.gmail_sender_credentials != "")

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
      TASKS_INVOKER_SA    = google_service_account.tasks.email
      VOICE_WS_URL        = local.voice_ws_url
      ARTWORKS_BUCKET     = google_storage_bucket.artworks.name
      GUARDIAN_WEB_ORIGIN = var.guardian_web_origin
      # App Check の site key を設定したときだけ X-Firebase-AppCheck の検証を必須にする（2026-10-10 決定）
      APP_CHECK_REQUIRED = tostring(var.firebase_app_check_site_key != "")
      # 子どもの仮名ID（pseudoId）は pseudo 鍵の HMAC で作る。バージョン 1 に固定する（バージョンを変えると同じ子どもの仮名ID が変わるため）
      PSEUDO_KMS_KEY_VERSION = "${google_kms_crypto_key.pseudo.id}/cryptoKeyVersions/1"
    })
    voice-relay = {
      PET_AGENT_URL     = local.service_urls["pet-agent"]
      SIGNAL_WORKER_URL = local.service_urls["signal-worker"]
      TASKS_INVOKER_SA  = google_service_account.tasks.email
      CHILD_WEB_ORIGIN  = var.child_web_origin
      VOICE_MODEL_MODE  = "vertex"
    }
    # dev だけ、文献確認済み（専門家の署名なし）のナレッジベースを検索に使える。prod は専門家の署名が必須。
    pet-agent = merge(
      {
        PET_MODEL_MODE       = "vertex"
        MEMORY_VECTOR_SEARCH = tostring(var.memory_vector_search)
        CHILD_PUSH_ENABLED   = tostring(var.child_push_enabled)
        CHILD_WEB_ORIGIN     = var.child_web_origin
      },
      var.model_armor_template == "" ? {} : { MODEL_ARMOR_TEMPLATE = var.model_armor_template },
      var.environment == "dev" ? { KB_UNSIGNED_SEARCH = "literature_reviewed" } : {},
    )
    signal-worker = {}
    risk-engine = {
      NOTIFIER_URL     = local.service_urls["notifier"]
      TASKS_INVOKER_SA = google_service_account.tasks.email
      BIGQUERY_DATASET = google_bigquery_dataset.features_deid.dataset_id
      ARTWORKS_BUCKET  = google_storage_bucket.artworks.name
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
      {
        CALENDAR_OAUTH_STATE_SECRET = "calendar-oauth-state"
        PROACTIVE_DISPATCH_TOKEN    = "proactive-dispatch-token"
      },
      local.calendar_enabled ? { GOOGLE_OAUTH_CLIENT_SECRET = "google-oauth-client-secret" } : {},
    )
    calendar-sync = local.calendar_enabled ? { GOOGLE_OAUTH_CLIENT_SECRET = "google-oauth-client-secret" } : {}
    # 危機メール（MVP のデモ用に Gmail API を使う、2026-10-05 決定）。読めるのは notifier だけ
    notifier = local.gmail_enabled ? { GMAIL_CREDENTIALS = "gmail-sender-credentials" } : {}
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
