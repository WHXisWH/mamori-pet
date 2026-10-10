import type { ConsultChoice, GradeBand } from '@ijime/api-types';

type Copy = {
  help: string;
  helpResources: string;
  back: string;
  settingsLabel: string;
  greeting: { morning: string; afterSchool: string; night: string; day: string };
  homeCheckin: { ask: string; yes: string; manual: string; thanks: string };
  shelf: {
    chat: string;
    mood: string;
    drawSelf: string;
    drawStory: string;
    island: string;
    tell: string;
  };
  // {w} は天気の名前に置き換える
  mood: {
    title: string;
    pickFirst: string;
    picked: string;
    confirm: string;
    done: string;
    already: string;
    today: string;
    again: string;
    home: string;
  };
  chat: { placeholder: string; send: string; voice: string; voiceStop: string; thinking: string };
  draw: {
    selfTitle: string;
    storyTitle: string;
    done: string;
    undo: string;
    eraser: string;
    save: string;
    noSave: string;
  };
  narrative: { title: string; placeholder: string; done: string; skip: string };
  // {w} は天気、{n} は数に置き換える
  home: {
    scene: string;
    pet: string;
    sky: string;
    skyToday: string;
    plant: string;
    water: string;
    watered: string;
    waterDone: string;
    jar: string;
    jarCount: string;
    jarDone: string;
    jarAdded: string;
    jarSay: string;
    jarPlaceholder: string;
    jarClose: string;
    house: string;
    decorations: string;
    noDecorations: string;
    close: string;
    arrange: string;
    fromPet: string;
    visitDays: string;
    tell: string;
    careHotline: string;
  };
  request: {
    heading: Record<'drawing' | 'story' | 'pet_worry', string>;
    reward: string;
    open: string;
    decline: string;
    declined: string;
  };
  island: {
    title: string;
    me: string;
    meOff: string;
    meHint: string;
    done: string;
    save: string;
    saved: string;
    savedBody: string;
    tellPrompt: string;
    drawer: string;
    locked: string;
    lockedHint: string;
    rotate: string;
    up: string;
    down: string;
    remove: string;
    keyboardHelp: string;
    stageLabel: string;
    loading: string;
    selected: string;
    nothingSelected: string;
  };
  tell: {
    intro: string;
    choices: Record<ConsultChoice, string>;
    coachTitle: string;
    coachDone: string;
    summaryTitle: string;
    summaryOk: string;
    summaryPlaceholder: string;
    notNow: string;
  };
  safe: {
    adultNear: string;
    yes: string;
    no: string;
    back: string;
    confirmSafe: string;
    confirmYes: string;
    confirmNo: string;
  };
  pair: { title: string; hint: string; submit: string; error: string };
  welcome: { pages: { title: string; body: string }[]; agree: string; next: string };
  choose: { title: string; name: string; namePlaceholder: string; go: string; egg: string };
  settings: {
    title: string;
    sources: string;
    memories: string;
    noMemories: string;
    lock: string;
    grade: string;
    readAloud: string;
    proactive: string;
    deleteAll: string;
    deleted: string;
  };
  lock: { title: string; wrong: string };
  offline: string;
};

export const COPY: Record<GradeBand, Copy> = {
  low: {
    help: 'こまったら',
    helpResources: 'はなしを きいて くれる ところ',
    back: 'もどる',
    settingsLabel: 'せってい',
    greeting: {
      morning: 'おはよう！きょうも いっしょだよ。',
      afterSchool: 'おかえり！きょうは どうだった？',
      night: 'こんばんは。きょうは どんな いちにち だった？',
      day: 'やあ！きょうは なにして あそぶ？',
    },
    homeCheckin: {
      ask: 'いま おうちに いる？',
      yes: 'おうちに いるよ',
      manual: 'いえに ついたよ',
      thanks: 'おかえり！',
    },
    shelf: {
      chat: 'おはなし',
      mood: 'こころの てんき',
      drawSelf: 'じぶんを かく',
      drawStory: 'おはなしを かく',
      island: 'しまを つくる',
      tell: 'おうちの ひとに つたえたい こと',
    },
    mood: {
      title: 'こころの てんきは？',
      pickFirst: 'てんきを えらんでね',
      picked: '「{w}」 なんだね。これで いい？',
      confirm: '「{w}」に する',
      done: 'おしえてくれて ありがとう！',
      already: 'きょうは 「{w}」って おしえてくれたね。',
      today: 'きょうの てんき',
      again: 'もういちど えらぶ',
      home: 'おへやに もどる',
    },
    chat: {
      placeholder: 'ここに かいてね',
      send: 'おくる',
      voice: 'こえで はなす',
      voiceStop: 'おわる',
      thinking: 'かんがえちゅう…',
    },
    draw: {
      selfTitle: 'いまの じぶんを かいてみよう',
      storyTitle: 'おはなしの つづきを かこう',
      done: 'かけた！',
      undo: 'もどす',
      eraser: 'けしごむ',
      save: 'とっておく',
      noSave: 'とっておかない',
    },
    narrative: {
      title: 'どんな えか、おしえて',
      placeholder: 'これは…',
      done: 'おしまい',
      skip: 'いわない',
    },
    home: {
      scene: 'ペットの しま',
      pet: 'ペットと おはなしする',
      sky: 'こころの てんきを えらぶ',
      skyToday: 'きょうの てんきは 「{w}」。えらびなおす',
      plant: 'はなに みずを あげる',
      water: 'みずを あげる',
      watered: 'きょうは もう みずを あげたよ',
      waterDone: 'みずを あげたよ！',
      jar: 'いいこと びんに ほしを いれる',
      jarCount: 'ほし {n}こ',
      jarDone: 'きょうの ほしは いれたよ',
      jarAdded: 'ほしが ひとつ ふえたよ！',
      jarSay: 'ひとこと いう？（どこにも おくらないよ）',
      jarPlaceholder: 'きょうの いいこと',
      jarClose: 'おしまい',
      house: 'おうちに かかっている えを みる',
      decorations: 'かかっている え',
      noDecorations:
        'まだ えは かかって いないよ。ペットの おねがいを かなえると、ここに かけられるよ。',
      close: 'とじる',
      arrange: 'しまを かざる',
      fromPet: 'ペットから',
      visitDays: 'きた ひ {n}にち',
      tell: 'おうちの ひとに つたえたい こと',
      careHotline: 'こまったら ここに でんわ できるよ',
    },
    request: {
      heading: {
        drawing: 'えを かいて ほしいな',
        story: 'おはなしの つづきを きめて ほしいな',
        pet_worry: 'ちょっと そうだんが あるんだ',
      },
      reward: 'できたら もらえる もの',
      open: 'やってみる',
      decline: 'いまは いい',
      declined: 'わかった。また こんどね。',
    },
    island: {
      title: 'しまを かざろう',
      me: 'これが わたし',
      meOff: 'わたしを やめる',
      meHint: '「これが わたし」は えらばなくても いいよ',
      done: 'できた！',
      save: 'ほぞんする',
      saved: 'しまが かわったよ！',
      savedBody: 'いつでも また かざれるよ。',
      tellPrompt: 'この しまでは、なにが おきてる？',
      drawer: 'おくもの',
      locked: 'まだ もって いない',
      lockedHint: 'ペットの おねがいを かなえると もらえるよ',
      rotate: 'まわす',
      up: 'まえに',
      down: 'うしろに',
      remove: 'けす',
      keyboardHelp: 'キーボード：ものを えらんで、やじるしキーで うごかす。Delete で けす。',
      stageLabel: 'しまの えらんだ ものを うごかす ばしょ',
      loading: 'しまを よんでいるよ…',
      selected: 'えらんでいる もの',
      nothingSelected: 'したから おくものを えらんでね',
    },
    tell: {
      intro: 'はなしてくれて ありがとう。おとなに いうのは、ゆうきが いるよね。どうする？',
      choices: { self: 'じぶんで いう', proxy: 'かわりに つたえて', not_now: 'いまは やめておく' },
      coachTitle: 'いっしょに れんしゅう しよう',
      coachDone: 'きっと だいじょうぶ。いってらっしゃい。',
      summaryTitle: 'この ひとことを つたえるよ。これで いい？',
      summaryOk: 'これで いい',
      summaryPlaceholder: 'つたえたい ことを かいてね',
      notNow: 'だいじょうぶ。ずっと ここに いるよ。',
    },
    safe: {
      adultNear: 'ちかくに おとなは いる？',
      yes: 'いる',
      no: 'いない',
      back: 'もどる',
      confirmSafe: 'いま、あんぜん？',
      confirmYes: 'あんぜん',
      confirmNo: 'まだ こわい',
    },
    pair: {
      title: 'おうちの ひとから もらった かずを いれてね',
      hint: '6つの すうじ',
      submit: 'つなぐ',
      error: 'ちがう みたい。おうちの ひとに きいてね。',
    },
    welcome: {
      pages: [
        {
          title: 'わたしは AI の ペットだよ',
          body: 'にんげんじゃ ないけど、きみの はなしを ちゃんと きくよ。',
        },
        { title: 'ペットとの やくそく', body: '' },
        {
          title: 'ひとつだけ、だいじな やくそく',
          body: 'あぶない ときは、あんぜんな おとなに たすけを もとめよう。おうちが こわい ときは、べつの そうだんさきを あんないするよ。',
        },
      ],
      agree: 'わかった！',
      next: 'つぎへ',
    },
    choose: {
      title: 'なかまを えらぼう',
      name: 'なまえを つける？',
      namePlaceholder: 'なまえ',
      go: 'この こに する',
      egg: 'なにが うまれるかな？',
    },
    settings: {
      title: 'せってい',
      sources: 'ペットが つかう もの',
      memories: 'ペットが おぼえて いること',
      noMemories: 'まだ なにも おぼえて いないよ',
      lock: 'ペットの あいことば',
      grade: 'がくねん',
      readAloud: 'よみあげ',
      proactive: 'ペットからの あいさつ',
      deleteAll: 'ぜんぶ けす',
      deleted: 'けす おねがいを おくったよ',
    },
    lock: { title: 'あいことばを いれてね', wrong: 'ちがうよ' },
    offline: 'いまは ネットに つながって いないよ',
  },
  high: {
    help: 'こまったとき',
    helpResources: '話を聞いてくれるところ',
    back: 'もどる',
    settingsLabel: '設定',
    greeting: {
      morning: 'おはよう！今日も一緒だよ。',
      afterSchool: 'おかえり！今日はどんな日だった？',
      night: 'こんばんは。今日はどんな一日だった？',
      day: 'やあ！今日は何して遊ぶ？',
    },
    homeCheckin: {
      ask: '今、家にいる？',
      yes: '家にいるよ',
      manual: '家に着いたよ',
      thanks: 'おかえり！',
    },
    shelf: {
      chat: 'おしゃべり',
      mood: '心の天気',
      drawSelf: '自分を描く',
      drawStory: 'お話を描く',
      island: '島をつくる',
      tell: 'おうちの人に伝えたいこと',
    },
    mood: {
      title: '今日の心の天気は？',
      pickFirst: '天気をえらんでね',
      picked: '「{w}」なんだね。これでいい？',
      confirm: '「{w}」にする',
      done: '教えてくれてありがとう！',
      already: '今日は「{w}」って教えてくれたね。',
      today: '今日の天気',
      again: 'もう一度えらぶ',
      home: 'へやにもどる',
    },
    chat: {
      placeholder: 'ここに書いてね',
      send: '送る',
      voice: '声で話す',
      voiceStop: '終わる',
      thinking: '考え中…',
    },
    draw: {
      selfTitle: '今の自分を描いてみよう',
      storyTitle: 'お話の続きを描こう',
      done: '描けた！',
      undo: '戻す',
      eraser: '消しゴム',
      save: '取っておく',
      noSave: '取っておかない',
    },
    narrative: {
      title: 'どんな絵か教えて',
      placeholder: 'これは…',
      done: 'おしまい',
      skip: '言わない',
    },
    home: {
      scene: 'ペットの島',
      pet: 'ペットとおしゃべりする',
      sky: '心の天気をえらぶ',
      skyToday: '今日の天気は「{w}」。えらびなおす',
      plant: '花に水をあげる',
      water: '水をあげる',
      watered: '今日はもう水をあげたよ',
      waterDone: '水をあげたよ！',
      jar: 'いいことビンに星を入れる',
      jarCount: '星 {n}こ',
      jarDone: '今日の星は入れたよ',
      jarAdded: '星がひとつ増えたよ！',
      jarSay: 'ひとこと言う？（どこにも送らないよ）',
      jarPlaceholder: '今日のいいこと',
      jarClose: 'おしまい',
      house: '家にかかっている絵を見る',
      decorations: 'かかっている絵',
      noDecorations: 'まだ絵はかかっていないよ。ペットのおねがいをかなえると、ここにかけられるよ。',
      close: 'とじる',
      arrange: '島をかざる',
      fromPet: 'ペットから',
      visitDays: '来た日 {n}日',
      tell: 'おうちの人に伝えたいこと',
      careHotline: '困ったらここに電話できるよ',
    },
    request: {
      heading: {
        drawing: '絵を描いてほしいな',
        story: 'お話の続きを決めてほしいな',
        pet_worry: 'ちょっと相談があるんだ',
      },
      reward: 'できたらもらえるもの',
      open: 'やってみる',
      decline: 'いまはいい',
      declined: 'わかった。また今度ね。',
    },
    island: {
      title: '島をかざろう',
      me: 'これが私',
      meOff: '「私」をやめる',
      meHint: '「これが私」はえらばなくてもいいよ',
      done: 'できた！',
      save: '保存する',
      saved: '島が変わったよ！',
      savedBody: 'いつでもまたかざれるよ。',
      tellPrompt: 'この島では、何が起きてる？',
      drawer: '置くもの',
      locked: 'まだ持っていない',
      lockedHint: 'ペットのおねがいをかなえるともらえるよ',
      rotate: '回す',
      up: '前に',
      down: '後ろに',
      remove: '消す',
      keyboardHelp: 'キーボード：ものをえらんで、矢印キーで動かす。Delete で消す。',
      stageLabel: '島のえらんだものを動かす場所',
      loading: '島を読んでいるよ…',
      selected: 'えらんでいるもの',
      nothingSelected: '下から置くものをえらんでね',
    },
    tell: {
      intro: '話してくれてありがとう。大人に言うのは勇気がいるよね。どうする？',
      choices: { self: '自分で言う', proxy: '代わりに伝えて', not_now: '今はやめておく' },
      coachTitle: '一緒に練習しよう',
      coachDone: 'きっと大丈夫。いってらっしゃい。',
      summaryTitle: 'このひとことを伝えるよ。これでいい？',
      summaryOk: 'これでいい',
      summaryPlaceholder: '伝えたいことを書いてね',
      notNow: '大丈夫。ずっとここにいるよ。',
    },
    safe: {
      adultNear: '近くに大人はいる？',
      yes: 'いる',
      no: 'いない',
      back: 'もどる',
      confirmSafe: '今、安全？',
      confirmYes: '安全',
      confirmNo: 'まだこわい',
    },
    pair: {
      title: 'おうちの人からもらった番号を入れてね',
      hint: '6けたの数字',
      submit: 'つなぐ',
      error: '違うみたい。おうちの人に聞いてね。',
    },
    welcome: {
      pages: [
        { title: '私は AI のペットだよ', body: '人間じゃないけど、君の話をちゃんと聞くよ。' },
        { title: 'ペットとの約束', body: '' },
        {
          title: 'ひとつだけ、大事な約束',
          body: '命や体が危ないときは、安全な大人に助けを求めよう。おうちの安全が心配なときは、別の相談先を案内するよ。',
        },
      ],
      agree: 'わかった！',
      next: '次へ',
    },
    choose: {
      title: 'なかまを選ぼう',
      name: '名前をつける？',
      namePlaceholder: '名前',
      go: 'この子にする',
      egg: '何が生まれるかな？',
    },
    settings: {
      title: '設定',
      sources: 'ペットが使うもの',
      memories: 'ペットが覚えていること',
      noMemories: 'まだ何も覚えていないよ',
      lock: 'ペットの合言葉',
      grade: '学年',
      readAloud: '読み上げ',
      proactive: 'ペットからの挨拶',
      deleteAll: '全部消す',
      deleted: '消すお願いを送ったよ',
    },
    lock: { title: '合言葉を入れてね', wrong: '違うよ' },
    offline: '今はネットにつながっていないよ',
  },
  jhs: {
    help: '困ったとき',
    helpResources: '相談できる窓口',
    back: '戻る',
    settingsLabel: '設定',
    greeting: {
      morning: 'おはよう。今日も一緒に。',
      afterSchool: 'おかえり。今日はどうだった？',
      night: 'こんばんは。今日はどんな一日だった？',
      day: 'やあ。今日は何する？',
    },
    homeCheckin: {
      ask: '今、家にいる？',
      yes: '家にいる',
      manual: '家に着いた',
      thanks: 'おかえり。',
    },
    shelf: {
      chat: 'チャット',
      mood: '心の天気',
      drawSelf: '自分を描く',
      drawStory: '物語を描く',
      island: '島をつくる',
      tell: '家の人に伝えたいこと',
    },
    mood: {
      title: '今日の気分を天気で言うと？',
      pickFirst: '天気を選んでね',
      picked: '「{w}」だね。これでいい？',
      confirm: '「{w}」で決定',
      done: 'ありがとう。',
      already: '今日は「{w}」だったね。',
      today: '今日の天気',
      again: '選び直す',
      home: 'ホームに戻る',
    },
    chat: {
      placeholder: 'メッセージ',
      send: '送信',
      voice: '音声で話す',
      voiceStop: '終了',
      thinking: '考え中…',
    },
    draw: {
      selfTitle: '今の自分を描く',
      storyTitle: '物語の続きを描く',
      done: '完成',
      undo: '戻す',
      eraser: '消しゴム',
      save: '保存する',
      noSave: '保存しない',
    },
    narrative: {
      title: 'この絵について教えて',
      placeholder: 'これは…',
      done: '終わり',
      skip: '言わない',
    },
    home: {
      scene: 'ペットの島',
      pet: 'ペットと話す',
      sky: '心の天気を選ぶ',
      skyToday: '今日の天気は「{w}」。選び直す',
      plant: '花に水をやる',
      water: '水をやる',
      watered: '今日はもう水をやった',
      waterDone: '水をやった',
      jar: 'いいことビンに星を入れる',
      jarCount: '星 {n}個',
      jarDone: '今日の星は入れた',
      jarAdded: '星が一つ増えた',
      jarSay: '一言どう？（どこにも送らない）',
      jarPlaceholder: '今日のいいこと',
      jarClose: '閉じる',
      house: '家に飾った絵を見る',
      decorations: '飾った絵',
      noDecorations: 'まだ絵は飾っていない。ペットの頼みをかなえると、ここに飾れる。',
      close: '閉じる',
      arrange: '島を飾る',
      fromPet: 'ペットから',
      visitDays: '来た日 {n}日',
      tell: '家の人に伝えたいこと',
      careHotline: '困ったらここに電話できるよ',
    },
    request: {
      heading: {
        drawing: '絵を描いてほしい',
        story: '物語の続きを決めてほしい',
        pet_worry: 'ちょっと相談がある',
      },
      reward: 'できたらもらえるもの',
      open: 'やってみる',
      decline: '今はいい',
      declined: 'わかった。また今度。',
    },
    island: {
      title: '島を飾る',
      me: 'これが自分',
      meOff: '「自分」を外す',
      meHint: '「これが自分」は選ばなくてもいい',
      done: '完成',
      save: '保存',
      saved: '島を保存した',
      savedBody: 'いつでもまた飾れる。',
      tellPrompt: 'この島では、何が起きてる？',
      drawer: '置くもの',
      locked: 'まだ持っていない',
      lockedHint: 'ペットの頼みをかなえるともらえる',
      rotate: '回転',
      up: '前へ',
      down: '後ろへ',
      remove: '削除',
      keyboardHelp: 'キーボード：物を選んで矢印キーで移動。Delete で削除。',
      stageLabel: '島の選んだ物を動かす場所',
      loading: '島を読み込み中…',
      selected: '選んでいる物',
      nothingSelected: '下から置く物を選ぶ',
    },
    tell: {
      intro: '話してくれてありがとう。大人に言うのは、勇気がいる。どうしたい？',
      choices: { self: '自分で言う', proxy: '代わりに伝えて', not_now: '今はやめておく' },
      coachTitle: '一緒に練習する',
      coachDone: '大丈夫。行ってらっしゃい。',
      summaryTitle: 'この一言を伝える。これでいい？',
      summaryOk: 'これでいい',
      summaryPlaceholder: '伝えたいこと',
      notNow: 'わかった。いつでもここにいる。',
    },
    safe: {
      adultNear: '今、近くに大人はいる？',
      yes: 'いる',
      no: 'いない',
      back: '戻る',
      confirmSafe: '今、安全？',
      confirmYes: '安全',
      confirmNo: 'まだ不安',
    },
    pair: {
      title: '保護者からもらったコードを入力',
      hint: '6けたの数字',
      submit: 'つなぐ',
      error: 'コードが違うか、期限切れです。',
    },
    welcome: {
      pages: [
        {
          title: '私は AI のペットです',
          body: '人間ではないけれど、あなたの話をちゃんと聞きます。',
        },
        { title: 'ペットとの約束', body: '' },
        {
          title: 'ひとつだけ、大事な約束',
          body: '命や体が危ないときは、安全な大人に助けを求めよう。おうちの安全が心配なときは、別の相談先を案内するよ。',
        },
      ],
      agree: 'わかった',
      next: '次へ',
    },
    choose: {
      title: '相棒を選ぶ',
      name: '名前をつける？',
      namePlaceholder: '名前',
      go: 'この子にする',
      egg: '何が生まれるかは、生まれてから',
    },
    settings: {
      title: '設定',
      sources: 'ペットが使うデータ',
      memories: 'ペットが覚えていること',
      noMemories: 'まだ何も覚えていない',
      lock: 'ペットの合言葉',
      grade: '学年',
      readAloud: '読み上げ',
      proactive: 'ペットからの挨拶',
      deleteAll: 'すべて削除',
      deleted: '削除のリクエストを送った',
    },
    lock: { title: '合言葉を入力', wrong: '違います' },
    offline: '今はオフラインです',
  },
};

export function greetingFor(g: GradeBand, hour: number, schoolDay: boolean): string {
  const c = COPY[g].greeting;
  if (hour >= 5 && hour < 10) return c.morning;
  if (schoolDay && hour >= 14 && hour < 19) return c.afterSchool;
  if (hour >= 19 || hour < 5) return c.night;
  return c.day;
}

export const DATA_SOURCE_LABELS: Record<GradeBand, Record<string, string>> = {
  low: {
    voice: 'こえ',
    typing: 'うつ はやさ',
    artwork_save: 'えを とっておく',
    home_checkin: 'おかえり チェック',
    calendar: 'おうちの カレンダー',
  },
  high: {
    voice: '声',
    typing: '打つ速さ',
    artwork_save: '絵を取っておく',
    home_checkin: 'おかえりチェック',
    calendar: 'おうちのカレンダー',
  },
  jhs: {
    voice: '音声',
    typing: 'タイピングの速さ',
    artwork_save: '絵の保存',
    home_checkin: '帰宅チェック',
    calendar: '家のカレンダー',
  },
};
