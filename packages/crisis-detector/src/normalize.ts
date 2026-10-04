const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = 0x60;

export function katakanaToHiragana(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out +=
      code >= KATAKANA_START && code <= KATAKANA_END
        ? String.fromCodePoint(code - KANA_OFFSET)
        : ch;
  }
  return out;
}

export function normalizeJa(text: string): string {
  const nfkc = text.normalize('NFKC').toLowerCase();
  const kana = katakanaToHiragana(nfkc);
  const noSpace = kana.replace(/[\s\u3000]+/g, '');
  const noLongMark = noSpace.replace(/ー+/g, '');
  const noPunct = noLongMark.replace(/[!！?？。、,.…・~〜「」『』()（）\-_]+/g, '');
  return collapseRepeats(noPunct);
}

function collapseRepeats(s: string): string {
  let out = '';
  let prev = '';
  let run = 0;
  for (const ch of s) {
    if (ch === prev) {
      run += 1;
      if (run >= 2) continue;
    } else {
      prev = ch;
      run = 0;
    }
    out += ch;
  }
  return out;
}
