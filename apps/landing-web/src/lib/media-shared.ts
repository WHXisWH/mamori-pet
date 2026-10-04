export const SHOT_IDS = ['s0', 's1', 's2', 's3', 's4', 's5'] as const;
export type ShotId = (typeof SHOT_IDS)[number];

export type MediaSource = { src: string; poster?: string };
export type MediaMap = Partial<Record<ShotId, MediaSource>>;

export const FRAME_SHOTS: Record<string, ShotId> = {
  hero: 's0',
  morning: 's1',
  afterschool: 's2',
  chatter: 's3',
  family: 's4',
  night: 's5',
};

export function resolveMedia(files: readonly string[]): MediaMap {
  const out: MediaMap = {};
  for (const id of SHOT_IDS) {
    const video =
      files.find((f) => f.startsWith(`${id}-`) && /\.(mp4|webm)$/i.test(f)) ??
      files.find((f) => new RegExp(`^${id}\\.(mp4|webm)$`, 'i').test(f));
    if (!video) continue;
    const stem = video.replace(/\.(mp4|webm)$/i, '');
    const poster = files.find((f) => f.startsWith(stem) && /\.(jpe?g|png|webp)$/i.test(f));
    out[id] = poster
      ? { src: `/video/${video}`, poster: `/video/${poster}` }
      : { src: `/video/${video}` };
  }
  return out;
}
