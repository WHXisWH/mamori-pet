import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import kuromoji from 'kuromoji';

// ローカルの辞書（kuromoji 同梱の IPADIC。ネットワークに接続しない）で読みを取り、モーラを数える
type Tokenizer = kuromoji.Tokenizer<kuromoji.IpadicFeatures>;

let tokenizer: Promise<Tokenizer> | undefined;

function dictPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('kuromoji/package.json')), 'dict');
}

export function loadTokenizer(): Promise<Tokenizer> {
  tokenizer ??= new Promise((resolve, reject) =>
    kuromoji.builder({ dicPath: dictPath() }).build((err, t) => (err ? reject(err) : resolve(t))),
  );
  return tokenizer;
}

const SMALL = new Set('ァィゥェォャュョヮぁぃぅぇぉゃゅょゎ');

function toKatakana(s: string): string {
  return s.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

// 拗音の小書き文字は単独では1拍に数えない。促音ッ、撥音ン、長音ーはそれぞれ1拍に数える
export function countKanaMorae(kana: string): number {
  let n = 0;
  for (const ch of toKatakana(kana)) {
    if (SMALL.has(ch)) continue;
    if (/[\u30a1-\u30fa\u30fc]/.test(ch)) n++;
  }
  return n;
}

export async function countMorae(text: string): Promise<number> {
  const t = await loadTokenizer();
  let n = 0;
  for (const tok of t.tokenize(text.normalize('NFKC'))) {
    const reading = tok.reading && tok.reading !== '*' ? tok.reading : tok.surface_form;
    n += countKanaMorae(reading);
  }
  return n;
}
