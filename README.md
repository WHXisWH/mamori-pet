# まもりペット

まもりペットは、日本の小学生・中学生に向けたデジタルペットの Web アプリ（PWA）です。子どもがペットに話しかけると、Google ADK で動く AI エージェントのペットが子どもの様子に寄り添い、必要なときには子どもを信頼できる大人につなぎます。ペットは子どもの話し相手であり味方であって、保護者のための監視ツールではありません。バックエンドは GCP の東京リージョン（asia-northeast1）で動かします。

## リポジトリ構成

```
apps/landing-web          紹介ページ（Next.js）
apps/child-web            子ども側 PWA（Next.js）
apps/guardian-web         保護者側 PWA（Next.js）
services/api              REST + SSE の API
services/pet-agent        ペット Agent（Google ADK）
services/voice-relay      リアルタイム音声の中継（WebSocket）
services/signal-worker    シグナル抽出と作品特徴抽出
services/risk-engine      リスクレベルの判定
services/notifier         通知文の作成と送信
services/calendar-sync    カレンダー連携
packages/api-types        フロントエンドとバックエンドで共有する API の型と列挙型
packages/agent-core       ペット Agent の定義（ツール、プロンプトの組み立て）
packages/crisis-detector  危機検知
packages/crypto           Cloud KMS によるエンベロープ暗号化と仮名ID
packages/kb-loader        ナレッジベースのバージョン別読み込みと検証
packages/config           設定値の一元管理
packages/service-kit      サービス共通の部品（ログ、エラー形式、ヘルスチェック）
packages/ui               デザインシステム（テーマ、キャラクター、基本コンポーネント、ルールカード）
kb/                       ナレッジベース（プロンプト、ルール、定型テンプレート、スキーマなど）
infra/                    GCP インフラ（Terraform）と、セキュリティルールなどのテスト
docs/                     設計ドキュメント
scripts/                  ローカル開発・検証用のスクリプト
```

## 前提条件

- Node.js 22
- pnpm 10

## ローカル開発

```bash
pnpm install
pnpm build          # すべてのパッケージをビルド
pnpm test           # テストを実行
pnpm lint           # ESLint と Prettier のチェック
pnpm typecheck      # 型チェック
pnpm format         # Prettier で整形
```

ローカルで一式を動かすときは、次のコマンドを使います。

```bash
pnpm build:local    # ローカル実行用にビルド
pnpm dev:local      # ローカル環境を起動
pnpm dev:manual     # 手動確認用のモードで起動
pnpm dev:reset      # ローカル環境の状態をリセット
```

ナレッジベースと E2E テストには、次のコマンドがあります。

```bash
pnpm kb:manifest    # ナレッジベースの manifest を生成
pnpm kb:check       # ナレッジベースの manifest を検証
pnpm test:e2e       # 子ども側 PWA の Playwright テスト
```

## 設計ドキュメント

設計ドキュメントは `docs/` にあります。

| ファイル                        | タイトル                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `docs/01-prd.md`                | 子ども向けいじめ対策デジタルペット AI Agent — プロダクト要求仕様書（PRD）v0.1 |
| `docs/02-agent-architecture.md` | いじめ対策デジタルペット — Agent アーキテクチャとワークフロー v0.1            |
| `docs/03-database.md`           | いじめ対策デジタルペット — データベース定義 v0.1                              |
| `docs/04-backend-api.md`        | いじめ対策デジタルペット — バックエンド API 定義 v0.1                         |
| `docs/05-frontend.md`           | いじめ対策デジタルペット — フロントエンド定義 v0.1                            |

全体のアーキテクチャ図は `docs/diagrams/architecture.html` にあります。
