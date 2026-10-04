export type PendingStatus = 'pending' | 'suggested' | 'decided';

export type PendingDecision = {
  key: string;
  source: string;
  status: PendingStatus;
  note: string;
};

export const PENDING_DECISIONS: readonly PendingDecision[] = [
  // 保存期間（docs/01-prd.md モジュール4 のデータ一覧、docs/03-database.md の保存期間）
  {
    key: 'retention.messagesDays',
    source:
      'docs/03-database.md「アクセス制御・インデックス・保存期間・削除」、docs/01-prd.md「モジュール4：データ収集とプライバシー保護」',
    status: 'pending',
    note: '会話の原文をローリング保存する日数。サンプルドキュメントでは90日',
  },
  {
    key: 'retention.sessionsDays',
    source: 'docs/03-database.md「アクセス制御・インデックス・保存期間・削除」',
    status: 'pending',
    note: 'セッション記録の保存日数',
  },
  {
    key: 'retention.signalsDays',
    source: 'docs/03-database.md「アクセス制御・インデックス・保存期間・削除」',
    status: 'pending',
    note: 'シグナルの保存日数。サンプルドキュメントでは180日',
  },
  {
    key: 'retention.artworksDays',
    source:
      'docs/03-database.md「アクセス制御・インデックス・保存期間・削除」、docs/01-prd.md「モジュール4：データ収集とプライバシー保護」',
    status: 'pending',
    note: '作品の原画像と特徴の保存日数',
  },
  {
    key: 'retention.islandScenesDays',
    source: 'docs/03-database.md「アクセス制御・インデックス・保存期間・削除」',
    status: 'pending',
    note: '箱庭のシーン画像の保存日数',
  },
  {
    key: 'retention.crisisEventsDays',
    source:
      'docs/01-prd.md「モジュール4：データ収集とプライバシー保護」データ一覧の危機イベント記録',
    status: 'pending',
    note: '危機イベント記録の保存日数。同意が必要',
  },
  {
    key: 'retention.backupDays',
    source: 'docs/03-database.md「未決事項」バックアップの保存期間',
    status: 'pending',
    note: '定期バックアップの保存日数',
  },
  {
    key: 'retention.deletionRequestSlaHours',
    source: 'docs/03-database.md「未決事項」削除リクエストの完了期限',
    status: 'pending',
    note: '削除リクエストを受け付けてから完了するまでの期限',
  },

  // 危機対応経路（docs/01-prd.md モジュール3 の L4 危機フロー、docs/04-backend-api.md の危機対応経路とエラーコード）
  {
    key: 'crisis.guardianAckTimeoutMinutes',
    source:
      'docs/01-prd.md「モジュール3：インタラクション設計とアラートフロー」L4 危機フローの手順4、docs/04-backend-api.md「危機対応経路とエラーコード」手順5',
    status: 'pending',
    note: '保護者が未確認のときの再送間隔。同時に第二保護者にも通知する',
  },
  {
    key: 'crisis.resendIntervalMinutes',
    source: 'docs/04-backend-api.md「未決事項」危機通知が未確認のときの再送間隔',
    status: 'pending',
    note: '初回の再送より後の、各回の再送間隔',
  },
  {
    key: 'crisis.maxResendRounds',
    source: 'docs/04-backend-api.md「未決事項」危機通知が未確認のときの再送間隔',
    status: 'pending',
    note: '再送回数の上限。上限に達したら再送を止めてアラートを出す',
  },
  {
    key: 'crisis.reviewTimeoutMs',
    source:
      'docs/02-agent-architecture.md「危機検知器」、docs/04-backend-api.md「危機対応経路とエラーコード」手順1',
    status: 'suggested',
    note: 'Pro による再判定の制限時間。推奨値は1.5秒。タイムアウト時は検知ありとして扱う',
  },
  {
    key: 'crisis.screenTimeoutMs',
    source: 'docs/02-agent-architecture.md「危機検知器」',
    status: 'suggested',
    note: 'Flash による意味スクリーニングの制限時間。推奨値は1秒。タイムアウト時は通過させる',
  },
  {
    key: 'crisis.keywordTimeoutMs',
    source: 'docs/02-agent-architecture.md「危機検知器」',
    status: 'suggested',
    note: 'キーワード層の制限時間。推奨値は10ミリ秒',
  },
  {
    key: 'crisis.notifyWithinSeconds',
    source: 'docs/01-prd.md「モジュール5：Agent アーキテクチャ」非機能要件',
    status: 'suggested',
    note: '危機を検知してから通知を送るまでの期限。推奨値は1分',
  },
  {
    key: 'crisis.recallThreshold',
    source: 'docs/02-agent-architecture.md「評価・リリース基準・オブザーバビリティ」',
    status: 'pending',
    note: '危機検知器の再現率のリリース基準。専門家が決める',
  },

  // 相談ステートマシン（docs/02-agent-architecture.md のリスクエンジンと相談ステートマシン）
  {
    key: 'consultation.l2FollowUpDays',
    source:
      'docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」、docs/01-prd.md「モジュール3：インタラクション設計とアラートフロー」',
    status: 'pending',
    note: 'L2 で子どもが保留を選んだあと、何日後にもう一度たずねるか',
  },
  {
    key: 'consultation.l2MaxOffers',
    source: 'docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」',
    status: 'pending',
    note: 'L2 でもう一度たずねる回数の上限',
  },
  {
    key: 'consultation.l3NoAnswerHours',
    source: 'docs/02-agent-architecture.md「リスクエンジンと相談ステートマシン」',
    status: 'pending',
    note: 'L3 で子どもが長時間答えないとき、内容を含まないお知らせを送るまでの待ち時間',
  },

  // ペット Agent（docs/02-agent-architecture.md の1ターンのループとモデルルーティング）
  {
    key: 'agent.maxToolCallsPerTurn',
    source: 'docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」',
    status: 'suggested',
    note: '1ターンのツール呼び出しは最大3回',
  },
  {
    key: 'agent.firstTokenTimeoutMs',
    source: 'docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」',
    status: 'suggested',
    note: '最初の文字が3秒を超えたら安全な定型応答に切り替える。PRD の非機能要件の目標は2秒',
  },
  {
    key: 'agent.turnTimeoutMs',
    source: 'docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」',
    status: 'suggested',
    note: '1ターン全体で20秒',
  },
  {
    key: 'agent.contextStatusChars',
    source:
      'docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」コンテキストの組み立て',
    status: 'suggested',
    note: '現在の状況は約300字',
  },
  {
    key: 'agent.contextMemories',
    source:
      'docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」コンテキストの組み立て',
    status: 'suggested',
    note: '記憶は最大5件',
  },
  {
    key: 'agent.contextHistoryTurns',
    source:
      'docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」コンテキストの組み立て、「モデルルーティング・タイムアウト・フォールバック」コスト',
    status: 'suggested',
    note: 'このセッションの履歴は直近20ターン。それより前は要約に圧縮する',
  },
  {
    key: 'agent.replyMaxChars',
    source:
      'docs/02-agent-architecture.md「ペット Agent（テキスト）の1ターンのループ」出力フィルタールール',
    status: 'suggested',
    note: '1ターンの返答の上限。低学年60、高学年100、中学生150',
  },
  {
    key: 'agent.dailyTurnLimit',
    source:
      'docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」その他のルール',
    status: 'pending',
    note: '子ども1人あたりの1日の会話ターン数の上限',
  },
  {
    key: 'agent.suggestGameWeeklyLimit',
    source: 'docs/04-backend-api.md「未決事項」、docs/02-agent-architecture.md ツール表',
    status: 'pending',
    note: 'suggest_game の週あたりの回数上限',
  },
  {
    key: 'island.petRequestExpiresDays',
    source: 'docs/03-database.md petRequests.expiresAt',
    status: 'suggested',
    note: 'ペットのお願いが未完了のまま期限切れになるまでの日数。推奨値は7日',
  },
  {
    key: 'island.stageVisitDays',
    source: 'docs/05-frontend.md IslandScene、docs/03-database.md island/current.visitDays',
    status: 'pending',
    note: '島の成長段階に対応する来訪日数のしきい値',
  },
  {
    key: 'island.movedMinDist',
    source: 'docs/03-database.md islandScenes.features movedCount',
    status: 'pending',
    note: 'スナップショット比較でアイテムが動いたと判定する最小の相対移動量',
  },
  {
    key: 'island.ritualDateSlackDays',
    source: 'docs/04-backend-api.md POST /v1/child/rituals',
    status: 'pending',
    note: '毎日の小さな習慣の localDate とサーバー側の日本時間の日付との間で許容するずれの日数',
  },
  {
    key: 'island.recentPromptMemory',
    source:
      'docs/04-backend-api.md GET /v1/child/pet-requests、docs/02-agent-architecture.md ツール表 suggest_game',
    status: 'pending',
    note: 'suggest_game がお題を選ぶとき、直近に出したお題を何件まで除外するか',
  },
  {
    key: 'agent.signalBatchWindowMs',
    source:
      'docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」コスト',
    status: 'suggested',
    note: '同じセッションで30秒以内に続いたメッセージは、1回のシグナル抽出にまとめる',
  },

  // モデルルーティング（docs/02-agent-architecture.md のモデルルーティング・タイムアウト・フォールバック）
  {
    key: 'models.*',
    source:
      'docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」、docs/01-prd.md「モジュール5：Agent アーキテクチャ」',
    status: 'pending',
    note: '用途ごとに固定する具体的なモデルバージョン。Agent Platform の東京リージョンで利用できる一覧に従う。温度と制限時間は推奨値（会話は最初の文字3秒・1ターン全体20秒、音声接続5秒、スクリーニング1秒、再判定1.5秒、シグナル抽出20秒、作品特徴30秒、通知文の作成20秒）',
  },

  // 週次レポート（docs/02-agent-architecture.md の通知文の作成と週次レポート）
  {
    key: 'weeklyReport.*',
    source: 'docs/02-agent-architecture.md「通知文の作成と週次レポート」解説文のルール表',
    status: 'suggested',
    note: '利用日数が2日以下、雨・雷が3日以上、深夜が3日以上、晴れ・くもりが5日以上',
  },

  // レート制限とクォータ（docs/04-backend-api.md の共通規約）
  {
    key: 'rateLimit.*',
    source: 'docs/04-backend-api.md「サービス構成と共通規約」レート制限、「未決事項」',
    status: 'pending',
    note: '子ども単位と保護者単位それぞれのレート制限の数値',
  },
  {
    key: 'rateLimit.pubsubMaxDeliveryAttempts',
    source: 'docs/04-backend-api.md「内部イベントと Agent ツール」',
    status: 'pending',
    note: 'トピックごとの、デッドレターに送るまでのリトライ上限',
  },

  // フロントエンド（docs/05-frontend.md）
  {
    key: 'client.islandBedtimeStartHour',
    source: 'docs/05-frontend.md IslandScene おやすみ表示',
    status: 'pending',
    note: '島のホーム画面がおやすみ表示に切り替わる開始時刻（日本時間）',
  },
  {
    key: 'client.islandKeyStep',
    source: 'docs/05-frontend.md IslandSandbox キーボード操作',
    status: 'pending',
    note: '編集モードで矢印キーを1回押したときにアイテムが動く相対距離',
  },
  {
    key: 'evalFloors.crisisRecallVertex',
    source: 'docs/02-agent-architecture.md「評価・リリース基準・オブザーバビリティ」',
    status: 'pending',
    note: 'Cloud Build の評価基準。危機レッドチームセットを実モデルで実行したときの再現率の下限',
  },
  {
    key: 'evalFloors.artworkOutcomeScripted',
    source: 'docs/02-agent-architecture.md「評価・リリース基準・オブザーバビリティ」',
    status: 'pending',
    note: 'Cloud Build の評価基準。作品のお話セットをスクリプト判定したときの結果正解率の下限',
  },
  {
    key: 'client.homeGeofenceDefaultRadiusM',
    source: 'docs/05-frontend.md「未決事項」自宅範囲の既定半径',
    status: 'pending',
    note: '自宅範囲の既定半径。子どもの端末にだけ保存する',
  },
  {
    key: 'voice.reconnectWindowMs',
    source: 'docs/05-frontend.md VoiceButton、docs/04-backend-api.md「リアルタイム音声プロトコル」',
    status: 'decided',
    note: '切断から5秒以内なら再接続する',
  },

  // 信頼性の目標（docs/01-prd.md モジュール5 の非機能要件。推奨目標でレビュー待ち）
  {
    key: 'slo.firstTokenTargetMs',
    source: 'docs/01-prd.md「モジュール5：Agent アーキテクチャ」非機能要件',
    status: 'suggested',
    note: 'テキスト応答の最初の文字までの遅延目標は2秒',
  },
  {
    key: 'slo.chatAvailability',
    source: 'docs/01-prd.md「モジュール5：Agent アーキテクチャ」非機能要件',
    status: 'suggested',
    note: '会話の可用性は99.5%。危機対応経路にはより高い水準を求める',
  },
  {
    key: 'voice.transcriptTimeoutMs',
    source:
      'docs/04-backend-api.md「リアルタイム音声プロトコル」、docs/02-agent-architecture.md「音声モードのワークフロー」',
    status: 'pending',
    note: '子どもが話し終えても最終の文字起こしが届かないとき、保留したペットの音声を最大どれだけ待つか',
  },
  {
    key: 'voice.idleTimeoutMs',
    source: 'docs/04-backend-api.md「リアルタイム音声プロトコル」',
    status: 'pending',
    note: '音声セッションで誰も話さない状態がどれだけ続いたら終了するか',
  },
  {
    key: 'voice.toolCallTimeoutMs',
    source:
      'docs/04-backend-api.md「リアルタイム音声プロトコル」、docs/02-agent-architecture.md「音声モードのワークフロー」',
    status: 'suggested',
    note: '音声モードで pet-agent に転送したツール呼び出しを最大どれだけ待つか。タイムアウト時はモデルにエラー結果を返す',
  },
  {
    key: 'voice.vad',
    source: 'docs/02-agent-architecture.md「音声モードのワークフロー」',
    status: 'suggested',
    note: 'フレームのエネルギーで発話を区切るしきい値、発話末尾の無音時間、最短の発話長',
  },
  {
    key: 'voice.pitchRangeHz',
    source: 'docs/02-agent-architecture.md「音声モードのワークフロー」',
    status: 'suggested',
    note: '自己相関法で探索するピッチの範囲',
  },
  {
    key: 'calendar.syncPastDays',
    source: 'docs/03-database.md「表現作品と生活シグナル」calendarConnections',
    status: 'suggested',
    note: 'カレンダー同期でさかのぼる日数',
  },
  {
    key: 'calendar.syncFutureDays',
    source: 'docs/03-database.md「表現作品と生活シグナル」calendarConnections',
    status: 'suggested',
    note: 'カレンダー同期で先まで見る日数',
  },
  {
    key: 'calendar.oauthStateMinutes',
    source: 'docs/03-database.md「表現作品と生活シグナル」calendarConnections',
    status: 'suggested',
    note: 'カレンダー連携の認可で使う state 署名の有効期間',
  },
  {
    key: 'consent.reauthMaxAgeSeconds',
    source:
      'docs/04-backend-api.md「認証と権限」、docs/01-prd.md「モジュール4：データ収集とプライバシー保護」同意の仕組み',
    status: 'suggested',
    note: '保護者が同意に署名する前に必要な再ログインの有効時間。推奨値は10分',
  },
  {
    key: 'agent.dailyModelCheckLimit',
    source: 'docs/02-agent-architecture.md「モデルルーティング・タイムアウト・フォールバック」',
    status: 'suggested',
    note: '子ども1人あたりの1日のモデルによる危機スクリーニング回数の上限。超えたらキーワード検知だけを行う。推奨値は180（1日のターン数上限の3倍）',
  },
  {
    key: 'rateLimit.childModelRequestsPerMinute',
    source: 'docs/04-backend-api.md「サービス構成と共通規約」',
    status: 'suggested',
    note: 'モデル呼び出しを伴う子ども側リクエストの1分あたりの上限（インスタンスごと）。推奨値は20',
  },
  {
    key: 'limits.artworksPerDay',
    source: 'docs/04-backend-api.md「サービス構成と共通規約」',
    status: 'suggested',
    note: '子ども1人が1日に提出できる作品数。推奨値は20',
  },
  {
    key: 'limits.childrenPerFamily',
    source: 'docs/04-backend-api.md「認証と権限」',
    status: 'suggested',
    note: '1つの家庭に登録できる子どもの人数。推奨値は5',
  },
];
