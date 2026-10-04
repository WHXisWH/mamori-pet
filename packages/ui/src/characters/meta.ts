import type { CharacterId } from '@ijime/api-types';

export type CharacterMeta = {
  id: CharacterId;
  displayName: string;
  archetype: string;
  tagline: string;
  personality: string;
  goodFor: string;
  main: string;
  sub: string;
  cssVar: string;
};

export const CHARACTER_META: Record<CharacterId, CharacterMeta> = {
  moko: {
    id: 'moko',
    displayName: 'もこ',
    archetype: 'くものひつじ',
    tagline: 'もこは ここに いるよ',
    personality: 'おっとりしていて、聞き上手。短い言葉で、ゆっくり話す。',
    goodFor: '話すのがちょっと苦手な子に',
    main: '#fbe9ec',
    sub: '#f2b8c6',
    cssVar: '--color-moko',
  },
  pokke: {
    id: 'pokke',
    displayName: 'ぽっけ',
    archetype: 'こぎつね',
    tagline: 'それで、それで？',
    personality: '元気で好奇心いっぱい。「それでどうなった？」が口ぐせ。',
    goodFor: 'おしゃべりが好きな子に',
    main: '#f6a96b',
    sub: '#fff1e0',
    cssVar: '--color-pokke',
  },
  togemaru: {
    id: 'togemaru',
    displayName: 'トゲまる',
    archetype: 'ハリネズミ',
    tagline: 'ちかづかれたくない日も、あるよね',
    personality: 'ちょっと不器用で、自分にツッコミを入れる。「近づいてほしくない気持ち」がわかる。',
    goodFor: '気持ちが爆発しちゃう子、素直に言えない子に',
    main: '#f3c96b',
    sub: '#8a5a3c',
    cssVar: '--color-togemaru',
  },
  nami: {
    id: 'nami',
    displayName: 'なみ',
    archetype: 'ラッコ',
    tagline: 'きみが決めていい',
    personality: '落ち着いていて頼れるお兄さん・お姉さん。対等に話し、説教しない。',
    goodFor: '子ども扱いされたくない中学生に',
    main: '#2f5f8f',
    sub: '#9fd9c8',
    cssVar: '--color-nami',
  },
  hoshi: {
    id: 'hoshi',
    displayName: 'ほし',
    archetype: 'フクロウ',
    tagline: 'ねむれない夜も、いっしょ',
    personality: '静かな夜の見守り役。寝る前の時間を、そっと一緒に過ごす。',
    goodFor: '夜に考えすぎてしまう子に',
    main: '#2b3557',
    sub: '#f1c76b',
    cssVar: '--color-hoshi',
  },
  hidden: {
    id: 'hidden',
    displayName: '？',
    archetype: 'ふしぎなたまご',
    tagline: 'なにが うまれるかな',
    personality: '見た目も性格も、たまごから生まれるまでわからない。',
    goodFor: 'サプライズが好きな子に',
    main: '#efe6d6',
    sub: '#c9b8d9',
    cssVar: '--color-hidden',
  },
};

export const SELECTABLE_CHARACTERS: CharacterId[] = ['moko', 'pokke', 'togemaru', 'nami', 'hoshi'];
