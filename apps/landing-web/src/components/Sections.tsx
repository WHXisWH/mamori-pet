import { PetAvatar, RuleCard, WeatherIcon } from '@ijime/ui';
import type { ReactNode } from 'react';

import { Reveal } from './Reveal';

export function Kicker({
  children,
  tone = 'text-calm-deep',
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <p className={`flex items-center gap-3 font-display text-xs tracking-[0.45em] ${tone}`}>
      <span aria-hidden="true" className="h-px w-8 bg-current opacity-60" />
      {children}
    </p>
  );
}

function SectionHead({
  kicker,
  title,
  lead,
  id,
}: {
  kicker: string;
  title: ReactNode;
  lead?: ReactNode;
  id: string;
}) {
  return (
    <Reveal>
      <Kicker>{kicker}</Kicker>
      <h2
        id={id}
        className="phrase mt-4 font-display text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.3] font-bold"
      >
        {title}
      </h2>
      {lead && (
        <p className="phrase mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">{lead}</p>
      )}
    </Reveal>
  );
}

const WAYS = [
  {
    title: '文字でおしゃべり',
    body: '思いついたことを、そのまま。ペットの返事は短く、ゆっくり。',
    icon: '💬',
  },
  {
    title: '声で話す',
    body: 'ボタンを1回押すだけ。ペットの話を、いつでもさえぎっていい。録音は残しません。',
    icon: '🎙️',
  },
  {
    title: '心の天気',
    body: '晴れ・くもり・雨・雷。1回タップで、今日の気分。',
    icon: 'weather',
  },
  {
    title: '絵をかく',
    body: '「いまの自分」や、ペットが出す「お話の続き」を描いて、聞かせる。上手下手は関係ありません。',
    icon: '🖍️',
  },
  {
    title: '島をつくる',
    body: 'ペットの島に、どうぶつや家を置いて、お話をつくる。「これがわたし」を決めるのは、子ども自身。',
    icon: '🏝️',
  },
  {
    title: '「おかえり」',
    body: '帰ってきてアプリを開くと、ペットが「おかえり」。家の場所は、子どもの端末の中だけにあります。',
    icon: '🏠',
  },
];

export function Ways() {
  return (
    <section id="ways" className="py-24" aria-labelledby="ways-title">
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <SectionHead
          id="ways-title"
          kicker="HOW TO PLAY"
          title="あそび方は、その日の気分で。"
          lead="話したい日も、描きたい日も、なにもしたくない日も。どれもテストではなく、ペットとのいつもの遊びです。"
        />
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {WAYS.map((w, i) => (
            <Reveal as="li" key={w.title} delayMs={i * 60}>
              <div className="h-full rounded-card bg-white p-6 shadow-soft">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-cream text-3xl">
                  {w.icon === 'weather' ? (
                    <WeatherIcon weather="sunny" size={40} />
                  ) : (
                    <span aria-hidden="true">{w.icon}</span>
                  )}
                </div>
                <h3 className="mt-4 font-display text-xl font-bold">{w.title}</h3>
                <p className="mt-2 leading-relaxed text-ink-soft">{w.body}</p>
              </div>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Guardians() {
  const visible = [
    '毎週の元気度（気分の傾向、使った日数、夜遅くの利用）',
    '子どもが同意した「ひとことの要約」つきのお知らせ',
    '内容を含まない「気にかけてあげて」のお知らせ',
    '緊急のお知らせと、その時にすべきこと',
  ];
  const hidden = [
    '会話の原文、声',
    '子どもが同意していない具体的な内容',
    'ペットが覚えていること',
    '一回一回のチャットの時間',
  ];
  return (
    <section id="guardians" className="bg-white py-24" aria-labelledby="guardians-title">
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <SectionHead
          id="guardians-title"
          kicker="FOR GUARDIANS"
          title="保護者に届くのは、「ちょうどいい」だけ。"
          lead="子どもにとっては、ふつうの電子ペット。保護者に届くのは、見守るために必要な傾向と声のかけ方だけです。会話の原文は、誰にも見えません。"
        />
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <Reveal>
            <div className="h-full rounded-card border-2 border-leaf/40 bg-leaf/5 p-6">
              <h3 className="font-display text-xl font-bold text-leaf-deep">見えるもの</h3>
              <ul className="mt-4 space-y-3">
                {visible.map((v) => (
                  <li key={v} className="flex gap-3">
                    <span aria-hidden="true" className="text-leaf-deep">
                      ○
                    </span>
                    <span>{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delayMs={120}>
            <div className="h-full rounded-card border-2 border-ink/10 bg-cream p-6">
              <h3 className="font-display text-xl font-bold text-ink-soft">見えないもの</h3>
              <ul className="mt-4 space-y-3">
                {hidden.map((v) => (
                  <li key={v} className="flex gap-3">
                    <span aria-hidden="true" className="text-ink-soft">
                      ×
                    </span>
                    <span>{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
        <Reveal delayMs={200}>
          <div className="mt-8 rounded-card bg-cream-deep/60 p-6">
            <p className="font-display text-lg font-bold">お知らせの例</p>
            <blockquote className="mt-3 space-y-2 border-l-4 border-calm pl-4 leading-relaxed text-ink-soft">
              <p className="font-bold text-ink">最近、〇〇さんに少し元気のない日が続いています</p>
              <p>
                この1週間、寝る前のおしゃべりで、疲れや寂しさを表す言葉がいつもより多く見られました。
              </p>
              <p>声かけの例：「最近どう？なんでも聞くよ」</p>
              <p>避けたいこと：問い詰める、すぐに学校へ電話する</p>
            </blockquote>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const LEVELS = [
  { level: 'L0', name: '平常', child: 'ふだんの おしゃべり', guardian: '週の元気度だけ' },
  { level: 'L1', name: '関心', child: 'ペットの声かけが少し増える', guardian: '通知なし' },
  {
    level: 'L2',
    name: '注意',
    child: '「おうちの人に話す？」と相談',
    guardian: '子どもが同意したら「多めに一緒にいてあげて」',
  },
  {
    level: 'L3',
    name: '警戒',
    child: '「これは大人の助けがいる」と伝える',
    guardian: '原則は同意の上。断られたら内容なしの通知',
  },
  {
    level: 'L4',
    name: '危機',
    child: 'すぐに相談窓口を表示',
    guardian: '即時に通知（同意は前提にしない）',
  },
];

export function Safety() {
  return (
    <section
      id="safety"
      data-watch
      className="relative overflow-hidden bg-night text-[#e9e6df]"
      aria-labelledby="safety-title"
    >
      <div
        aria-hidden="true"
        className="h-[18vh] bg-[linear-gradient(to_bottom,#ffffff,transparent)]"
      />
      <div
        aria-hidden="true"
        className="stars animate-drift pointer-events-none absolute inset-0 opacity-40"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_80%_40%,rgba(120,140,255,0.16),transparent_70%)]"
      />
      <div className="relative mx-auto max-w-6xl px-4 pt-6 pb-24 md:px-8">
        <Reveal>
          <Kicker tone="text-hoshi-deep">FOR GUARDIANS · もしものとき</Kicker>
          <h2
            id="safety-title"
            className="phrase mt-4 font-display text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.3] font-bold"
          >
            もしものときは、決まった手順で。
          </h2>
          <p className="phrase mt-5 max-w-2xl text-lg leading-relaxed opacity-80">
            ふだんは、ただの電子ペットです。そのうえで、元気のない日が続いたときや、命にかかわる言葉が出たときのために、専門家が確認した5段階の規則が裏で動いています。判定するのは
            AI の気分ではなく規則で、AI は規則を読むことはできても、書き換えることはできません。
          </p>
        </Reveal>
        <div className="mt-10 grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
          <ol className="space-y-3">
            {LEVELS.map((l, i) => (
              <Reveal as="li" key={l.level} delayMs={i * 70}>
                <div
                  className={`grid gap-2 rounded-2xl p-4 md:grid-cols-[4rem_1fr_1fr] md:items-center ${
                    i === 4 ? 'bg-hoshi-deep/15 ring-2 ring-hoshi-deep/60' : 'bg-night-soft'
                  }`}
                >
                  <div className="font-display text-xl font-bold text-hoshi-deep">
                    {l.level} <span className="text-sm opacity-80">{l.name}</span>
                  </div>
                  <div className="text-sm opacity-90">子ども側：{l.child}</div>
                  <div className="text-sm opacity-90">保護者側：{l.guardian}</div>
                </div>
              </Reveal>
            ))}
          </ol>
          <Reveal delayMs={200}>
            <div className="mx-auto max-w-xs text-center">
              <PetAvatar characterId="hoshi" expression="caring" size={220} />
              <p className="mt-4 text-sm leading-relaxed opacity-80">
                このサービスは緊急通報サービスではありません。命や体に危険があるときは、119 または
                110 へ。
              </p>
            </div>
          </Reveal>
        </div>
      </div>
      <div
        aria-hidden="true"
        className="h-[16vh] bg-[linear-gradient(to_top,var(--color-cream),transparent)]"
      />
    </section>
  );
}

export function Promise() {
  return (
    <section id="promise" className="py-24" aria-labelledby="promise-title">
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <SectionHead
          id="promise-title"
          kicker="THE PROMISE"
          title="子どもに、さいしょに見せるカード。"
          lead="何が見えて、何を伝えるのか。秘密のルールにはしません。学年に合わせた言葉で、同じ5つの約束を最初に伝えます。"
        />
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <Reveal>
            <RuleCard gradeBand="low" />
          </Reveal>
          <Reveal delayMs={120}>
            <RuleCard gradeBand="jhs" />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const TECH = [
  { name: 'Google ADK', note: 'ペットはツールを自分で選ぶ、本物のエージェント' },
  { name: 'Gemini on Vertex AI', note: '会話・信号抽出・危機の再確認' },
  { name: 'Gemini Live API', note: '声色までわかる、さえぎれる音声対話' },
  { name: 'Firestore + Cloud KMS', note: '会話は子どもごとの鍵で暗号化' },
  { name: 'BigQuery ML', note: '本人の「いつも」からのずれを検知' },
  { name: 'asia-northeast1', note: 'データは東京から出ない' },
];

export function Tech() {
  return (
    <section className="bg-white py-20" aria-labelledby="tech-title">
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <Reveal>
          <Kicker>BUILT ON GOOGLE CLOUD</Kicker>
          <h2
            id="tech-title"
            className="phrase mt-4 font-display text-2xl leading-[1.35] font-bold md:text-3xl"
          >
            会話は AI エージェント。判定は規則。データは東京。
          </h2>
        </Reveal>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TECH.map((t, i) => (
            <Reveal as="li" key={t.name} delayMs={i * 50}>
              <div className="rounded-2xl border border-cream-deep p-4">
                <p className="font-bold">{t.name}</p>
                <p className="mt-1 text-sm text-ink-soft">{t.note}</p>
              </div>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
