# いじめ対策デジタルペット — データベース定義 v0.1

## 概要と設計原則

データは4か所に分けて保存します。Firestore はアプリケーションの状態、BigQuery は非識別化した分析データ、Cloud Storage は作品の原画とナレッジベースのファイル、Cloud KMS は鍵を管理します。すべて東京リージョン（asia-northeast1）に置きます。本書は「子ども向けいじめ対策デジタルペット AI Agent — プロダクト要求仕様書（PRD）v0.1」（docs/01-prd.md）に基づきます。

設計原則：

1. クライアントは Firestore に直接接続しません。読み書きはすべてバックエンド API を経由し、Firestore のセキュリティルールは既定ですべて拒否します。
2. 機微なテキストはフィールド単位で暗号化します。会話の原文、ペットの記憶、作品についての語りは、Cloud KMS のエンベロープ暗号化をかけて bytes として保存し、データ鍵は子どもごとに1本持ちます。
3. 分析には非識別化データだけを使います。BigQuery に入るデータは仮名ID（HMAC）だけを持ち、テキストの内容は一切含みません。
4. 保存しなくて済むものは保存しません。録音は保存しません。タイピングの挙動は回数と所要時間だけを保存します。自宅の位置は子どもの端末にだけ保存します。
5. 期限が来たら自動で削除します。保存期間は Firestore TTL と Cloud Storage のライフサイクルルールで適用します。
6. 時刻はすべて UTC で保存し、表示するときに日本時間へ変換します。

## ストレージの役割分担とコレクション構成

アプリケーションの状態はすべて Firestore に置き、ほかのストレージはそれぞれ1種類の用途を受け持ちます。

| ストレージ | 保存するもの | 選んだ理由 |
| --- | --- | --- |
| Firestore（Native モード） | アカウント、同意、ペット、会話、作品特徴、シグナル、リスク、通知 | ドキュメントモデルが「家庭—子ども」の階層に合う。TTL に対応している。レイテンシが低い |
| BigQuery | 非識別化した日次特徴量、ベースライン、異常検知の結果、評価データ | BigQuery ML でそのまま時系列の異常検知ができる |
| Cloud Storage | 作品の原画、ナレッジベースの Skill ファイル、評価セット、証拠のエクスポート | 大きなファイルに向いている。バージョン管理とライフサイクルルールに対応している |
| Cloud KMS | データ鍵を暗号化するための鍵（KEK） | CMEK とフィールド単位のエンベロープ暗号化を提供する |
| Secret Manager | サービス単位のシークレット（SMS 事業者の API キーなど） | シークレットをコードや設定に書かない |

> 図：Firestore のコレクションツリー

```mermaid
flowchart TD
  F["families/:familyId<br/>家庭"]
  CH["characters/:id<br/>キャラクターのマスターデータ"]
  HL["hotlines/:id<br/>相談窓口のマスターデータ"]
  F --> FL["家庭単位のサブコレクション<br/>guardians · devices · consents · invitations<br/>contextEvents · calendarConnections<br/>notifications · pairingCodes"]
  F --> C["children/:childId<br/>子ども。以下のサブコレクションは子どもごとに分離"]
  C --> G1["ペットと会話<br/>pets<br/>sessions / messages *<br/>sessions / voiceFeatures<br/>memories *"]
  C --> G2["表現と生活<br/>island（単一ドキュメント）*<br/>islandScenes *（スナップショット）<br/>artworks *<br/>petRequests<br/>dailyRituals<br/>moodCheckins<br/>homeCheckins"]
  C --> G3["シグナルとリスク<br/>signals<br/>riskAssessments · consultations<br/>crisisEvents *<br/>weeklyReports"]
```

保護者のデータは家庭の下に、子どものデータはそれぞれの children ドキュメントの下に置きます。こうしておくと、ある子どものデータを削除するときは、そのサブツリーを再帰的に削除するだけで済みます。ルートコレクションにはほかに config（ナレッジベースの有効バージョンなどの設定）と deletionRequests がありますが、図には描いていません。

## 列挙型の定義

以下の列挙型は Firestore、BigQuery、API で共通に使います。値はすべて英小文字です。

| 列挙型 | 値 | 説明 |
| --- | --- | --- |
| GradeBand | low / high / jhs | 小学校低学年、小学校高学年、中学生 |
| GuardianRole | primary / secondary | 主たる保護者、第二保護者 |
| CharacterId | moko / pokke / togemaru / nami / hoshi / hidden | 5種類のキャラクターとシークレットキャラクター |
| Channel | text / voice | 会話のチャネル |
| Domain | a / v / k / d / m / i / x | シグナル領域：会話、音声、タイピング、お絵かきと箱庭、気分、利用リズム、コンテキスト情報。Phase 2 で s（睡眠）、p（活動量）、t（スクリーンタイム）、l（位置情報の経路）を追加する |
| RiskLevel | l0 / l1 / l2 / l3 / l4 | リスクレベル |
| ArtworkType | drawing / story / island | ペットのお願いで描いた絵、おはなしリレーの絵、島のスナップショット。古いデータの self\_portrait は drawing として扱う |
| StoryOutcome | positive / compensated / negative / unclear | お話の結末：前向き、かろうじて前向き、後ろ向き、不明 |
| GameType | drawing / story / pet\_worry | ペットのお願い：絵を飾る、おはなしリレー、ペットのなやみ |
| CrisisCategory | self\_harm / violence / extortion / family\_harm / other | 危機のカテゴリ。family\_harm だけは保護者に通知しない |
| SignalScoring | score / observe | シグナルをリスク計算に使うかどうか。observe は記録するだけ |
| MoodWeather | sunny / cloudy / rainy / stormy | きもち天気 |
| ContextCategory | exam / long\_vacation / school\_event / sick / travel / class\_change / other | コンテキスト情報のカテゴリ |
| ConsultChoice | self / proxy / not\_now | 自分で話す、ペットに伝えてもらう、いまはやめておく |
| NotifyChannel | webpush / email / sms | 通知チャネル |
| NotifyStatus | queued / sent / delivered / acknowledged / failed | 通知の状態 |
| CrisisStatus | open / guardian\_acknowledged / closed | 危機イベントの状態 |
| DataSource | voice / typing / artwork\_save / home\_checkin / calendar | 子どもが個別にオフにできるデータソース |
| ConsentType | guardian\_terms / guardian\_sensitive / child\_assent | 保護者の規約同意、機微情報への同意、子ども本人の同意（アセント） |

## 家庭・アカウント・同意

1つの家庭には1〜2人の保護者と複数の子どもがいます。同意の記録は追記のみで、書き換えません。撤回するときは撤回時刻を書き込み、記録そのものは残します。

### families/:familyId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| familyId | string | はい | ドキュメント ID、UUID |
| primaryGuardianId | string | はい | 主たる保護者 |
| status | string | はい | active / deleting |
| termsVersion | string | はい | 現在同意している規約のバージョン |
| createdAt | timestamp | はい | 作成時刻 |

### families/:familyId/guardians/:guardianId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| guardianId | string | はい | Identity Platform の uid と同じ |
| role | GuardianRole | はい | 主たる保護者または第二保護者 |
| displayName | string | いいえ | 表示名 |
| email | string | はい | 通知の受信用 |
| phoneE164 | string | いいえ | L4 の SMS 用、E.164 形式 |
| notifyChannels | array\<NotifyChannel> | はい | 既定は webpush と email。L4 では sms も加える |
| verifiedAt | timestamp | はい | 検証可能な保護者の同意が完了した時刻 |
| createdAt | timestamp | はい | 作成時刻 |

### families/:familyId/children/:childId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| childId | string | はい | UUID。子どもの Identity Platform アカウントはカスタムクレームでこれに紐づく |
| nickname | string | はい | 子どものニックネーム。本名は保存しない |
| gradeBand | GradeBand | はい | 学年帯 |
| dataSources | map\<DataSource, boolean> | はい | データソースごとのオン・オフ。子ども自身が設定する |
| currentRiskLevel | RiskLevel | はい | リスクエンジンだけが書き込む |
| careFlag | boolean | はい | L1 の見守りフラグ。true のときペットは声かけを増やす |
| baselineReadyAt | timestamp | いいえ | コールドスタートが終わる時刻（28日目） |
| pseudoId | string | はい | HMAC による仮名ID。BigQuery ではこれだけを使う |
| wrappedDek | bytes | はい | KMS の鍵で暗号化した、この子どものデータ鍵 |
| deviceLockEnabled | boolean | はい | 端末を共用するときにペットの合言葉を有効にするかどうか |
| status | string | はい | active / paused / deleting |
| createdAt | timestamp | はい | 作成時刻 |

### families/:familyId/consents/:consentId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| type | ConsentType | はい | 同意の種類 |
| subjectChildId | string | いいえ | どの子どもに関する同意か |
| actorId | string | はい | 同意した人：保護者または子どもの uid |
| documentVersion | string | はい | 規約または説明文のバージョン |
| scope | map | いいえ | 同意したデータソースと用途 |
| verificationMethod | string | いいえ | 保護者の同意の検証方法。未定 |
| grantedAt | timestamp | はい | 同意した時刻 |
| revokedAt | timestamp | いいえ | 撤回した時刻。記録は削除しない |

### families/:familyId/devices/:deviceId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| ownerType | string | はい | guardian / child |
| ownerId | string | はい | 保護者または子どもの ID |
| fcmToken | string | はい | FCM Web Push のトークン |
| platform | string | いいえ | ios\_pwa / android / desktop |
| lastSeenAt | timestamp | はい | 最後に利用した時刻 |

### families/:familyId/pairingCodes/:code

子どもの端末用のペアリングコードです。保護者が発行し、1回だけ使えます。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| childId | string | はい | ペアリングする子ども |
| createdBy | string | はい | ペアリングコードを発行した保護者 |
| expiresAt | timestamp | はい | 10分後に失効する。TTL フィールドを兼ねる |
| usedAt | timestamp | いいえ | 使用した時刻 |

### families/:familyId/invitations/:invitationId

第二保護者の招待に使います。1回だけ使えます。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| email | string | はい | 招待される人のメールアドレス |
| invitedBy | string | はい | 招待を送った主たる保護者 |
| expiresAt | timestamp | はい | 7日後に失効する。TTL フィールドを兼ねる |
| acceptedAt | timestamp | いいえ | 承諾した時刻 |
| acceptedBy | string | いいえ | 承諾した人の uid |

### deletionRequests/:requestId（ルートコレクション）

削除リクエストはルートコレクションに置きます。こうすると、家庭のデータを削除したあとも削除の記録そのものは残り、あとから確認できます。ここには子どもに関する内容を一切保存しません。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| familyId | string | はい | 対象の家庭 |
| childId | string | いいえ | 空の場合は家庭全体の削除を表す |
| requestedBy | string | はい | リクエストした人の uid |
| requesterRole | string | はい | child / guardian |
| status | string | はい | accepted / running / completed / failed |
| requestedAt | timestamp | はい | リクエストした時刻 |
| completedAt | timestamp | いいえ | 完了した時刻 |

## ペット・会話・記憶

以下の children/:childId は families/:familyId/children/:childId の省略形です。会話はセッション（session）単位でまとめ、メッセージのテキストはすべて暗号化して保存します。音声は保存しません。音声中継サービスがメモリ上で特徴量を計算し、計算が終わりしだい音声を破棄します。

### characters/:characterId（マスターデータ）

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| characterId | CharacterId | はい | キャラクター ID |
| displayName | string | はい | キャラクター名。例：もこ |
| archetype | string | はい | モチーフ。例：くものひつじ |
| personaPromptRef | string | はい | 人格プロンプトのファイルの Cloud Storage 上のパスとバージョン |
| voiceName | string | はい | Live API のプリセット音声名 |
| palette | map | はい | メインカラーとサブカラー |
| hiddenVariants | array\<map> | いいえ | シークレットキャラクターのみ：バリエーション ID、見た目、性格 |
| active | boolean | はい | 公開中かどうか |

### children/:childId/pets/:petId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| characterId | CharacterId | はい | 選んだキャラクター |
| hiddenVariantId | string | いいえ | シークレットキャラクターのバリエーション |
| petName | string | いいえ | 子どもがペットにつけた名前 |
| active | boolean | はい | 現在のパートナーかどうか。パートナーを替えると前のペットは false になる |
| memoryCarriedFrom | string | いいえ | パートナーを替えたとき、どのペットから記憶を引き継いだか |
| growth | map | いいえ | 成長と着せ替えの状態（P1） |
| createdAt | timestamp | はい | 作成時刻 |

### children/:childId/sessions/:sessionId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| petId | string | はい | 会話したペット |
| channel | Channel | はい | テキストまたは音声 |
| startedAt | timestamp | はい | 開始時刻 |
| endedAt | timestamp | いいえ | 終了時刻 |
| localHour | number | はい | 開始時の日本時間の時（hour）。深夜の利用かどうかの判定に使う |
| turnCount | number | はい | 会話のターン数 |
| safeMode | boolean | はい | 危機時のセーフモードに入ったことがあるかどうか |
| expireAt | timestamp | はい | TTL フィールド |

### children/:childId/sessions/:sessionId/messages/:messageId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| role | string | はい | child / pet / system |
| contentEnc | bytes | はい | 暗号化したテキスト。音声メッセージは文字起こしを保存する |
| inputMode | string | はい | typed / voice\_transcript / quick\_reply |
| typing | map | いいえ | 子どもがタイピングしたメッセージのみ：keyCount、deleteCount、composeMs、longPauseCount |
| crisisCheck | map | いいえ | 子どものメッセージのみ：hit、method（keyword / model）、score、checkedAt |
| modelInfo | map | いいえ | ペットのメッセージのみ：モデル名、レイテンシ、プロンプトのバージョン |
| createdAt | timestamp | はい | 作成時刻 |
| expireAt | timestamp | はい | TTL フィールド。L3・L4 に関係し、同意を得たメッセージは延長する |

### children/:childId/sessions/:sessionId/voiceFeatures/:utteranceId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| messageId | string | はい | 対応する文字起こしメッセージ |
| durationMs | number | はい | この発話の長さ |
| speechRate | number | はい | 話速。1秒あたりのモーラ数 |
| pauseRatio | number | はい | 無音の割合 |
| pitchMeanHz | number | いいえ | 平均ピッチ |
| pitchStdHz | number | いいえ | ピッチの変動幅 |
| affectLabels | map | いいえ | モデルが出した感情ラベルと信頼度 |
| createdAt | timestamp | はい | 作成時刻 |

### children/:childId/memories/:memoryId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| contentEnc | bytes | はい | 暗号化した記憶の内容。同級生の名前は仮名に置き換えてある |
| category | string | はい | like / event / person / other |
| sourceMessageId | string | いいえ | どのメッセージから記録したか |
| createdAt | timestamp | はい | 作成時刻 |

子どもはすべての記憶を見ることも削除することもできます。削除は物理削除です。仮名の対応表は children/:childId/private/pseudonyms という1つのドキュメントに保存し、全体を暗号化します（mapEnc、bytes）。復号できるのはペット Agent サービスだけです。

## 表現作品と生活シグナル

お絵かきと箱庭は、保存するときに構造化した特徴へ変換します。リスクエンジンは特徴だけを読み、原画は読みません。サーバーには座標を一切保存しません。帰宅チェックインは「家にいるかどうか」だけを保存します。

### children/:childId/artworks/:artworkId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| type | ArtworkType | はい | drawing または story |
| requestId | string | いいえ | 対応するペットのお願い。子どもが自分から描いた絵にはない |
| promptId | string | いいえ | お話の書き出しの ID。story のみ |
| imageRef | string | いいえ | 原画の Cloud Storage 上のパス。子どもが保存を選んだときだけ持つ |
| narrativeEnc | bytes | いいえ | 暗号化した子どもの語り（テキストまたは音声の文字起こし） |
| features | map | はい | 構造化した特徴：selfSizeRatio、selfPosition、othersCount、nearestOtherDist、isolated、storyOutcome、explicitHarm |
| storyOutcomeSource | string | いいえ | storyOutcome の出どころ：option（子どもが決まった結末を選び、api がそのまま書き込む）または model（子どもが文字や声で語り、signal-worker のモデルが判定する）|
| featureModel | string | はい | 特徴抽出に使ったモデルとプロンプトのバージョン |
| sharedWithGuardian | boolean | はい | 子どもが自分から保護者に共有したかどうか |
| createdAt | timestamp | はい | 作成時刻 |
| expireAt | timestamp | いいえ | TTL フィールド |

### children/:childId/island/current

ペットの島はずっと残り続けます。1人の子どもが持つ現在のレイアウトは1つだけで（固定のドキュメント ID `current`）、変更のたびに全体を上書きします。パートナーを替えてもこのドキュメントは変わりません。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| sceneGraphEnc | bytes | はい | 暗号化した現在のシーングラフ：各アイテムの ID、カタログ ID、カテゴリ、座標、向き、重なり順 |
| selfFigureId | string | いいえ | 子どもが自分で指定した「これがわたし」。指定は必須ではない |
| decorations | array\<string> | はい | 小屋に飾ってある artworkId（子どもが保存して飾ることを選んだ絵だけ） |
| unlockedItems | array\<string> | はい | ペットのお願いを達成して手に入れたアイテムのカタログ ID |
| visitDays | number | はい | 訪れた日数。植物と小屋の成長段階を決める。連続日数では数えない |
| lastVisitDate | string | はい | 最後に訪れた日（日本時間の日付） |
| season | string | はい | 現在の季節テーマ。サーバー側で日付から計算する |
| goodThingCount | number | はい | いいことびんの星の累計数。回数だけを記録し、内容は記録しない |
| updatedAt | timestamp | はい | 最後に変更した時刻 |

### children/:childId/islandScenes/:sceneId

子どもが島を変更するたびにスナップショットを1つ保存し、特徴抽出と時系列での比較に使います。箱庭は画像ではなくシーングラフとして保存するので、距離や孤立の度合いはモデルに頼らずそのまま計算できます。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| sceneGraphEnc | bytes | はい | 暗号化したシーングラフ：各アイテムの ID、カテゴリ、座標、向き、重なり順 |
| selfFigureId | string | いいえ | 子どもが指定した「自分を表す」フィギュア。指定がないときは、幾何特徴のうち「自分」に関する項目が null になる |
| previousSceneId | string | いいえ | 1つ前のスナップショット。追加・削除・移動の比較に使う |
| features | map | はい | selfToNearestDist、selfToCenterDist、enclosed、isolated、categoryCounts、addedCount、removedCount、movedCount、storyOutcome。storyOutcome 以外はすべて `scoring: observe` |
| narrativeEnc | bytes | いいえ | 暗号化した子どもの語り |
| createdAt | timestamp | はい | 作成時刻 |
| expireAt | timestamp | いいえ | TTL フィールド |

### children/:childId/petRequests/:requestId

「ペットのお願い」は、ペット Agent が suggest\_game で持ちかけます（自発ターンを含む）。週あたりの回数に上限があります。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| type | GameType | はい | drawing / story / pet\_worry |
| promptId | string | はい | ナレッジベースの games ディレクトリにあるお題の ID（お絵かきのお題、お話の書き出し、ペットのなやみ） |
| rewardItemId | string | はい | 達成後に島へ置くアイテムのカタログ ID。持ちかけた時点で決めておく |
| status | string | はい | offered / completed / declined / expired |
| sessionId | string | いいえ | お願いを持ちかけた会話セッション。自発ターンで持ちかけたときはない |
| resultRef | string | いいえ | 達成時に対応する artworkId または islandScenes のスナップショット ID。ペットのなやみでは子どもが選んだ選択肢の ID |
| offeredAt | timestamp | はい | 持ちかけた時刻 |
| completedAt | timestamp | いいえ | 達成した時刻 |
| declinedAt | timestamp | いいえ | 子どもが「いまはいい」を選んだ時刻 |
| expiresAt | timestamp | はい | 達成されなければ期限で終了する（推奨は7日、未定）。TTL フィールド |

### children/:childId/dailyRituals/:localDate

1日につき1ドキュメントです。「やったかどうか」だけを記録し、内容は記録しません。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| localDate | string | はい | 日本時間の日付。ドキュメント ID |
| morningMood | boolean | はい | 朝にきもち天気を選んだ |
| bodySticker | string | いいえ | 任意のからだスタンプ（sleepy / stomach / headache / fine など。専門家の確認待ち） |
| okaeri | boolean | はい | 下校後にあいさつまたはチェックインをした |
| goodThing | boolean | はい | 寝る前にいいことびんへ星を入れた。内容は保存しない |
| watered | boolean | はい | 植物に水をあげた |
| updatedAt | timestamp | はい | 最後に更新した時刻 |

### children/:childId/moodCheckins/:checkinId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| weather | MoodWeather | はい | 今日のきもち天気 |
| localDate | string | はい | 日本時間の日付、YYYY-MM-DD |
| localHour | number | はい | 日本時間の時（hour） |
| createdAt | timestamp | はい | 作成時刻 |

### children/:childId/homeCheckins/:checkinId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| atHome | boolean | はい | 端末側で判定した結果 |
| method | string | はい | geo、または manual（子どもが位置情報をオフにしていて、手動で「おうちについたよ」を押した場合） |
| localDate | string | はい | 日本時間の日付 |
| checkinAt | timestamp | はい | チェックインした時刻 |

### families/:familyId/contextEvents/:eventId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| childIds | array\<string> | はい | 対象の子ども。複数指定できる |
| category | ContextCategory | はい | コンテキスト情報のカテゴリ |
| source | string | はい | calendar / manual |
| startDate | string | はい | YYYY-MM-DD |
| endDate | string | はい | YYYY-MM-DD |
| externalEventHash | string | いいえ | カレンダー予定のハッシュ。重複排除に使う。タイトルは保存しない |
| createdBy | string | はい | 作成者 |

カレンダーを同期するとき、予定のタイトルはカテゴリの判定のためにメモリ上でだけ使い、判定が終わりしだい破棄します。

### families/:familyId/calendarConnections/:guardianId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| calendarIds | array\<string> | はい | 保護者が同期対象に選んだカレンダー |
| refreshTokenEnc | bytes | はい | KMS で暗号化した OAuth リフレッシュトークン |
| scopes | array\<string> | はい | カレンダー予定の読み取り専用の権限だけを要求する |
| lastSyncAt | timestamp | いいえ | 前回同期した時刻 |
| status | string | はい | active / revoked / error |

## シグナル・リスク・通知

シグナルはすべて元のドキュメントを参照します。リスク評価と通知は「どの領域が、何日続いているか」だけを保存し、会話の原文は保存しません。

### children/:childId/signals/:signalId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| domain | Domain | はい | シグナル領域 |
| signalDefId | string | はい | ナレッジベースのシグナル番号。例：A-EXCL-003 |
| value | number | はい | シグナルの強さ、0–1 |
| explicit | boolean | はい | 子どもの明確な発言かどうか。L3 のルールで使う |
| sourceRef | string | はい | 元のドキュメントのパス：メッセージ、作品、チェックインなど |
| kbVersion | string | はい | ナレッジベースのバージョン |
| extractedBy | string | はい | 抽出に使ったモデルとプロンプトのバージョン、または rule |
| localDate | string | はい | 日本時間の日付 |
| createdAt | timestamp | はい | 作成時刻 |
| expireAt | timestamp | はい | TTL フィールド |

### children/:childId/riskAssessments/:assessmentId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| level | RiskLevel | はい | 今回の計算で出たレベル |
| previousLevel | RiskLevel | はい | 前回のレベル |
| trigger | string | はい | daily / event |
| domainsFlagged | array\<Domain> | はい | ベースラインから逸脱している領域 |
| persistenceDays | map | いいえ | 領域ごとの、逸脱が続いている日数 |
| anomalyRef | string | いいえ | BigQuery の異常検知結果への参照 |
| inColdStart | boolean | はい | コールドスタート期間中かどうか |
| rulesVersion | string | はい | リスクレベル分類ルールのバージョン |
| explanation | map | はい | 保護者への通知に使う根拠：どの領域が、何日続いているか。原文は含まない |
| computedAt | timestamp | はい | 計算した時刻 |

### children/:childId/consultations/:consultationId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| assessmentId | string | はい | どのリスク評価がきっかけになったか |
| level | RiskLevel | はい | l2 または l3 |
| source | string | いいえ | 誰が始めたか：risk-engine の評価（既定）または child（子どもが「ペットのなやみ」で「おとなに話す」を選んだ場合。assessmentId は child-request）|
| petRequestId | string | いいえ | source が child のときに対応するペットのお願い |
| offeredAt | timestamp | はい | ペットが最後に相談を持ちかけた時刻 |
| offerCount | number | はい | これまでに持ちかけた回数。L2 の再確認には回数の上限がある |
| choice | ConsultChoice | いいえ | 子どもの選択 |
| choiceAt | timestamp | いいえ | 選択した時刻 |
| summaryEnc | bytes | いいえ | 子どもが添えることに同意した一文の要約。暗号化する |
| childConfirmedSummary | boolean | いいえ | 子どもがこの要約を確認したかどうか |
| followUpAt | timestamp | いいえ | 子どもが「いまはやめておく」を選んだあと、次にやさしく尋ねる時刻 |
| notificationId | string | いいえ | 最終的に送った通知 |

### families/:familyId/notifications/:notificationId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| childId | string | はい | どの子どもについての通知か |
| recipientIds | array\<string> | はい | 受け取る保護者 |
| kind | string | はい | weekly\_report / care\_hint / content\_free\_alert / crisis |
| level | RiskLevel | はい | 対応するリスクレベル |
| templateId | string | はい | 通知テンプレートの ID とバージョン |
| payload | map | はい | 整形後の内容：タイトル、変化、提案、相談先、理由 |
| channels | array\<NotifyChannel> | はい | 送信チャネル |
| status | NotifyStatus | はい | 現在の状態 |
| attempts | array\<map> | はい | 送信ごとのチャネル、時刻、結果 |
| acknowledgedAt | timestamp | いいえ | 保護者が確認した時刻 |
| acknowledgedBy | string | いいえ | 確認した保護者 |
| createdAt | timestamp | はい | 作成時刻 |

### children/:childId/crisisEvents/:crisisId

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| triggerType | string | はい | text / voice / artwork / island |
| sourceRef | string | はい | きっかけになった元のドキュメント |
| detection | map | はい | キーワードの一致、モデルのスコア、再確認の結果 |
| category | CrisisCategory | はい | self\_harm / violence / extortion / family\_harm / other。危機検知器またはペットの危機ツールが決める。判定できないときは other |
| familyHarmSuspected | boolean | はい | category が family\_harm かどうかと同じ値。true のときは保護者に通知せず、それ以外のカテゴリはすべて通知する |
| notificationId | string | いいえ | 送った危機通知 |
| timeline | array\<map> | はい | 各ステップの動作と時刻：相談窓口の表示、子どもへの説明、通知、再送、確認 |
| status | CrisisStatus | はい | 現在の状態 |
| detailEnc | bytes | いいえ | 暗号化した関連部分。同意を得たときだけ保存する |
| createdAt | timestamp | はい | 作成時刻 |

### children/:childId/weeklyReports/:weekId

weekId には ISO 週を使います。例：2026-W40。

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| weekStart | string | はい | 月曜日の日付 |
| vitality | map | はい | 元気度の傾向：気分の分布、利用した日数、深夜に利用した日数 |
| summaryText | string | はい | 一文の解説。テンプレートから生成し、原文は含まない |
| generatedAt | timestamp | はい | 生成した時刻 |
| viewedAt | timestamp | いいえ | 保護者が見た時刻 |

## BigQuery と Cloud Storage

BigQuery が受け取るのは非識別化した数値の特徴量だけで、シグナルサービスが毎日 Storage Write API で書き込みます。データセットとバケットはすべて asia-northeast1 に置き、CMEK を使います。

### データセット features\_deid

| テーブル | 主な列 | パーティションとクラスタリング | 用途 |
| --- | --- | --- | --- |
| daily\_features | pseudo\_id、feature\_date、domain、feature\_name、value、grade\_band、kb\_version | feature\_date でパーティション分割、pseudo\_id と domain でクラスタリング | 子どもごと・日ごと・特徴量ごとの数値 |
| baselines | pseudo\_id、feature\_name、day\_type（登校日 / 休日）、median、iqr、window\_days、computed\_at | computed\_at でパーティション分割 | 個人ベースライン |
| anomalies | pseudo\_id、feature\_name、feature\_date、is\_anomaly、anomaly\_probability、lower\_bound、upper\_bound、model\_version | feature\_date でパーティション分割 | ML.DETECT\_ANOMALIES の出力 |
| risk\_levels\_daily | pseudo\_id、date、level、domains\_flagged、rules\_version | date でパーティション分割 | 振り返りと評価に使うレベルの履歴 |

異常検知には ARIMA\_PLUS を使います。pseudo\_id と feature\_name の組を time\_series\_id\_col とし、子どもごと・特徴量ごとに1本の系列にします。特徴量名は領域の文字で始めます。例：a\_negative\_ratio、v\_speech\_rate、k\_delete\_ratio、d\_self\_isolation、m\_weather\_score、i\_late\_night\_sessions、i\_home\_checkin\_hour、x\_exam\_flag。

### データセット eval と ops\_metrics

| テーブル | 主な列 | 用途 |
| --- | --- | --- |
| eval.labeled\_items | item\_id、source（synthetic / pilot）、grade\_band、expert\_label、labeler、kb\_version | 専門家がラベル付けした評価セット |
| eval.runs | run\_id、kb\_version、rules\_version、model、metric、value、created\_at | リリース前に毎回実行する評価の結果 |
| ops\_metrics.notification\_latency | notification\_id、level、detected\_at、sent\_at、acknowledged\_at | 危機対応経路の所要時間の監視。子どもの ID は含まない |

### Cloud Storage バケット

すべてのバケットで、均一なバケットレベルのアクセスと公開アクセスの防止を有効にします。

| バケット | 内容 | ライフサイクル | アクセス方法 |
| --- | --- | --- | --- |
| {project}-artworks | 子どもが保存を選んだ作品の原画。パスは families/{f}/children/{c}/artworks/{id}.png | artworks.expireAt に合わせる | 読み書きできるのは API のサービスアカウントだけ。フロントエンドは5分間有効な署名付き URL で読み取る |
| {project}-kb | ナレッジベースの Skill ファイル、リスクレベル分類ルール、人格プロンプト。バージョンごとにディレクトリを分ける | オブジェクトのバージョニングを有効にし、自動削除しない | Agent とリスクエンジンは読み取り専用 |
| {project}-eval | 評価セットの元データ | 手動で管理 | 評価パイプライン |
| {project}-exports | 証拠タイムラインのエクスポートファイル | 7日後に削除 | 15分間有効な署名付き URL |

## ナレッジベースとルールの保存

ナレッジベースはファイルとして {project}-kb バケットに置きます。バージョンごとに1つのディレクトリを作り、専門家の承認署名を得てから公開します。現在有効なバージョンは Firestore の config/kb ドキュメントに記録します（activeVersion、releasedAt、approvedBy）。

| パス（kb/v{バージョン}/ 配下） | 内容 | 読み取る側 |
| --- | --- | --- |
| signals/\*.yaml | シグナル定義。フィールドは PRD の「モジュール1：ナレッジベース（Skill）とリスクレベル分類」の定義に合わせる | シグナルサービス |
| lexicon/ja.yaml | 日本語表現の語彙表：カテゴリ、表現例、扱い方 | 危機検知、シグナルサービス |
| rules/risk\_rules.yaml | リスクレベル分類ルール、コールドスタートの日数、継続日数、重みの低い領域 | リスクエンジン |
| skills/\*.md | ペット Agent 向けの会話ガイド。たとえば子どもの打ち明け話への応じ方 | ペット Agent。公開時にチャンクに分割し、ベクトルを生成して Firestore の kbChunks に書き込み、ベクトル検索で取り出す |
| prompts/charter.md、prompts/persona/*.md、prompts/grade/*.md | まもりの憲章、キャラクターの人格、学年帯への適応 | ペット Agent、音声中継 |
| templates/notifications/\*.ja.md | 保護者向け通知のテンプレート | 通知文の作成 Agent |
| games/story\_prompts.yaml、games/island\_items.yaml | お話の書き出し、箱庭アイテムのカタログとそのカテゴリ | フロントエンド、シグナルサービス |
| manifest.json | バージョン番号、承認者、各ファイルのチェックサム、公開時刻 | すべてのサービスが起動時に検証する |

ベクトル検索の対象になるのは skills/\*.md だけです（ルートコレクション kbChunks：kbVersion、skillId、chunkIndex、text、embedding、approved。バージョン単位でまるごと入れ替える）。ルールファイルはリスクエンジンが直接読み込み、検索を経由しません。これにより、計算結果を毎回再現できます。kbChunks は `scripts/kb-publish.mjs` で公開します。まず kb:check と `review/*.yaml` の専門家の承認署名を確認します（署名が全ファイルを対象とし、manifest_hash が一致している必要があります。そうでない場合は、本番以外の環境に限り `--allow-draft` を付けて approved=false で書き込めます）。次に skills をチャンクに分割し、Vertex AI（東京）の text-embedding でベクトルを生成して kbChunks に書き込みます（新しいバージョンを書き込んでから古いバージョンを削除します）。最後にバージョンのディレクトリ全体を {project}-kb/{version}/ にアップロードします。

シグナル定義の例：

```yaml
# signals/a-excl-003.yaml
signal_id: A-EXCL-003
domain: a
description: 子どもが仲間外れにされていると話す
examples_ja: ["ハブられた", "無視される", "既読スルーされる"]
grade_bands: [high, jhs]
explicit: true
evidence:
  source: 各県いじめチェックリスト
  strength: medium
reviewed_by: 未定
```

リスクレベル分類ルールの例（抜粋。数値は PRD に従う）：

```yaml
# rules/risk_rules.yaml
cold_start_days: 28
low_weight_domains: [d, k]
levels:
  l1: { min_domains: 1, min_days: 7 }
  l2: { min_domains: 2, min_days: 7 }
  l3: { min_domains: 3, or_explicit_in: [a, d] }
  l4: { crisis_detector: true }
```

## アクセス制御・インデックス・保存期間・削除

サービスごとに専用のサービスアカウントを使い、必要な権限だけを与えます。リスクエンジンと通知サービスには復号の権限がなく、会話の原文には触れられません。

| サービスアカウント | アクセスできるもの | アクセスできないもの |
| --- | --- | --- |
| sa-api | Firestore の読み書き。artworks バケット。content 鍵による復号（子ども本人が閲覧をリクエストしたときだけ）と暗号化（子どもの作成時に新しいデータ鍵をラップするときだけ） | 仮名の対応表 |
| sa-pet-agent | sessions、messages、memories、仮名の対応表。content 鍵による暗号化と復号。Agent Platform、RAG Engine | 家庭単位の通知 |
| sa-voice-relay | messages と voiceFeatures への書き込み。Live API | 記憶、作品 |
| sa-signal-worker | メッセージと作品の読み取り（復号可）。signals への書き込み。BigQuery features\_deid への書き込み | 通知、保護者のデータ |
| sa-risk-engine | signals の読み取り。riskAssessments と consultations への書き込み。BigQuery の読み書き | 暗号化された内容すべて |
| sa-notifier | notifications の読み書き。保護者の連絡先の読み取り | 子どものデータの原文すべて |
| sa-calendar-sync | calendarConnections の読み取り（トークンを復号可）。contextEvents への書き込み | 子どものデータ |
| スタッフ | 既定ではデータへのアクセス権限がない。会話を見るには承認が必要で、Privileged Access Manager が一時的に権限を与え、監査ログを残す | — |

鍵（Cloud KMS）：content は会話、記憶、語り、シーングラフを暗号化します。tokens はカレンダーのトークンを暗号化します。pseudo は HMAC の仮名IDを生成します。storage は Firestore、BigQuery、Cloud Storage の CMEK として使います。すべての鍵を90日ごとにローテーションします。Firestore のセキュリティルールは、すべてのクライアントからの読み書きを一律に拒否します。

複合インデックス：

| コレクショングループ | フィールド | 用途 |
| --- | --- | --- |
| signals | domain 昇順、localDate 降順 | 領域ごとに直近のシグナルを取得する |
| riskAssessments | computedAt 降順 | 最新のレベルを取得する |
| notifications | recipientIds 配列に含む、createdAt 降順 | 保護者の通知一覧 |
| notifications | kind、status、createdAt | 未確認の危機通知を見つけて再送する |
| consultations | choice、followUpAt 昇順 | 期日が来て、もう一度尋ねる必要のある相談を見つける |
| contextEvents | childIds 配列に含む、startDate 昇順 | ある子どものコンテキスト情報を取得する |

保存期間：messages、sessions、signals、artworks、islandScenes、petRequests はそれぞれ expireAt または expiresAt フィールドを持ち、Firestore TTL が削除します。island/current と dailyRituals は子どものアカウントがある間は残り、子どもを削除するときに一緒に削除します。具体的な日数は未定です（PRD を参照）。pairingCodes は expiresAt を使い、10分後に削除します。データベースでは7日間のポイントインタイムリカバリ（PITR）を有効にし、これとは別に定期バックアップを取ります。バックアップの保存期間は未定です。

削除の流れ：

1. 子どもが会話または記憶を削除する：ただちに物理削除し、その会話から抽出したシグナルも同時に削除します。危機イベント記録は危機時のルールに従って残します。このことは事前に子どもへ伝えます。
2. 子どもまたは保護者がすべてのデータの削除をリクエストする：子どもの状態を deleting に変えてただちに利用を止めます。そのあと、Firestore のサブツリー、Cloud Storage のオブジェクト、BigQuery のその pseudoId の行を非同期で削除します。
3. ある同意を撤回する：対応するデータソースの収集をただちに止めます。既存のデータはリクエストに応じて削除します。
4. 子どもを削除するときは、その子どものデータ鍵も同時に破棄します。これで、バックアップに残った暗号化済みの内容は二度と復号できなくなります。
5. 家庭の退会：家庭のサブツリー全体を削除し、子ども一人ひとりに対して手順2と手順4を実行します。

## フィールド制約とサンプルドキュメント

制約はすべて API 層で検証し、書き込み層で列挙型をもう一度検証します。ID とタイムスタンプはすべてサーバーが生成します。クライアントから送られてくる clientSentAt は参考値としてだけ扱います。

| フィールド | 制約 |
| --- | --- |
| nickname | 1–20文字。URL や電話番号を含めない |
| petName | 0–10文字 |
| メッセージのテキスト | 1–500文字 |
| 作品についての語り | 0–500文字 |
| 作品の画像 | PNG、最大2MB、長辺は1024ピクセル以下 |
| 箱庭の items | 1–60個。x、y は0–1の範囲。selfFigureId は items に含まれていること |
| phoneE164 | E.164 に準拠し、日本の番号（+81）に限る |
| ドキュメント ID | サーバーが生成する UUID v7。時刻順に並ぶ |
| localDate | YYYY-MM-DD。日本時間で計算する |

サンプルドキュメント（bytes フィールドはプレースホルダーで表します。expireAt の日数は例であり、正式な値は未定です）：

```json
// families/f_8c2e/children/c_41a7
{
  "childId": "c_41a7",
  "nickname": "ゆい",
  "gradeBand": "high",
  "dataSources": { "voice": true, "typing": true, "artwork_save": false, "home_checkin": true, "calendar": true },
  "currentRiskLevel": "l0",
  "careFlag": false,
  "baselineReadyAt": "2026-10-26T00:00:00Z",
  "pseudoId": "p_9f3c2a71",
  "wrappedDek": "<bytes>",
  "deviceLockEnabled": false,
  "status": "active",
  "createdAt": "2026-09-28T09:00:00Z"
}
```

```json
// .../sessions/s_91/messages/m_301
{
  "role": "child",
  "contentEnc": "<bytes>",
  "inputMode": "typed",
  "typing": { "keyCount": 42, "deleteCount": 9, "composeMs": 38000, "longPauseCount": 2 },
  "crisisCheck": { "hit": false, "method": "keyword", "score": 0, "checkedAt": "2026-09-28T07:41:10Z" },
  "createdAt": "2026-09-28T07:41:10Z",
  "expireAt": "2026-12-27T07:41:10Z"
}
```

```json
// .../signals/sg_5521
{
  "domain": "a",
  "signalDefId": "A-EXCL-003",
  "value": 0.8,
  "explicit": true,
  "sourceRef": "families/f_8c2e/children/c_41a7/sessions/s_91/messages/m_301",
  "kbVersion": "1.0.0",
  "extractedBy": "gemini-flash@signal-extract-v3",
  "localDate": "2026-09-28",
  "createdAt": "2026-09-28T07:41:14Z",
  "expireAt": "2027-03-27T07:41:14Z"
}
```

```json
// .../riskAssessments/ra_880
{
  "level": "l3",
  "previousLevel": "l1",
  "trigger": "event",
  "domainsFlagged": ["a"],
  "persistenceDays": { "a": 1, "m": 6 },
  "inColdStart": false,
  "rulesVersion": "1.0.0",
  "explanation": { "domains": ["a", "m"], "days": 6, "explicit": true },
  "computedAt": "2026-09-28T07:41:20Z"
}
```

## 未決事項

- [ ] 各コレクションの保存日数：messages、signals、artworks、islandScenes など
- [ ] 保護者の同意の検証方法と、記録すべきフィールド
- [ ] バックアップの保存期間
- [ ] 削除リクエストの完了期限
- [ ] 音声中継サービスでの音声特徴の計算方法。たとえばピッチと話速をどのライブラリで計算するか
- [ ] Phase 3 の学校連携に向けたフィールド（schoolId など）をいまのうちに用意しておくかどうか
- [ ] 使用する Gemini モデルと Live API の、東京リージョンでのデータレジデンシーの確認
