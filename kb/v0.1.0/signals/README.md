# シグナル定義

状態: DRAFT / 専門家未レビュー。シグナル定義は専門家の確認待ちで、`reviewed_by` はすべて未定です。

ナレッジベースの状態は 3 段階あります（DRAFT / 専門家未レビュー、文献確認済み / 専門家未署名、専門家承認済み）。会話ガイドは「文献確認済み / 専門家未署名」に進みましたが、シグナル定義は DRAFT のままです。出典は `sources/registry.yaml` に登録して文献を確認しましたが、その結果に合わせた定義の見直し（`scoring` の変更など）はまだ行っていません。領域ごとの根拠、スコアに使ってよいか観察にとどめるか、見直しの提言は `sources/evidence-review.md` の「シグナル領域ごとの結論」にまとめています。主な点は次のとおりです。

- どの領域も、単独では判定に使えません。サインの感度・特異度を検証した研究は見つかっていません。
- K（入力）・V（声）・I（時刻）領域は、文献上は観察にとどめるのが妥当です。現在は `scoring` の指定がなく、既定の `score` になっています。
- 深夜の利用時刻は、いじめ被害のサインになりません。帰宅の時刻は根拠が見つからず、収集の必要性を再検討する対象です。
- 気分の自己報告（M）は本人の申告として使えますが、単独では判定しません。未回答を不調とも元気とも解釈しません。

シグナル1つにつき YAML ファイルを1つ置きます。フィールドは docs/01-prd.md モジュール1のシグナル項目の定義に合わせています。構造は `@ijime/kb-loader` の `signalDefinitionSchema` が、内容は `validateKnowledgeBase` が検証します（`pnpm kb:check` と `pnpm kb:manifest` のどちらでも実行されます）。正式に承認されたものとは見なせません。

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

お絵かきと島の形式的な特徴（D-SELF-001、D-NEAR-001、D-ISO-001、D-ENCL-001、D-ISLNEAR-001、D-ISLCTR-001）は `scoring: observe` です。これらは相談室でセラピストが過程と合わせて解釈するもので、プログラムだけで点数化する確かな根拠がありません（registry：lilienfeld_projective_techniques_2000、cox_catte_disturbed_children_drawings_2000、jankelowitz_sand_therapy_review_2026）。koli_trauma_screening_synthetic_preprint_2026 は合成データだけで評価した査読前の論文で、判定できることの根拠にはなりません。D-STORY-001（物語の結末。registry：la_grutta_drawn_stories_2023）と D-HARM-001（語りの中の明確な危害）は `score` のままです。ただし la_grutta_drawn_stories_2023 はいじめの検出を目的とした研究ではなく、判定の精度を示していません。D-STORY-001 を観察に変えるかどうかは専門家の確認待ちです。

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
