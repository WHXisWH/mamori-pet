variable "project_id" {
  description = "GCP プロジェクト ID（dev と prod でプロジェクトを分ける）"
  type        = string
}

variable "region" {
  description = "すべてのリソースを置くリージョン。データを国外に出さない"
  type        = string
  default     = "asia-northeast1"

  validation {
    condition     = var.region == "asia-northeast1"
    error_message = "すべての GCP リソースは asia-northeast1 に置く。"
  }
}

variable "environment" {
  description = "dev または prod"
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment は dev または prod のどちらかにする。"
  }
}

variable "image_tag" {
  description = "Cloud Run にデプロイするイメージタグ。空のときはプレースホルダーイメージをデプロイする"
  type        = string
  default     = ""
}

variable "child_web_origin" {
  description = "子ども側 PWA のオリジン。例: https://child.example.jp"
  type        = string
  default     = "http://localhost:3000"
}

variable "guardian_web_origin" {
  description = "保護者側 PWA のオリジン"
  type        = string
  default     = "http://localhost:3001"
}

variable "authorized_domains" {
  description = "Identity Platform で許可するドメイン"
  type        = list(string)
  default     = ["localhost"]
}

variable "google_oauth_client_id" {
  description = "保護者の Google ログインに使う OAuth クライアント ID。空のときは Google ログインを有効にしない"
  type        = string
  default     = ""
}

variable "google_oauth_client_secret" {
  description = "保護者の Google ログインに使う OAuth クライアントシークレット"
  type        = string
  default     = ""
  sensitive   = true
}

variable "cloudbuild_repository" {
  description = "Cloud Build 2nd-gen リポジトリのリソース名（projects/.../connections/.../repositories/...）。空のときはトリガーを作らない"
  type        = string
  default     = ""
}

variable "cloudbuild_branch" {
  description = "Cloud Build を起動するブランチの正規表現"
  type        = string
  default     = "^main$"
}

variable "organization_id" {
  description = "GCP 組織 ID。空のときは VPC Service Controls を設定しない（組織のないプロジェクトでは境界を作れないため）"
  type        = string
  default     = ""
}

variable "artworks_retention_days" {
  description = "TODO(未定) docs/03-database.md「アクセス制御・インデックス・保存期間・削除」：作品の元画像をバケットに保存する日数。artworks.expireAt と一致させる"
  type        = number
  default     = 180
}

variable "scheduler_paused" {
  description = "true のとき定期ジョブを一時停止する（dev 環境の初期段階）"
  type        = bool
  default     = true
}

variable "proactive_paused" {
  description = "true のときペットの自発ターン（声かけ）の 3 つの定期ジョブを一時停止する。scheduler_paused とは別に制御する"
  type        = bool
  default     = true
}

variable "proactive_dispatch_token" {
  description = "api の自発ターン配信エンドポイントが使う内部トークン（任意の上書き用）。空のときは Terraform が生成して Secret Manager に保存し、Cloud Scheduler と api が同じ値を使う"
  type        = string
  sensitive   = true
  default     = ""
}

variable "backup_retention_days" {
  description = "TODO(未定) docs/03-database.md「未決事項」：バックアップの保存期間"
  type        = number
  default     = 30
}

variable "pubsub_max_delivery_attempts" {
  description = "TODO(未定) docs/04-backend-api.md「内部イベントと Agent ツール」：各トピックでデッドレターに送るまでのリトライ上限"
  type        = number
  default     = 5
}

variable "api_public_url" {
  description = "api の公開 URL（カスタムドメイン）。空のときは Cloud Run の既定 URL を使う。カレンダー OAuth のコールバック URL はここから組み立てるため、OAuth クライアントに登録する"
  type        = string
  default     = ""
}

variable "voice_ws_url" {
  description = "子ども側が音声で接続する WebSocket の URL。空のときは voice-relay の Cloud Run 既定 URL を使う"
  type        = string
  default     = ""
}

variable "web_image_tag" {
  description = "子ども側・保護者側 Cloud Run のイメージタグ（apps/*/cloudbuild.yaml が ijime リポジトリにプッシュする）。空のときはプレースホルダーイメージをデプロイする"
  type        = string
  default     = ""
}

variable "hosting_site_ids" {
  description = "Firebase Hosting のサイト ID（推奨値）。サイト ID は全世界で一意のため、使用済みのときは名前を変え、apps/child-web と apps/guardian-web の firebase.json および *_web_origin も合わせて変更する"
  type = object({
    child    = string
    guardian = string
  })
  default = {
    child    = "mamori-child"
    guardian = "mamori-guardian"
  }
}

variable "fcm_vapid_key" {
  description = "FCM Web Push の VAPID 公開鍵。Firebase コンソールの「Cloud Messaging → Web Push certificates」で生成する。空のときはフロントエンドに渡さない"
  type        = string
  default     = ""
}

variable "child_push_enabled" {
  description = "子ども側への定型文 FCM 送信を有効にする。VAPID と端末の検証が済んでから有効にする。既定は無効"
  type        = bool
  default     = false
}

variable "memory_vector_search" {
  description = "承認済みの記憶を東京リージョンの Vertex/Firestore ベクトル検索で取り出す。ベクトルインデックスの準備が整ってから有効にする"
  type        = bool
  default     = false
}

variable "model_armor_template" {
  description = "既存の東京リージョンの Model Armor テンプレート。空のときは追加の出力チェックを行わない。データ所在地の要件を満たし、サニタイズのログ記録を無効にしていること"
  type        = string
  default     = ""

  validation {
    condition     = var.model_armor_template == "" || can(regex("^projects/[a-zA-Z0-9-]+/locations/asia-northeast1/templates/[a-zA-Z0-9_-]+$", var.model_armor_template))
    error_message = "Model Armor のテンプレートは東京リージョンのリソース名にする。"
  }
}

variable "firebase_app_check_site_key" {
  description = "Firebase App Check の reCAPTCHA Enterprise サイトキー。本番では必須。子ども側のビルド時に公開値として埋め込む"
  type        = string
  default     = ""
}

variable "gemini_models" {
  description = "用途ごとの Gemini モデル ID。環境変数 GEMINI_MODEL_* として渡す（キー名は packages/config/src/model.ts を参照）。東京リージョンで動作を確認できたバージョンだけを明示して指定し、latest は使わない。指定のない用途は呼び出し時にエラーになる。例: { PET_CHAT = \"gemini-3.5-flash\" }"
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for k, v in var.gemini_models :
      contains(["PET_CHAT", "PET_VOICE", "CRISIS_SCREEN", "CRISIS_REVIEW", "SIGNAL_EXTRACT", "ARTWORK_FEATURE", "NOTIFICATION_WRITER", "EVAL_JUDGE"], k)
      && can(regex("^gemini-[a-z0-9.-]+$", v)) && !strcontains(v, "latest")
    ])
    error_message = "gemini_models のキーは PET_CHAT などの用途名、値はバージョンを明示した gemini-*（latest を含まない）にする。"
  }
}

variable "firestore_cmek_enabled" {
  description = "Firestore データベースで CMEK（storage 鍵）を使うかどうか。Firestore の CMEK は事前に Google へクォータを申請する必要があり、承認前はデータベース作成が 429 で失敗する。その場合は false にして Google の既定の暗号化で作成する（会話や記憶などの機微なフィールドは、アプリケーション層の KMS エンベロープ暗号化で引き続き保護する）。作成後は変更できず、有効にするにはデータベースを作り直す"
  type        = bool
  default     = true
}

variable "billing_account_id" {
  description = "請求先アカウント ID（XXXXXX-XXXXXX-XXXXXX）。空のときは予算を作らない。Terraform の実行用 ID にはその請求先アカウントの Billing Account Costs Manager が必要（または予算はコンソールで手動で作り、通知だけを budget-alerts トピックへ送る）"
  type        = string
  default     = ""
}

variable "budget_amount_jpy" {
  description = "TODO(未定) docs/01-prd.md「成功指標と検証計画」：月予算（円）。packages/config の pilot.monthlyBudgetJpy と一致させる。請求先アカウントの通貨は JPY であること"
  type        = number
  default     = 75000
}

variable "budget_alert_thresholds" {
  description = "TODO(未定) docs/01-prd.md「成功指標と検証計画」：予算アラートの割合。packages/config の pilot.budgetAlertThresholds と一致させる。最後の段階（100%）で音声のサーキットブレーカーが作動する"
  type        = list(number)
  default     = [0.5, 0.9, 1.0]
}

variable "alert_notification_emails" {
  description = "運用アラート（予算、5xx、レイテンシ、デッドレター、危機対応経路）の送信先メールアドレス。空のときもアラートポリシーは作り、コンソールでだけ確認できる"
  type        = list(string)
  default     = []
}

variable "log_bucket_tokyo_enabled" {
  description = "true のとき東京のログバケットを新設し、本来 _Default バケットに入るログをそこへ送る（_Required バケットの監査ログは Google が固定の場所に保存し、変更できない）"
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "TODO(未定) docs/03-database.md「アクセス制御・インデックス・保存期間・削除」：東京のログバケットの保存日数"
  type        = number
  default     = 30
}

variable "crisis_path_min_instances" {
  description = "危機対応経路のサービス（api、notifier）の最小インスタンス数。コールドスタートで危機検知と通知が遅れないようにする"
  type        = number
  default     = 1
}

variable "service_concurrency" {
  description = "voice-relay 以外の各サービスの、1 インスタンスあたりの最大同時リクエスト数"
  type        = number
  default     = 80
}

variable "voice_relay_concurrency" {
  description = "voice-relay の 1 インスタンスが同時に受け持つ音声セッション数（1 セッションにつき WebSocket 1 本と Live API セッション 1 つを使う）"
  type        = number
  default     = 4
}

variable "service_max_instances" {
  description = "各サービスの最大インスタンス数。未指定（0）のときは prod 20、dev 3"
  type        = number
  default     = 0
}

variable "risk_daily_task_count" {
  description = "日次のリスクレベル判定ジョブの並列 task 数。各 task は子ども ID のハッシュで決まる 1 つの分割だけを処理する（CLOUD_RUN_TASK_INDEX / CLOUD_RUN_TASK_COUNT）。推奨値。負荷試験のあとに調整する"
  type        = number
  default     = 2

  validation {
    condition     = var.risk_daily_task_count >= 1 && var.risk_daily_task_count <= 20
    error_message = "risk_daily_task_count は 1 から 20 の範囲にする。"
  }
}

variable "gmail_sender_credentials" {
  description = "危機メールの送信用認証情報（JSON：clientId、clientSecret、refreshToken、sender）。TF_VAR_gmail_sender_credentials で渡し、ファイルには書かない。空のときはメールのチャネルを使えない（notifier は notify.channel_not_configured を記録する）。OAuth クライアントはこのプロジェクトに作り、送信アカウントで https://www.googleapis.com/auth/gmail.send を承認しておく"
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition = var.gmail_sender_credentials == "" || alltrue([
      for k in ["clientId", "clientSecret", "refreshToken", "sender"] :
      can(jsondecode(var.gmail_sender_credentials)[k])
    ])
    error_message = "gmail_sender_credentials は clientId、clientSecret、refreshToken、sender を含む JSON にする。"
  }
}
