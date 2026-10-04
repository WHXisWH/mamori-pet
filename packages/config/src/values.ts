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
} as const;

export const consultation = {
  // TODO(未定) docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」
  l2FollowUpDays: 3,
  // TODO(未定) docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」
  l2MaxOffers: 3,
  // TODO(未定) docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」
  l3NoAnswerHours: 48,
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
  firstTokenTimeoutMs: 8000,
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
