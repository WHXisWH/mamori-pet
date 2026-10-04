'use client';

import type { CharacterId, Expression } from '@ijime/api-types';
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';

import { SceneBubble, Subtitle } from './cinema/Bubble';
import { DustMotes } from './cinema/DustMotes';
import { HallwayScene, RoomScene, type PetPlacement } from './cinema/scenes';
import { StageVideo } from './cinema/StageVideo';
import { FRAME_SHOTS, type MediaMap } from '@/lib/media-shared';

export type StoryFrame = {
  id: string;
  characterId: CharacterId;
  expression: Expression;
  kicker: string;
  title: string;
  body: string;
  bubble?: string;
  night?: boolean;
};

export const STORY_FRAMES: StoryFrame[] = [
  {
    id: 'morning',
    characterId: 'togemaru',
    expression: 'happy',
    kicker: '01',
    title: '朝の「おはよう」から。',
    body: '起きたら、今日の気分を天気でひとつ選ぶだけ。「くもり」の日も、それでいい。ペットはいつもの調子で待っています。',
    bubble: 'おはよ。きょうの こころの てんきは？',
  },
  {
    id: 'afterschool',
    characterId: 'moko',
    expression: 'happy',
    kicker: '02',
    title: '「ただいま」に、「おかえり」。',
    body: 'ランドセルを置いてアプリを開くと、ペットが「おかえり」と迎えます。家の場所は、子どもの端末の中にしか残りません。',
    bubble: 'おかえり！ きょうは なに してた？',
  },
  {
    id: 'chatter',
    characterId: 'pokke',
    expression: 'together',
    kicker: '03',
    title: 'オチのない話も、ぜんぶ聞く。',
    body: '給食のこと、ゲームのこと、好きな動画のこと。話がまとまっていなくても大丈夫。絵をかいたり、島をつくったりもできます。',
    bubble: 'それで それで？ つづき ききたい！',
  },
  {
    id: 'family',
    characterId: 'nami',
    expression: 'caring',
    kicker: '04',
    title: 'ごはんの時間は、いってらっしゃい。',
    body: 'ペットは、長く引き止めません。家族や友だちとの時間がいちばん。おうちの人に話したいことがある日は、話す練習にも付き合います。',
    bubble: 'いってらっしゃい。あとで きかせてね。',
  },
  {
    id: 'night',
    characterId: 'hoshi',
    expression: 'caring',
    kicker: '05',
    title: 'おやすみの前に、ひとつだけ。',
    body: '一日のおわりに「よかったこと」をひとつ。ねむれない夜も、となりにいます。23時をすぎたら「そろそろ寝よっか」。',
    bubble: 'きょう、ひとつ よかったこと、ある？',
    night: true,
  },
];

const FOCUS: Record<string, [string, string]> = {
  morning: ['62%', '72%'],
  afterschool: ['62%', '72%'],
  chatter: ['60%', '76%'],
  family: ['58%', '66%'],
  night: ['58%', '56%'],
};

type Staging = {
  spot: Omit<PetPlacement, 'characterId' | 'expression' | 'testId'>;
  depth: number;
};

const STAGING: Record<string, Staging> = {
  morning: {
    spot: { x: 1000, y: 700, size: 220, mobile: { x: 800, y: 742, size: 200 } },
    depth: 0.45,
  },
  afterschool: {
    spot: { x: 1000, y: 700, size: 230, mobile: { x: 800, y: 742, size: 206 } },
    depth: 0.45,
  },
  chatter: {
    spot: { x: 1010, y: 704, size: 230, mobile: { x: 884, y: 742, size: 190 } },
    depth: 0.45,
  },
  family: {
    spot: { x: 1060, y: 772, size: 180, mobile: { x: 892, y: 772, size: 160 } },
    depth: 0.5,
  },
  night: {
    spot: { x: 950, y: 512, size: 170, mobile: { x: 800, y: 742, size: 196 } },
    depth: 0.12,
  },
};

function petFor(f: StoryFrame, active: boolean): PetPlacement {
  return {
    ...STAGING[f.id]!.spot,
    characterId: f.characterId,
    expression: f.expression,
    testId: active ? 'story-avatar' : undefined,
  };
}

function sceneFor(f: StoryFrame, active: boolean): ReactElement {
  const pet = petFor(f, active);
  switch (f.id) {
    case 'morning':
      return <RoomScene uid="s-morning" time="morning" pet={pet} />;
    case 'afterschool':
      return <RoomScene uid="s-afterschool" time="afternoon" randoseruOnFloor pet={pet} />;
    case 'chatter':
      return <RoomScene uid="s-chatter" time="evening" tablet pet={pet} />;
    case 'family':
      return <HallwayScene uid="s-family" pet={pet} />;
    default:
      return <RoomScene uid="s-night" time="night" pet={pet} />;
  }
}

function stageState(isActive: boolean, isPrev: boolean): string {
  if (isActive) return 'is-rolling z-[2] animate-[scene-in_1.2s_ease_both]';
  if (isPrev) return 'is-rolling z-[1] animate-[scene-out_1.2s_ease_both]';
  return 'hidden';
}

function focusVars(id: string): CSSProperties {
  const [fx, fy] = FOCUS[id]!;
  return { ['--fx' as string]: fx, ['--fy' as string]: fy };
}

export function Story({ media = {} }: { media?: MediaMap }) {
  const [active, setActive] = useState(0);
  const [prev, setPrev] = useState<number | null>(null);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const activeRef = useRef(0);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const idx = Number((e.target as HTMLElement).dataset['index']);
          if (Number.isNaN(idx) || idx === activeRef.current) continue;
          setPrev(activeRef.current);
          activeRef.current = idx;
          setActive(idx);
        }
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    );
    for (const el of refs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (prev === null) return;
    const t = setTimeout(() => setPrev(null), 1300);
    return () => clearTimeout(t);
  }, [prev, active]);

  const frame = STORY_FRAMES[active]!;
  const night = frame.night === true;

  return (
    <section
      id="story"
      aria-label="まもりペットのいる一日"
      data-active-frame={frame.id}
      data-watch
      className={`relative ${night ? 'bg-night' : 'bg-film'} text-[#f6f0e6]`}
    >
      <div className="letterbox is-framed sticky top-0 h-[100svh] overflow-hidden">
        {STORY_FRAMES.map((f, i) => {
          const isActive = i === active;
          const isPrev = i === prev;
          const video = media[FRAME_SHOTS[f.id]!];
          return (
            <div
              key={f.id}
              aria-hidden={!isActive}
              className={`absolute inset-0 ${stageState(isActive, isPrev)}`}
              style={focusVars(f.id)}
            >
              <div className="camera">
                {video ? (
                  <StageVideo src={video.src} poster={video.poster} active={isActive} />
                ) : (
                  <div data-media="scene" className="absolute inset-0">
                    {sceneFor(f, isActive)}
                  </div>
                )}
              </div>
              {(f.id === 'morning' || f.id === 'afterschool' || f.id === 'chatter') && (
                <DustMotes count={50} />
              )}
              {f.id === 'night' && <DustMotes count={24} color="190, 208, 255" />}
            </div>
          );
        })}
        <div aria-hidden="true" className="vignette absolute inset-0 z-[3]" />
        <div
          aria-hidden="true"
          className="absolute inset-0 z-[3] bg-[linear-gradient(to_bottom,rgba(14,15,20,0.84)_0%,rgba(14,15,20,0.6)_40%,transparent_62%)] md:bg-[linear-gradient(95deg,rgba(14,15,20,0.8)_0%,rgba(14,15,20,0.45)_34%,transparent_58%)]"
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[5]">
          {STORY_FRAMES.map((f, i) => {
            const isActive = i === active;
            const isPrev = i === prev;
            if (!f.bubble || (!isActive && !isPrev)) return null;
            const testId = isActive ? 'story-bubble' : undefined;
            if (media[FRAME_SHOTS[f.id]!]) {
              return isActive ? <Subtitle key={f.id} text={f.bubble} testId={testId} /> : null;
            }
            return (
              <div
                key={f.id}
                className={`absolute inset-0 ${stageState(isActive, isPrev)}`}
                style={focusVars(f.id)}
              >
                <div className="camera">
                  <SceneBubble
                    text={f.bubble}
                    pet={petFor(f, false)}
                    depth={STAGING[f.id]!.depth}
                    testId={testId}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="absolute bottom-[calc(var(--bar)+16px)] left-5 z-[25] flex items-center gap-3 font-display text-sm tracking-[0.3em] text-[#f6f0e6]/85 md:right-10 md:left-auto">
          <span>{frame.kicker}</span>
          <span className="h-px w-10 bg-[#f6f0e6]/40" />
          <span className="text-[#f6f0e6]/50">0{STORY_FRAMES.length}</span>
        </div>
        <ol
          aria-hidden="true"
          className="absolute top-1/2 left-4 z-[25] hidden -translate-y-1/2 flex-col gap-3 md:flex"
        >
          {STORY_FRAMES.map((f, i) => (
            <li
              key={f.id}
              className={`w-px rounded-full transition-all duration-700 ${i === active ? 'h-10 bg-[#f6f0e6]' : 'h-4 bg-[#f6f0e6]/30'}`}
            />
          ))}
        </ol>
      </div>

      <div className="relative z-10 -mt-[100svh]">
        {STORY_FRAMES.map((f, i) => (
          <article
            key={f.id}
            data-index={i}
            data-frame={f.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="flex h-[115svh] items-start px-5 pt-[calc(var(--bar-h)+72px)] md:items-center md:px-10 md:pt-0"
          >
            <div
              className={`mx-auto w-full max-w-6xl transition-all duration-700 ${i === active ? 'opacity-100 blur-0' : 'opacity-0 blur-sm'}`}
            >
              <div className="max-w-md md:max-w-[34rem]">
                <p className="flex items-center gap-3 font-display text-xs tracking-[0.5em] text-[#f6f0e6]/70">
                  <span aria-hidden="true" className="h-px w-8 bg-[#f6f0e6]/50" />
                  CHAPTER {f.kicker}
                </p>
                <h2 className="phrase mt-4 font-display text-[clamp(1.6rem,3.3vw,2.8rem)] leading-[1.4] font-bold [text-shadow:0_2px_20px_rgba(0,0,0,0.45)]">
                  {f.title}
                </h2>
                <p className="phrase mt-5 text-[15px] leading-[1.9] text-[#f6f0e6]/85 md:text-lg [text-shadow:0_1px_12px_rgba(0,0,0,0.5)]">
                  {f.body}
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
