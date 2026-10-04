# infra/terraform

すべてのリソースを asia-northeast1 に置きます。GCP プロジェクトを作成したあと、次の手順で適用します。

```bash
cp terraform.tfvars.example terraform.tfvars   # プロジェクト ID とドメインを記入
cp backend.hcl.example backend.hcl             # Terraform の state 用バケットを記入
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

GCP の認証情報がない場合は、静的なチェックだけを実行できます。

```bash
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform test
```

`terraform test` は mock provider を使って次の点を確認します。鍵の権限マトリクス（risk-engine と notifier は content 鍵を使えない）、外部に公開するのは api と voice-relay だけであること、イベントのサブスクリプションとキュー、Direct VPC egress、Secret Manager のレプリカが東京だけにありシークレットごとに権限を付与していること、OAuth クライアントの有無によるカレンダー機能の切り替え。これとは別に、`infra/tests` が Terraform の push 先 URL とキュー名がサービスのコードと一致することを確認します。

サービス間の呼び出し：pet-agent や signal-worker などの内部サービスは内部トラフィックだけを受け付け、api と voice-relay は Direct VPC egress（`network.tf`。サブネットで Private Google Access を有効にしています）を通して呼び出します。サービスの URL には、Cloud Run の決定的な URL `https://<サービス名>-<プロジェクト番号>.asia-northeast1.run.app` を使います。

カレンダー：`google_oauth_client_id` が空のとき、api のカレンダー用エンドポイントは利用できず（エラーを返します）、カレンダー同期もスケジュールしません。有効にしたら、出力 `calendar_oauth_redirect_uri` の値を OAuth クライアントに登録します。クライアントシークレットは環境変数 `TF_VAR_google_oauth_client_secret` で渡し、apply 時に Secret Manager へ書き込みます。

初回の apply では、Cloud Run にプレースホルダーイメージをデプロイします（`image_tag` が空の状態）。Cloud Build がイメージをプッシュしたあと、`-var image_tag=<sha>` を付けてもう一度 apply します。

フロントエンド：`web.tf` は landing-web と同じ方式で、子ども側・保護者側の Cloud Run サービス（イメージタグは `web_image_tag`。`apps/*/cloudbuild.yaml` がプッシュします）、ロールを持たない実行用サービスアカウント、Firebase Hosting サイト（`hosting_site_ids`）を定義します。出力 `firebase_web_config` は、フロントエンドのビルドに必要な Firebase の設定です。
