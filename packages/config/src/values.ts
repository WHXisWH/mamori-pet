import type { GradeBand } from '@ijime/api-types';

export const REGION = 'asia-northeast1';
export const TIMEZONE = 'Asia/Tokyo';

export const retention = {
  // TODO(未定) docs/03-database.md「アクセス制御・インデックス・保存期間・削除」、docs/01-prd.md「モジュール4：データ収集とプライバシー保護」。サンプルドキュメントでは90日。
  messagesDays: 90,
  // TODO(未定) docs/03-database.md「アクセス制御・インデックス・保存期間・削除」
  sessionsDays: 90,
  // TODO(未定) docs/03-database.md「アクセス制御・インデックス・保存期間・削除」。サンプルドキュメントでは180日。
  signalsDays: 180,
  // TODO(未定) docs/03-database.md「アクセス制御・インデックス・保存期間・削除」
  artworksDays: 180,
  // TODO(未定) docs/03-database.md「アクセス制御・インデックス・保存期間・削除」
  islandScenesDays: 180,
  // TODO(未定) docs/01-prd.md「モジュール4：データ収集とプライバシー保護」危機イベント記録
  crisisEventsDays: 365,
  // TODO(未定) docs/03-database.md「未決事項」
  backupDays: 30,
  // TODO(未定) docs/03-database.md「未決事項」
  deletionRequestSlaHours: 72,
  pairingCodeMinutes: 10,
  invitationDays: 7,
  exportsDays: 7,
  pitrDays: 7,
  kmsRotationDays: 90,
  idempotencyKeyHours: 24,
} as const;

export const crisis = {
  // 保護者の確認からこの時間が経てば危機イベントは終了扱いにする（docs/04-backend-api.md「危機対応経路とエラーコード」手順6。2026-10-10 決定）
  autoCloseAfterAckHours: 24,
  // 家庭内危害のイベントは保護者に通知せず、子どもの代わりに確認する人もいない：検知からこの日数が経てば終了扱いにする（2026-10-10 決定）
  familyHarmAutoCloseDays: 7,
  // TODO(未定) docs/01-prd.md「モジュール3：インタラクション設計とアラートフロー」L4 の手順4、docs/04-backend-api.md「危機対応経路とエラーコード」手順5
  guardianAckTimeoutMinutes: 10,
  // TODO(未定) docs/04-backend-api.md「未決事項」危機通知が未確認のときの再送間隔
  resendIntervalMinutes: 10,
  // TODO(未定) docs/04-backend-api.md「未決事項」。上限に達したら再送を止めてアラートを出す
  maxResendRounds: 6,
  // TODO(推奨値) docs/02-agent-architecture.md「危機検知器」
  keywordTimeoutMs: 10,
  // TODO(推奨値) docs/02-agent-architecture.md「危機検知器」
  screenTimeoutMs: 8000,
  // TODO(推奨値) docs/02-agent-architecture.md「危機検知器」、docs/04-backend-api.md「危機対応経路とエラーコード」手順1
  reviewTimeoutMs: 15000,
  // TODO(推奨値) docs/01-prd.md「モジュール5：Agent アーキテクチャ」非機能要件
  notifyWithinSeconds: 60,
  // TODO(未定) docs/02-agent-architecture.md「評価・リリース基準・オブザーバビリティ」。専門家が決める
  recallThreshold: 0.95,
  reviewContextTurns: 3,
  // TODO(推奨値) docs/02-agent-architecture.md「危機検知器」モデルが利用できないときの処理 第1項：429 のあとバックオフして1回だけ再試行する
  quotaRetryDelayMs: 200,
  // TODO(推奨値) docs/02-agent-architecture.md「危機検知器」モデルが利用できないときの処理 第1項：バックオフに加えるランダムなゆらぎの上限
  quotaRetryJitterMs: 100,
  // TODO(未定) docs/02-agent-architecture.md「危機検知器」モデルが利用できないときの処理 第3項：サーキットブレーカーの集計ウィンドウ
  breakerWindowMs: 60_000,
  // TODO(未定) docs/02-agent-architecture.md「危機検知器」モデルが利用できないときの処理 第3項：ウィンドウ内で連続したクォータ関連エラーの回数
  breakerThreshold: 5,
  // TODO(未定) docs/02-agent-architecture.md「危機検知器」モデルが利用できないときの処理 第3項：サーキットブレーカーが開いている時間
  breakerOpenMs: 30_000,
  // TODO(未定) docs/02-agent-architecture.md「危機検知器」モデルが利用できないときの処理 第2項：保留した入力をどれくらい後に再審査するか
  recheckDelaySeconds: 60,
} as const;

export const consultation = {
  // TODO(未定) docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」
  l2FollowUpDays: 3,
  // TODO(未定) docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」
  l2MaxOffers: 3,
  // TODO(未定) docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」
  l3NoAnswerHours: 48,
  // TODO(未定) docs/03-database.md consultations.followUpRound：通常のフォローアップは3回答えたら止める（2026-10-07 決定）
  followUpMaxRounds: 3,
} as const;

export const risk = {
  coldStartDays: 28,
  baselineWindowDays: 28,
  dailyJobCron: '0 2 * * *',
  dailyJobTimezone: TIMEZONE,
  lateNightHour: 23,
} as const;

export const agent = {
  // TODO(推奨値) docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」
  maxToolCallsPerTurn: 3,
  // TODO(推奨値) docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」
  firstTokenTimeoutMs: 15000,
  // TODO(推奨値) docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」
  turnTimeoutMs: 30000,
  // TODO(推奨値) docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」コンテキストの組み立て
  contextStatusChars: 300,
  // TODO(推奨値) docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」コンテキストの組み立て
  contextMemories: 5,
  // TODO(推奨値) docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」コンテキストの組み立て
  contextHistoryTurns: 20,
  // TODO(推奨値) docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」出力フィルタールール
  replyMaxChars: { low: 60, high: 100, jhs: 150 } satisfies Record<GradeBand, number>,
  // TODO(未定) docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」その他のルール
  dailyTurnLimit: 60,
  // docs/02-agent-architecture.md「自発ターン（ペットから話しかける）」：子どもの会話回数の上限とは別枠
  proactiveDailyLimit: 3,
  // TODO(推奨値) タスクの復旧は、上限30秒の1ターンのモデル呼び出しより長く待たなければならない
  proactiveLeaseMs: 60000,
  // TODO(未定) 生成したホームの挨拶は短い期間だけ再表示できればよい
  proactiveRetentionDays: 7,
  // TODO(推奨値) docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」コンテキストの組み立て。従来の間隔を維持する
  summaryIntervalTurns: 6,
  summaryMaxMessages: 16,
  summaryTimeoutMs: 8000,
  summaryRetentionDays: 7,
  memoryPrivacyTimeoutMs: 8000,
  // TODO(推奨値) 追加の出力検査はターンの制限時間内に収める
  modelArmorTimeoutMs: 3000,
  // TODO(推奨値) 日常の声かけの送信で、完了済みの自発ターンをいつまでも待たせない
  childPushTimeoutMs: 5000,
  // TODO(推奨値) 子どもごとに暗号化して保存する仮名の対応表と、モデルによる抽出の規模の上限
  pseudonymMapLimit: 100,
  // TODO(未定) docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」コスト：子ども1人あたり1日に行うモデルの危機スクリーニング回数の上限。
  // 超えたらキーワード検知だけを行う
  dailyModelCheckLimit: 180,
  // TODO(未定) docs/04-backend-api.md「未決事項」
  suggestGameWeeklyLimit: 2,
  // TODO(推奨値) docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」コスト
  signalBatchWindowMs: 30000,
  signalExtractMaxRetries: 3,
  notificationWriterMaxRetries: 1,
  quickReplyOptions: { min: 2, max: 3 },
  searchSkillMaxPassages: 3,
  recallMaxMemories: 5,
} as const;

export type ModelPurpose =
  | 'petChat'
  | 'petVoice'
  | 'crisisScreen'
  | 'crisisReview'
  | 'signalExtract'
  | 'artworkFeature'
  | 'notificationWriter'
  | 'evalJudge';

export type ModelRoute = {
  temperature: number | undefined;
  timeoutMs: number | undefined;
  maxOutputTokens: number;
  gemini25ThinkingBudget: number;
  onFailure: string;
};

// TODO(未定) docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」、docs/01-prd.md「モジュール5：Agent アーキテクチャ」。
// モデルは Agent Platform の東京リージョンでその時点に利用できる一覧に従い、更新する前に評価基準を満たすこと。温度と制限時間は推奨値。
export const models: Record<ModelPurpose, ModelRoute> = {
  petChat: {
    temperature: 0.7,
    timeoutMs: agent.turnTimeoutMs,
    maxOutputTokens: 1024,
    gemini25ThinkingBudget: 0,
    onFailure: 'fixed_safe_reply',
  },
  petVoice: {
    temperature: undefined,
    timeoutMs: 5000,
    maxOutputTokens: 2048,
    gemini25ThinkingBudget: 1024,
    onFailure: 'fallback_to_text',
  },
  crisisScreen: {
    temperature: 0,
    timeoutMs: crisis.screenTimeoutMs,
    maxOutputTokens: 256,
    gemini25ThinkingBudget: 0,
    onFailure: 'independent_review',
  },
  crisisReview: {
    temperature: 0,
    timeoutMs: crisis.reviewTimeoutMs,
    maxOutputTokens: 2048,
    gemini25ThinkingBudget: 1024,
    onFailure: 'treat_as_hit',
  },
  signalExtract: {
    temperature: 0,
    timeoutMs: 20000,
    maxOutputTokens: 2048,
    gemini25ThinkingBudget: 1024,
    onFailure: 'retry_then_dead_letter',
  },
  artworkFeature: {
    temperature: 0,
    timeoutMs: 30000,
    maxOutputTokens: 2048,
    gemini25ThinkingBudget: 1024,
    onFailure: 'skip_artwork',
  },
  notificationWriter: {
    temperature: 0.3,
    timeoutMs: 20000,
    maxOutputTokens: 2048,
    gemini25ThinkingBudget: 1024,
    onFailure: 'static_template',
  },
  evalJudge: {
    temperature: 0,
    timeoutMs: 30000,
    maxOutputTokens: 2048,
    gemini25ThinkingBudget: 1024,
    onFailure: 'none',
  },
};

export const weeklyReport = {
  // TODO(推奨値) docs/02-agent-architecture.md「通知文の作成と週次レポート」
  lowActivityMaxDays: 2,
  // TODO(推奨値) docs/02-agent-architecture.md「通知文の作成と週次レポート」
  lowMoodMinDays: 3,
  // TODO(推奨値) docs/02-agent-architecture.md「通知文の作成と週次レポート」
  lateNightMinDays: 3,
  // TODO(推奨値) docs/02-agent-architecture.md「通知文の作成と週次レポート」
  stableMinDays: 5,
  maxSummarySentences: 2,
} as const;

export const rateLimit = {
  // TODO(未定) docs/04-backend-api.md「サービス構成と共通規約」
  childRequestsPerMinute: 60,
  // TODO(未定) docs/04-backend-api.md「サービス構成と共通規約」
  guardianRequestsPerMinute: 120,
  // TODO(未定) docs/04-backend-api.md「サービス構成と共通規約」モデル呼び出しを伴う子ども側リクエストの、インスタンスごとの1分あたりの上限
  childModelRequestsPerMinute: 20,
  // TODO(未定) docs/04-backend-api.md「内部イベントと Agent ツール」
  pubsubMaxDeliveryAttempts: 5,
  // TODO(推奨値) docs/04-backend-api.md「サービス構成と共通規約」匿名ペアリングの全体カウンターを何シャードに分けるか（合計の上限は childRequestsPerMinute のまま）
  pairingShards: 6,
} as const;

// 保護者の同意の確認（確認済みメールアドレス + 再ログイン + 明示的な宣言）
export const consent = {
  // TODO(未定) docs/04-backend-api.md「認証と権限」同意に署名する前の再ログインの有効時間（秒）
  reauthMaxAgeSeconds: 600,
} as const;

// ペットの島
export const island = {
  // TODO(未定) docs/03-database.md petRequests.expiresAt（推奨値は7日）
  petRequestExpiresDays: 7,
  // TODO(未定) docs/05-frontend.md IslandScene 成長段階は来訪日数で決まる。しきい値1つが1段階に対応する
  stageVisitDays: [0, 3, 7, 14, 30],
  // TODO(未定) docs/03-database.md islandScenes.features movedCount：移動量がこの相対距離を超えたら移動とみなす
  movedMinDist: 0.02,
  // TODO(未定) docs/04-backend-api.md POST /v1/child/rituals：localDate とサーバー側の日本時間の日付との間で許容するずれの日数
  ritualDateSlackDays: 1,
  // TODO(未定) docs/04-backend-api.md GET /v1/child/pet-requests：お題を選ぶとき、直近に出したお題を何件まで除外するか
  recentPromptMemory: 20,
} as const;

export const limits = {
  nickname: { min: 1, max: 20 },
  petName: { min: 0, max: 10 },
  messageText: { min: 1, max: 500 },
  narrativeText: { min: 0, max: 500 },
  // child-web の TellAdultFlow の要約入力欄の maxLength と同じ値にする
  summaryText: { min: 1, max: 120 },
  artworkImageMaxBytes: 2 * 1024 * 1024,
  artworkImageMaxEdgePx: 1024,
  islandItems: { min: 1, max: 60 },
  pageSize: { default: 20, max: 100 },
  pairingCodeDigits: 6,
  // TODO(未定) docs/04-backend-api.md「サービス構成と共通規約」子ども1人が1日に提出できる作品数（提出のたびにモデルを呼び出す）
  artworksPerDay: 20,
  // TODO(未定) docs/04-backend-api.md「認証と権限」1つの家庭に登録できる子どもの人数
  childrenPerFamily: 5,
  // TODO(推奨値) docs/04-backend-api.md「認証と権限」同じ家庭で同時に有効な第二保護者の招待数。乱発を防ぐ
  pendingInvitationsPerFamily: 3,
  voiceTicketSeconds: 60,
  signedUrlArtworkMinutes: 5,
  signedUrlExportMinutes: 15,
} as const;

export const calendar = {
  // TODO(未定) docs/03-database.md「表現作品と生活シグナル」calendarConnections 同期する期間（推奨値）
  syncPastDays: 7,
  syncFutureDays: 60,
  // TODO(未定) docs/03-database.md「表現作品と生活シグナル」calendarConnections 認可の state の有効期間（推奨値）
  oauthStateMinutes: 10,
} as const;

export const voice = {
  inputSampleRateHz: 16000,
  outputSampleRateHz: 24000,
  frameMs: 40,
  reconnectWindowMs: 5000,
  ticketTtlSeconds: 60,
  liveConnectTimeoutMs: 5000,
  // TODO(未定) docs/04-backend-api.md「リアルタイム音声プロトコル」最終の文字起こしが届かないときの待ち時間の上限
  transcriptTimeoutMs: 8000,
  // TODO(未定) docs/04-backend-api.md「リアルタイム音声プロトコル」無音が続いたときのタイムアウト
  idleTimeoutMs: 120000,
  // TODO(推奨値) docs/04-backend-api.md「リアルタイム音声プロトコル」pet-agent へのツール転送の制限時間
  toolCallTimeoutMs: 5000,
  // TODO(推奨値) docs/02-agent-architecture.md「音声モードのワークフロー」フレームのエネルギーで発話を区切る
  vad: { speechRmsDbfs: -45, endSilenceMs: 700, minUtteranceMs: 300 },
  // TODO(推奨値) docs/02-agent-architecture.md「音声モードのワークフロー」自己相関法のピッチ範囲
  pitchRangeHz: { min: 70, max: 500 },
  // TODO(未定) docs/04-backend-api.md「サービス構成と共通規約」レート制限：子ども1人あたりの1日（日本時間の日付）の音声分数の上限
  dailyMinutesPerChild: 30,
} as const;

export const client = {
  // TODO(未定) docs/05-frontend.md「未決事項」
  homeGeofenceDefaultRadiusM: 150,
  typingLongPauseMs: 3000,
  networkRetries: 2,
  baseFontPx: { low: 20, high: 18, jhs: 16 } satisfies Record<GradeBand, number>,
  touchTargetPx: { low: 56, high: 48, jhs: 44 } satisfies Record<GradeBand, number>,
  nightModeStartHour: 23,
  // TODO(未定) docs/05-frontend.md IslandScene おやすみ表示の開始時刻（日本時間）
  islandBedtimeStartHour: 19,
  // TODO(未定) docs/05-frontend.md IslandSandbox キーボードで1回動かすときの相対距離
  islandKeyStep: 0.02,
} as const;

export const evalFloors = {
  // TODO(未定) docs/02-agent-architecture.md「評価・リリース基準・オブザーバビリティ」：危機検知レッドチームセットを実際の Gemini で実行したときの再現率の下限
  crisisRecallVertex: 0.9,
  // TODO(未定) docs/02-agent-architecture.md「評価・リリース基準・オブザーバビリティ」：作品のお話セットをスクリプト判定したときの結果正解率の下限
  artworkOutcomeScripted: 0.8,
} as const;

export const slo = {
  // TODO(推奨値) docs/01-prd.md「モジュール5：Agent アーキテクチャ」非機能要件
  firstTokenTargetMs: 2000,
  // TODO(推奨値) docs/01-prd.md「モジュール5：Agent アーキテクチャ」非機能要件
  chatAvailability: 0.995,
} as const;

// パイロット段階の負荷・可用性・コストの目標（2026-10-03 決定）。
// infra/terraform の予算、アラートしきい値、容量の変数は同じ数値を使い、infra/tests で両者の一致を検証する
// TODO(未定) docs/01-prd.md「成功指標と検証計画」：パイロットの値。負荷試験のあと実測に合わせて見直す
export const pilot = {
  children: 500,
  dailyActiveChildren: 200,
  peakTextSessions: 40,
  peakVoiceSessions: 10,
  flashRequestsPerMinute: 300,
  proRequestsPerMinute: 60,
  firstTokenP50Ms: 2_500,
  firstTokenP95Ms: 6_000,
  crisisCheckP95Ms: 10_000,
  chatAvailability: 0.995,
  helpAvailability: 0.999,
  dailyJobMaxMinutes: 30,
  costPerChildMonthJpy: 150,
  monthlyBudgetJpy: 75_000,
  budgetAlertThresholds: [0.5, 0.9, 1.0],
  // 予算がこの割合に達したら音声を全体で停止する（Pub/Sub budget-alerts → notifier が opsFlags/voice を書く）
  voiceBreakerThreshold: 1.0,
} as const;

// バッチ処理のシャード分割。日次ジョブのシャード数は Cloud Run Job の task_count（Terraform の変数）
export const batch = {
  // TODO(推奨値) docs/02-agent-architecture.md「通知文の作成と週次レポート」：週次レポートをファンアウトするシャード数。1シャードにつき Cloud Task を1つ作る
  weeklyReportShards: 4,
  // 複数の task が BigQuery の同じパーティションを同時に書き換えると衝突する（同時 DML、テーブル更新頻度の上限）ため、指数バックオフで再試行する
  bigQueryWriteAttempts: 6,
  bigQueryRetryBaseMs: 1_000,
  // jobRuns は「最後のシャードが異常検知を実行する」調整にだけ使い、1週間保持したあと TTL で削除する
  jobRunTtlDays: 7,
} as const;

export const lifecycle = {
  // Cloud Run は SIGTERM から SIGKILL まで固定で10秒、延長はできない。早めに終了してこそ停止ログと終了コードを残せる
  shutdownGraceMs: 9_000,
} as const;

// リクエスト経路のオーバーヘッド対策。DEK はプロセスのメモリにだけ置く
export const dekCache = {
  // TODO(推奨値) docs/03-database.md「概要と設計原則」第2項（フィールド単位のエンベロープ暗号化）：アンラップ済みの DEK をプロセス内にどれくらい保持するか
  ttlMs: 10 * 60_000,
  // TODO(推奨値) docs/03-database.md「概要と設計原則」第2項（フィールド単位のエンベロープ暗号化）：1プロセスあたり何人分の子どもの DEK をキャッシュするか
  maxEntries: 2_000,
} as const;
