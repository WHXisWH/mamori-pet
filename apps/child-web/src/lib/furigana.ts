export type FuriganaSegment = { text: string; reading?: string };

// Structural subset of Kuromoji/IPADIC tokens; no parser or dictionary is loaded here.
export type JapaneseReadingToken = {
  surface_form: string;
  word_type: string;
  reading?: string;
};

// Limited UI-word fallback, not a morphological parser. Dynamic prose should use
// dictionary tokens; do not expand coverage with guessed single-kanji readings.
const READINGS: ReadonlyArray<readonly [string, string]> = [
  // Fixed character descriptions and grade controls displayed to younger children.
  ['聞き上手', 'ききじょうず'],
  ['短い', 'みじかい'],
  ['言葉', 'ことば'],
  ['元気', 'げんき'],
  ['好奇心', 'こうきしん'],
  ['口ぐせ', 'くちぐせ'],
  ['不器用', 'ぶきよう'],
  ['自分', 'じぶん'],
  ['入れる', 'いれる'],
  ['近づいて', 'ちかづいて'],
  ['決めて', 'きめて'],
  ['落ち着いて', 'おちついて'],
  ['頼れる', 'たよれる'],
  ['兄さん', 'にいさん'],
  ['姉さん', 'ねえさん'],
  ['対等', 'たいとう'],
  ['説教', 'せっきょう'],
  ['静かな', 'しずかな'],
  ['夜', 'よる'],
  ['見守り役', 'みまもりやく'],
  ['寝る前', 'ねるまえ'],
  ['過ごす', 'すごす'],
  ['見た目', 'みため'],
  ['性格', 'せいかく'],
  ['生まれる', 'うまれる'],
  ['日も', 'ひも'],
  ['小学校', 'しょうがっこう'],
  ['中学校', 'ちゅうがっこう'],
  ['年', 'ねん'],
  ['児童相談所', 'じどうそうだんじょ'],
  ['保護者', 'ほごしゃ'],
  ['子供', 'こども'],
  ['子ども', 'こども'],
  ['虐待', 'ぎゃくたい'],
  ['対応', 'たいおう'],
  ['警察', 'けいさつ'],
  ['救急', 'きゅうきゅう'],
  ['緊急', 'きんきゅう'],
  ['危険', 'きけん'],
  ['安全', 'あんぜん'],
  ['電話', 'でんわ'],
  ['番号', 'ばんごう'],
  ['受付', 'うけつけ'],
  ['確認', 'かくにん'],
  ['公開', 'こうかい'],
  ['関する', 'かんする'],
  ['休み', 'やすみ'],
  ['大丈夫', 'だいじょうぶ'],
  ['仲間外れ', 'なかまはずれ'],
  ['心配', 'しんぱい'],
  ['物語', 'ものがたり'],
  ['気持ち', 'きもち'],
  ['大人', 'おとな'],
  ['友達', 'ともだち'],
  ['先生', 'せんせい'],
  ['教室', 'きょうしつ'],
  ['学校', 'がっこう'],
  ['相談', 'そうだん'],
  ['家族', 'かぞく'],
  ['今日', 'きょう'],
  ['明日', 'あした'],
  ['昨日', 'きのう'],
  ['一緒', 'いっしょ'],
  ['安心', 'あんしん'],
  ['大切', 'たいせつ'],
  ['毎日', 'まいにち'],
  ['時間', 'じかん'],
  ['歳', 'さい'],
  ['時', 'じ'],
  ['選ぶ', 'えらぶ'],
  ['選んで', 'えらんで'],
  ['選んだ', 'えらんだ'],
  ['選ぼう', 'えらぼう'],
  ['描く', 'かく'],
  ['描いて', 'かいて'],
  ['描いた', 'かいた'],
  ['描こう', 'かこう'],
  ['島', 'しま'],
  ['助け', 'たすけ'],
  ['話そう', 'はなそう'],
  ['話す', 'はなす'],
  ['話して', 'はなして'],
  ['話した', 'はなした'],
  ['話し', 'はなし'],
  ['聞く', 'きく'],
  ['聞いて', 'きいて'],
  ['聞いた', 'きいた'],
  ['聞こう', 'きこう'],
];

export function furiganaSegments(
  text: string,
  enabled: boolean,
  tokens?: readonly JapaneseReadingToken[],
): FuriganaSegment[] {
  if (!enabled || !text) return [{ text }];
  if (tokens) {
    // Reject stale/normalized tokenization instead of changing the child's visible text.
    if (tokens.map((token) => token.surface_form).join('') !== text) return [{ text }];
    return tokens.map((token) => {
      const reading = token.reading;
      if (
        token.word_type !== 'KNOWN' ||
        !/\p{Script=Han}/u.test(token.surface_form) ||
        !reading ||
        !/^[\u3041-\u3096\u30a1-\u30f6ー]+$/u.test(reading)
      )
        return { text: token.surface_form };
      return {
        text: token.surface_form,
        reading: reading.replace(/[\u30a1-\u30f6]/gu, (kana) =>
          String.fromCharCode(kana.charCodeAt(0) - 0x60),
        ),
      };
    });
  }
  const result: FuriganaSegment[] = [];
  let plain = '';
  const flushPlain = () => {
    if (plain) result.push({ text: plain });
    plain = '';
  };
  for (let index = 0; index < text.length;) {
    const match = READINGS.find(([word]) => text.startsWith(word, index));
    if (!match) {
      plain += text[index]!;
      index += 1;
      continue;
    }
    flushPlain();
    result.push({ text: match[0], reading: match[1] });
    index += match[0].length;
  }
  flushPlain();
  return result;
}
