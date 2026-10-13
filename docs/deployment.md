# GCP へのデプロイ

まもりペットを GCP プロジェクトにデプロイする手順です。資源は Terraform で作り、サービスのイメージは Cloud Build で構築します。すべての資源は asia-northeast1（東京）に置きます。Terraform の変数 `region` は東京以外を受け付けません。

## 全体の流れ

1. Terraform で資源を作る（Cloud Run はいったん仮のイメージで起動）
2. Cloud Build で7サービスのイメージを構築し、Terraform で切り替える
3. 子ども用・保護者用 PWA のイメージを構築し、Firebase Hosting を公開する
4. ナレッジベースを公開する
5. 動作を確認する

## 前提

- GCP プロジェクト（課金有効）と、オーナー権限のある実行者
- Firebase がそのプロジェクトで有効になっていること
- ローカルに Terraform 1.13、gcloud CLI、Firebase CLI、Node.js 22、pnpm 10、jq
- Terraform の状態を置く Cloud Storage バケット（東京）

以下のコマンドはリポジトリのルートで実行します。

```bash
export PROJECT_ID=<PROJECT_ID>
export PROJECT_NUMBER=<PROJECT_NUMBER>
export REGION=asia-northeast1
```

## 1. Terraform で資源を作る

```bash
cd infra/terraform
cp backend.hcl.example backend.hcl            # 状態バケットを書く
cp terraform.tfvars.example terraform.tfvars   # 下の項目を書く（このファイルはコミットしない）
```

`terraform.tfvars` の主な項目です。モデル ID は、東京リージョンで実際に呼べることを確かめたものだけを書きます。

```hcl
project_id          = "<PROJECT_ID>"
environment         = "dev"
child_web_origin    = "https://<子ども用の Hosting サイト>.web.app"
guardian_web_origin = "https://<保護者用の Hosting サイト>.web.app"
authorized_domains  = ["localhost", "<子ども用>.web.app", "<保護者用>.web.app"]
gemini_models = {
  PET_CHAT            = "gemini-3.5-flash"
  CRISIS_SCREEN       = "gemini-3.5-flash"
  CRISIS_REVIEW       = "gemini-2.5-pro"
  SIGNAL_EXTRACT      = "gemini-3.5-flash"
  ARTWORK_FEATURE     = "gemini-3.5-flash"
  NOTIFICATION_WRITER = "gemini-2.5-pro"
}
# 定時ジョブは既定で止めてある。動かすときに false にする
# scheduler_paused = false
# proactive_paused = false
```

```bash
terraform init -input=false -backend-config=backend.hcl
terraform fmt -check -recursive && terraform validate && terraform test
terraform import google_firebase_project.main $PROJECT_ID   # 既に Firebase プロジェクトの場合
terraform plan -input=false -out=tfplan
terraform apply -input=false tfplan
```

`terraform test` は、公開してよいサービス、KMS 鍵の権限の分離、デッドレター、東京以外の資源がないことなどをポリシーとして検査します。

作られる主な資源は、Cloud Run の7サービスと2ジョブ、Firestore（セキュリティルールは全拒否）、BigQuery のデータセット、Cloud Storage のバケット、Cloud KMS の鍵4本、Pub/Sub のトピックとデッドレター、Cloud Tasks のキュー、Cloud Scheduler、サービスアカウントと最小限の IAM、監視のアラートです。KMS の鍵には `prevent_destroy` を付けています。

よくある失敗：

- **API が無効だというエラー（403）**：API の有効化の反映待ちです。1〜2分待って `terraform apply` をやり直します。
- **既に存在するというエラー（409）**：コンソールで作った資源です。`terraform import` で取り込んでから apply します。
- **Hosting のサイト名が使えない**：サイト ID は世界で一意です。別の名前にして `hosting_site_ids`、`*_web_origin`、`authorized_domains`、`apps/*/firebase.json` を合わせて直します。

## 2. サービスのイメージを構築して切り替える

ルートの `cloudbuild.yaml` は、lint、ビルド、テスト（Firestore エミュレーターを含む）、評価、Terraform の検証を通ってから7つのイメージを構築します。手動で送るときはタグを渡します。

```bash
export IMAGE_TAG=$(git rev-parse --short HEAD)
gcloud builds submit . --region=$REGION --config=cloudbuild.yaml \
  --service-account=projects/$PROJECT_ID/serviceAccounts/sa-cloudbuild@$PROJECT_ID.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://$PROJECT_ID-cloudbuild-source/source \
  --substitutions=_IMAGE_TAG=$IMAGE_TAG

cd infra/terraform
terraform apply -input=false -var image_tag=$IMAGE_TAG
```

以後は `image_tag` を `terraform.tfvars` に書いておきます。テストが失敗したら、ローカルで `pnpm install && pnpm build && pnpm test` で再現して直します。デプロイのためにテストを飛ばすことはしません。

## 3. PWA を構築して公開する

子ども用・保護者用の PWA は、リクエストごとに CSP の nonce を作るため静的書き出しはせず、Cloud Run で動かして Firebase Hosting から書き換えます。`NEXT_PUBLIC_*` は構築時に埋め込むので、API のアドレスや Firebase の設定を変えたら作り直します。

```bash
cd infra/terraform
CHILD_KEY=$(terraform output -json firebase_web_config | jq -r '."child-web".api_key')
GUARDIAN_KEY=$(terraform output -json firebase_web_config | jq -r '."guardian-web".api_key')
cd ../..

for app in child-web:$CHILD_KEY guardian-web:$GUARDIAN_KEY; do
  gcloud builds submit . --region=$REGION --config=apps/${app%%:*}/cloudbuild.yaml \
    --service-account=projects/$PROJECT_ID/serviceAccounts/sa-cloudbuild@$PROJECT_ID.iam.gserviceaccount.com \
    --gcs-source-staging-dir=gs://$PROJECT_ID-cloudbuild-source/source \
    --substitutions=_IMAGE_TAG=$IMAGE_TAG,_FIREBASE_API_KEY=${app#*:}
done

cd infra/terraform
terraform apply -input=false -var image_tag=$IMAGE_TAG -var web_image_tag=$IMAGE_TAG
cd ../..
(cd apps/child-web && firebase deploy --only hosting:<子ども用サイト> --project $PROJECT_ID)
(cd apps/guardian-web && firebase deploy --only hosting:<保護者用サイト> --project $PROJECT_ID)
```

保護者のブラウザ通知を使うときは、Firebase Cloud Messaging の VAPID 公開鍵と、保護者用 Web アプリの `app_id`・`messaging_sender_id` を構築時の置換値（`_FIREBASE_VAPID_KEY`、`_FIREBASE_APP_ID`、`_FIREBASE_MESSAGING_SENDER_ID`）に加えます。

## 4. ナレッジベースを公開する

Firestore のベクトル索引が READY になってから、ナレッジベースを切り分けて公開します。

```bash
node scripts/kb-publish.mjs kb/v0.1.0 --project=$PROJECT_ID --environment=dev --allow-draft --dry-run
node scripts/kb-publish.mjs kb/v0.1.0 --project=$PROJECT_ID --environment=dev --allow-draft
```

専門家の署名がないナレッジベースは `--allow-draft` を付けたときだけ dev 環境に公開でき、検索に使えるのは文献確認済みのものに限ります。本番環境では署名がない限り検索結果を返しません。

## 5. 動作を確認する

```bash
# 公開サービスの準備状態（/healthz は Cloud Run の既定ドメインでは予約されているため /readyz を使う）
curl -s https://api-$PROJECT_NUMBER.$REGION.run.app/readyz

# 内部サービスは外から呼べないこと（403 か 404 になる）
for s in pet-agent signal-worker risk-engine notifier calendar-sync; do
  printf '%s ' $s; curl -s -o /dev/null -w '%{http_code}\n' https://$s-$PROJECT_NUMBER.$REGION.run.app/healthz
done

# 本物のモデルを使う疎通確認（合成データ）
pnpm smoke:google --vertex --case chat,tool,crisis-screen,crisis-review,signal,artwork
```

ログにはイベント名と ID、数値しか出ません。子どもの入力が出ていないことも、あわせて確認できます。

## 費用の目安

利用者がほとんどいない状態で、月4,000〜6,000円です。大半は危機経路の `api` と `notifier` を1インスタンスずつ常駐させる分で、ほかのサービスは使われていないときゼロまで縮みます。モデル呼び出しには子どもごとの上限と日次の予算があり、予算に達したら音声だけを全体で止めます。
