// @vitest-environment node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import { CHARACTER_META } from '@ijime/ui';

import { furiganaSegments, type JapaneseReadingToken } from './furigana';

describe('furigana', () => {
  it('covers the fixed character descriptions and grade labels without changing their text', () => {
    const texts = [
      ...Object.values(CHARACTER_META).flatMap((meta) => [meta.tagline, meta.personality]),
      '小学校 4〜6年',
      '中学校',
    ];
    for (const text of texts) {
      const segments = furiganaSegments(text, true);
      expect(segments.map((s) => s.text).join('')).toBe(text);
      expect(
        segments
          .filter((s) => !s.reading)
          .map((s) => s.text)
          .join(''),
      ).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it('annotates fixed emergency resource names without guessing unknown names', () => {
    for (const text of [
      '24時間子供SOSダイヤル',
      '児童相談所虐待対応ダイヤル',
      '警察・救急',
      '緊急の危険があるとき',
    ]) {
      const segments = furiganaSegments(text, true);
      expect(segments.map((s) => s.text).join('')).toBe(text);
      expect(
        segments
          .filter((s) => !s.reading)
          .map((s) => s.text)
          .join(''),
      ).not.toMatch(/\p{Script=Han}/u);
    }
  });
  it('annotates known words and preserves unknown text', () => {
    expect(furiganaSegments('学校で話そう。', true)).toEqual([
      { text: '学校', reading: 'がっこう' },
      { text: 'で' },
      { text: '話そう', reading: 'はなそう' },
      { text: '。' },
    ]);
  });

  it('can be disabled without changing the displayed text', () => {
    expect(furiganaSegments('学校で話そう。', false)).toEqual([{ text: '学校で話そう。' }]);
  });

  it('covers the request vocabulary while leaving unknown words untouched', () => {
    expect(furiganaSegments('学校で大人に相談して、物語を選ぶ。', true)).toEqual([
      { text: '学校', reading: 'がっこう' },
      { text: 'で' },
      { text: '大人', reading: 'おとな' },
      { text: 'に' },
      { text: '相談', reading: 'そうだん' },
      { text: 'して、' },
      { text: '物語', reading: 'ものがたり' },
      { text: 'を' },
      { text: '選ぶ', reading: 'えらぶ' },
      { text: '。' },
    ]);
  });

  it('uses word readings instead of guessing bare verb characters', () => {
    expect(furiganaSegments('描く、描いた、聞く、話した。', true)).toEqual([
      { text: '描く', reading: 'かく' },
      { text: '、' },
      { text: '描いた', reading: 'かいた' },
      { text: '、' },
      { text: '聞く', reading: 'きく' },
      { text: '、' },
      { text: '話した', reading: 'はなした' },
      { text: '。' },
    ]);
    const unknown = '話、会話、話題、描写、選択、新聞、未知の人名';
    expect(furiganaSegments(unknown, true)).toEqual([{ text: unknown }]);
  });
});

describe('existing local IPADIC readings', () => {
  let tokenize: (text: string) => JapaneseReadingToken[];
  beforeAll(async () => {
    // Use the same locked dictionary that the build copies for the browser worker.
    const require = createRequire(import.meta.url);
    const kuromoji = require('kuromoji') as {
      builder: (options: { dicPath: string }) => {
        build: (
          callback: (error: Error | null, tokenizer: { tokenize: typeof tokenize }) => void,
        ) => void;
      };
    };
    const tokenizer = await new Promise<{ tokenize: typeof tokenize }>((resolve, reject) => {
      kuromoji
        .builder({ dicPath: join(dirname(require.resolve('kuromoji/package.json')), 'dict') })
        .build((error, result) => (error ? reject(error) : resolve(result)));
    });
    tokenize = tokenizer.tokenize.bind(tokenizer);
  });

  it('uses genuine noun/compound readings and never splits them into guessed kanji', () => {
    const text = '話、会話、描写、選択、新聞。';
    const segments = furiganaSegments(text, true, tokenize(text));
    expect(segments.filter((s) => s.reading)).toEqual([
      { text: '話', reading: 'はなし' },
      { text: '会話', reading: 'かいわ' },
      { text: '描写', reading: 'びょうしゃ' },
      { text: '選択', reading: 'せんたく' },
      { text: '新聞', reading: 'しんぶん' },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('preserves whitespace, emoji and the dictionary reading of an inflected verb', () => {
    const text = '\n　絵を描く 🎨';
    const segments = furiganaSegments(text, true, tokenize(text));
    expect(segments.map((s) => s.text).join('')).toBe(text);
    // IPADIC selects the also-valid えがく; do not overwrite parser output with the fallback table.
    expect(segments).toContainEqual({ text: '描く', reading: 'えがく' });
    expect(segments).toContainEqual({ text: '🎨' });
  });

  it('leaves unknown/missing readings, mismatched text and disabled annotation untouched', () => {
    for (const token of [
      { surface_form: '学校', word_type: 'UNKNOWN', reading: 'ガッコウ' },
      { surface_form: '学校', word_type: 'KNOWN', reading: '*' },
      { surface_form: '学校', word_type: 'KNOWN' },
      { surface_form: '学校', word_type: 'KNOWN', reading: '<unsafe>' },
    ])
      expect(furiganaSegments('学校', true, [token])).toEqual([{ text: '学校' }]);
    expect(furiganaSegments('会話', true, tokenize('電話'))).toEqual([{ text: '会話' }]);
    expect(furiganaSegments('会話', false, tokenize('会話'))).toEqual([{ text: '会話' }]);
  });
});
