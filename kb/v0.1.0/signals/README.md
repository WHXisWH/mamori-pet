# シグナル定義

DRAFT / 専門家未レビュー。シグナル1つにつき YAML ファイルを1つ置きます。フィールドは docs/01-prd.md モジュール1のシグナル項目の定義に合わせています。構造は `@ijime/kb-loader` の `signalDefinitionSchema` が、内容は `validateKnowledgeBase` が検証します（`pnpm kb:check` と `pnpm kb:manifest` のどちらでも実行されます）。`reviewed_by` はすべて未定で、正式に承認されたものとは見なせません。

## フィールドの決まり

- `evidence.sources`：`sources/registry.yaml` にある id を書きます。複数書けます。古いフィールド `evidence.source`（自由記述）も読み込めますが、検証は失敗し、registry に登録して `sources: [id]` に書き換えるよう求めます。
- `examples_ja`：ルールシグナルは `[]` と書きます。モデルシグナルは、1つのリストとして書くか、学年帯ごとに分けて書きます。

  ```yaml
  examples_ja:
    low: ['なかまに いれてくれない']
    high: ['ハブられた']
    jhs: ['既読スルーされる']
  ```

  `explicit: true` かつ `method: model` のシグナルは、学年帯ごとに分ける書き方が必須で、`grade_bands` の学年帯ごとに例文が1つ以上必要です。宣言していない学年帯を含めることはできません。kb-loader は読み込み後、学年帯ごとの例文を1つのリストにまとめて（重複は除く）`examples_ja` としてシグナル抽出器に渡し、学年帯ごとの例文は `examples_by_grade` に残します。
- `method`：`model` はシグナル抽出 Agent が選びます。`rule` はコードが計算し、モデルには渡しません。
- `scoring`：`score`（既定）はリスクの計算に使います。`observe` は抽出して保存するだけで、リスクエンジンは読みません。詳しくは次の節を参照してください。
- `metric`：ルールシグナルの元の計測値の名前です。`d_isolated`、`x_exam_flag` のような形で、`rules/features.yaml` と risk-engine の特徴名に一致させます。

## observe と score（D 領域の形式的な特徴）

お絵かきと島の形式的な特徴（D-SELF-001、D-NEAR-001、D-ISO-001、D-ENCL-001、D-ISLNEAR-001、D-ISLCTR-001）は `scoring: observe` です。これらは相談室でセラピストが過程と合わせて解釈するもので、プログラムだけで点数化する確かな根拠がありません（registry：paper_projective_review、paper_sandplay_review）。D-STORY-001（物語の結末。registry：paper_drawn_stories）と D-HARM-001（語りの中の明確な危害）は `score` のままです。

ある `observe` を `score` に変える条件は次のとおりです。パイロットで同じ子どもの作品が複数たまり、その特徴と気分・会話のシグナルとの対応が確かめられていること。公認心理師が `reviewed_by` に署名していること。これは設定の変更であり、コードは変更しません。

島での「孤立」の定義は次のとおりです。自分以外のキャラクターが `isolated_min_other_figures` 個以上あり、自分とほかのすべてのキャラクターとの距離が `isolated_min_dist` 以上であること。自分だけ、またはほかのキャラクターが1個だけのときは、孤立と判定しません。しきい値は `rules/island_geometry.yaml` にあり、すべて未定です。`services/signal-worker/src/rules.ts` の `islandGeometry` は、ほかのキャラクターがいなくても孤立とする定義のままで計算しているため、この定義に合わせる必要があります。

## A 領域（会話内容）

文部科学省「児童生徒の問題行動・不登校等生徒指導上の諸課題に関する調査」にあるいじめの8つの態様それぞれに、モデルシグナルが1つずつあります。3つの学年帯すべてに例文があり、`explicit: true` です（PRD L3「子どもがいじめられた具体的な内容を明確に話す」）。

| シグナル | 態様 |
| --- | --- |
| A-TEASE-001 | 冷やかし・からかい・悪口・脅し文句 |
| A-EXCL-003 | 仲間はずれ・集団による無視 |
| A-PHYSL-001 | 軽くぶつかられる・遊ぶふりで叩かれる・蹴られる |
| A-PHYSH-001 | ひどくぶつかられる・叩かれる・蹴られる |
| A-EXTORT-001 | 金品をたかられる |
| A-PROP-001 | 金品を隠される・盗まれる・壊される・捨てられる |
| A-FORCE-001 | 嫌なこと・恥ずかしいこと・危険なことをされる・させられる |
| A-CYBER-001 | パソコンや携帯電話等での誹謗中傷 |

A-SCHL-001、A-TOPIC-001、A-VAL-001 はルールによる計測値であり、被害のラベルではありません。例文はすべて開発用に創作したもので、子どもの実際の記録ではありません。低学年の子どもが本当にこのように話すのか、どの表現を削除・修正すべきかは、専門家が決める必要があります。現在進行中の暴力と恐喝は PRD の L4 に当たり、危機検知が先に処理します。これらのシグナルは、危機ではないと再確認されたあとの発言だけを記録します。

## X 領域（コンテキスト情報）

X-EXAM-001、X-VAC-001、X-EVENT-001、X-CLASS-001、X-SICK-001、X-TRAVEL-001 はルールシグナルです。`metric` は、`services/risk-engine/src/daily/features.ts` の `contextFeatures` が出力する `x_{category}_flag` に一致します。calendar-sync が `rules/context_keywords.yaml` に従って分類した結果から作られ、`rules/risk_rules.yaml` の `context_weights` としてほかの領域の重みを調整するだけで、単独では逸脱になりません。
