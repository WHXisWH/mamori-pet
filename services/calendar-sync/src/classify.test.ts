import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FsKbSource, Kb, contextKeywordsSchema } from '@ijime/kb-loader';
import { beforeAll, describe, expect, it } from 'vitest';

import { createClassifier, linkChildren, normalize, type Classifier } from './classify.js';
import { KEYWORDS_PATH } from './sync.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

let classify: Classifier;
beforeAll(async () => {
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  classify = createClassifier(await kb.yaml(KEYWORDS_PATH, contextKeywordsSchema));
});

describe('normalize', () => {
  it('folds width, katakana and case', () => {
    expect(normalize('ﾃｽﾄ')).toBe('てすと');
    expect(normalize('テスト')).toBe('てすと');
    expect(normalize('ＡＢＣ')).toBe('abc');
  });
});

describe('classify', () => {
  it.each([
    ['期末テスト', 'exam'],
    ['2学期 中間', 'exam'],
    ['全国模試（数学）', 'exam'],
    ['ﾃｽﾄ勉強', 'exam'],
    ['てすと', 'exam'],
    ['夏休み', 'long_vacation'],
    ['冬休み開始', 'long_vacation'],
    ['運動会', 'school_event'],
    ['修学旅行 京都', 'school_event'],
    ['始業式', 'class_change'],
    ['家族旅行', 'travel'],
    ['歯医者', null],
    ['ピアノ', null],
    ['', null],
  ])('%s → %s', (title, expected) => {
    expect(classify(title)).toBe(expected);
  });

  it('takes the first category in kb order', () => {
    expect(classify('修学旅行')).toBe('school_event');
  });
});

describe('linkChildren', () => {
  const kids = [
    { childId: 'c1', nickname: 'はな' },
    { childId: 'c2', nickname: 'ユウ' },
  ];

  it('links only the named child', () => {
    expect(linkChildren('はな 期末テスト', kids)).toEqual(['c1']);
  });

  it('matches nicknames across katakana and hiragana', () => {
    expect(linkChildren('ゆう 運動会', kids)).toEqual(['c2']);
  });

  it('links every child when no nickname appears', () => {
    expect(linkChildren('夏休み', kids)).toEqual(['c1', 'c2']);
  });

  it('ignores empty nicknames', () => {
    expect(linkChildren('期末', [{ childId: 'c3', nickname: '' }, ...kids])).toEqual([
      'c3',
      'c1',
      'c2',
    ]);
  });
});
