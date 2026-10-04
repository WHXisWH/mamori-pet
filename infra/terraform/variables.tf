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
