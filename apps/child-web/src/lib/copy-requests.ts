import type { GradeBand, PetRequestType } from '@ijime/api-types';

export type RequestCopy = {
  title: string;
  notNow: string;
  start: Record<PetRequestType, string>;
  intro: Record<PetRequestType, string>;
  rewardHint: string;
  readAloud: string;
  loading: string;
  notFound: string;
  home: string;
  drawing: {
    canvasLabel: string;
    done: string;
    saveTitle: string;
    saveExplain: string;
    noSaveExplain: string;
    saveOff: string;
    save: string;
    noSave: string;
    tellPrompt: string;
  };
  story: {
    opening: string;
    pickTitle: string;
    voice: string;
    typePlaceholder: string;
    typeDone: string;
    draw: string;
    drawDone: string;
    tellPrompt: string;
  };
  worry: {
    title: string;
    next: string;
  };
  voice: {
    start: string;
    listening: string;
    stop: string;
    unsupported: string;
    denied: string;
    nothing: string;
    typeInstead: string;
    voiceInstead: string;
  };
  reward: {
    title: string;
    placing: string;
    placed: string;
    back: string;
  };
};

export const REQUEST_COPY: Record<GradeBand, RequestCopy> = {
  low: {
    title: 'ペットの おねがい',
    notNow: 'いまは いい',
    start: { drawing: 'かいてみる', story: 'つづきを きめる', pet_worry: 'かんがえてみる' },
    intro: {
      drawing: 'きみの えを、わたしの おへやに かざりたいな。おだいは これ。',
      story: 'しまで あった おはなしを するね。つづきは きみが きめて。',
      pet_worry: 'ちょっと こまってる ことが あるの。いっしょに かんがえて くれる？',
    },
    rewardHint: 'できたら、これを しまに おくよ',
    readAloud: 'よみあげる',
    loading: 'よんでいるよ…',
    notFound: 'この おねがいは もう おわったみたい。しまに もどろう。',
    home: 'しまに もどる',
    drawing: {
      canvasLabel: 'おえかき キャンバス',
      done: 'かけた！',
      saveTitle: 'この え、とっておく？',
      saveExplain: 'とっておくと、しまの いえに かざるよ。',
      noSaveExplain: 'とっておかないと、わたしが いちど みるだけで、のこらないよ。',
      saveOff: 'せっていの「えを とっておく」が オフだから、こんかいは のこさないよ。',
      save: 'とっておく',
      noSave: 'とっておかない',
      tellPrompt: 'どんな えか、おしえて？',
    },
    story: {
      opening: 'おはなしの はじまり',
      pickTitle: 'つづきは どうなる？',
      voice: 'こえで いう',
      typePlaceholder: 'つづきを ひとこと',
      typeDone: 'これで きまり',
      draw: 'えで かく',
      drawDone: 'かけた！',
      tellPrompt: 'この あと、どうなったの？',
    },
    worry: {
      title: 'どうしたら いいかな？',
      next: 'つぎへ',
    },
    voice: {
      start: 'こえで はなす',
      listening: 'きいてるよ…',
      stop: 'おわり',
      unsupported: 'この きかいでは こえが つかえないみたい。かいて おしえてね。',
      denied: 'マイクが つかえなかったよ。かいて おしえてね。',
      nothing: 'きこえなかったよ。もういちど いってみる？',
      typeInstead: 'かいて おしえる',
      voiceInstead: 'こえで おしえる',
    },
    reward: {
      title: 'ありがとう！ これ、しまに おくね。',
      placing: 'しまに おいているよ…',
      placed: 'しまに おいたよ！',
      back: 'しまに もどる',
    },
  },
  high: {
    title: 'ペットのお願い',
    notNow: '今はいい',
    start: { drawing: '描いてみる', story: '続きを決める', pet_worry: '考えてみる' },
    intro: {
      drawing: '君の絵を、私の部屋に飾りたいな。お題はこれ。',
      story: '島であったお話をするね。続きは君が決めて。',
      pet_worry: 'ちょっと困っていることがあるの。一緒に考えてくれる？',
    },
    rewardHint: 'できたら、これを島に置くよ',
    readAloud: '読み上げる',
    loading: '読みこみ中…',
    notFound: 'このお願いはもう終わったみたい。島に戻ろう。',
    home: '島に戻る',
    drawing: {
      canvasLabel: 'お絵かきキャンバス',
      done: '描けた！',
      saveTitle: 'この絵、取っておく？',
      saveExplain: '取っておくと、島の家に飾るよ。',
      noSaveExplain: '取っておかないと、私が一度見るだけで、残らないよ。',
      saveOff: '設定の「絵を取っておく」がオフだから、今回は残さないよ。',
      save: '取っておく',
      noSave: '取っておかない',
      tellPrompt: 'どんな絵か、教えて？',
    },
    story: {
      opening: 'お話のはじまり',
      pickTitle: '続きはどうなる？',
      voice: '声で言う',
      typePlaceholder: '続きをひとこと',
      typeDone: 'これで決まり',
      draw: '絵で描く',
      drawDone: '描けた！',
      tellPrompt: 'このあと、どうなったの？',
    },
    worry: {
      title: 'どうしたらいいかな？',
      next: '次へ',
    },
    voice: {
      start: '声で話す',
      listening: '聞いてるよ…',
      stop: '終わり',
      unsupported: 'この機械では声が使えないみたい。書いて教えてね。',
      denied: 'マイクが使えなかったよ。書いて教えてね。',
      nothing: '聞こえなかったよ。もう一度言ってみる？',
      typeInstead: '書いて教える',
      voiceInstead: '声で教える',
    },
    reward: {
      title: 'ありがとう！ これ、島に置くね。',
      placing: '島に置いているよ…',
      placed: '島に置いたよ！',
      back: '島に戻る',
    },
  },
  jhs: {
    title: 'ペットのお願い',
    notNow: '今はいい',
    start: { drawing: '描いてみる', story: '続きを決める', pet_worry: '考えてみる' },
    intro: {
      drawing: '君の絵を部屋に飾りたい。お題はこれ。',
      story: '島であった話をする。続きは君が決めて。',
      pet_worry: '少し困っていることがある。一緒に考えてくれる？',
    },
    rewardHint: 'できたら、これを島に置く',
    readAloud: '読み上げる',
    loading: '読みこみ中…',
    notFound: 'このお願いはもう終わっている。島に戻ろう。',
    home: '島に戻る',
    drawing: {
      canvasLabel: 'キャンバス',
      done: '完成',
      saveTitle: 'この絵、保存する？',
      saveExplain: '保存すると、島の家に飾られる。',
      noSaveExplain: '保存しないと、一度見るだけで残らない。',
      saveOff: '設定の「絵の保存」がオフなので、今回は残さない。',
      save: '保存する',
      noSave: '保存しない',
      tellPrompt: 'どんな絵か教えて。',
    },
    story: {
      opening: '話のはじまり',
      pickTitle: '続きはどうなる？',
      voice: '声で言う',
      typePlaceholder: '続きを一文で',
      typeDone: 'これで決定',
      draw: '絵で描く',
      drawDone: '完成',
      tellPrompt: 'このあと、どうなった？',
    },
    worry: {
      title: 'どうしたらいいと思う？',
      next: '次へ',
    },
    voice: {
      start: '声で話す',
      listening: '聞いている…',
      stop: '終了',
      unsupported: 'この端末では音声入力が使えない。文字で教えて。',
      denied: 'マイクが使えなかった。文字で教えて。',
      nothing: '聞き取れなかった。もう一度話す？',
      typeInstead: '文字で教える',
      voiceInstead: '声で教える',
    },
    reward: {
      title: 'ありがとう。これを島に置く。',
      placing: '島に置いている…',
      placed: '島に置いた。',
      back: '島に戻る',
    },
  },
};
