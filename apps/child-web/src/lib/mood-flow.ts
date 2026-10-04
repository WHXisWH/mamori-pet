import type { Expression, MoodWeather } from '@ijime/api-types';

// 選択は送信ではない。子どもはいつでも選び直せ、確定を押して初めて記録する（押し間違いはリスクシグナルにならない）
export type MoodFlow =
  | { step: 'choosing' }
  | { step: 'picked'; weather: MoodWeather }
  | { step: 'sending'; weather: MoodWeather }
  | { step: 'done'; weather: MoodWeather; reply?: string };

export type MoodEvent =
  | { type: 'pick'; weather: MoodWeather }
  | { type: 'confirm' }
  | { type: 'sent'; reply: string }
  | { type: 'failed' }
  | { type: 'again' };

export function initialMoodFlow(
  todayMood: { date: string; weather: MoodWeather } | null,
  today: string,
): MoodFlow {
  return todayMood?.date === today
    ? { step: 'done', weather: todayMood.weather }
    : { step: 'choosing' };
}

export function moodFlow(state: MoodFlow, event: MoodEvent): MoodFlow {
  switch (event.type) {
    case 'pick':
      return state.step === 'choosing' || state.step === 'picked'
        ? { step: 'picked', weather: event.weather }
        : state;
    case 'confirm':
      return state.step === 'picked' ? { step: 'sending', weather: state.weather } : state;
    case 'sent':
      return state.step === 'sending'
        ? { step: 'done', weather: state.weather, reply: event.reply }
        : state;
    case 'failed':
      return state.step === 'sending' ? { step: 'picked', weather: state.weather } : state;
    case 'again':
      return state.step === 'done' ? { step: 'choosing' } : state;
  }
}

// 雨と雷のときはペットが寄り添い、お祝いはしない
export function moodExpression(state: MoodFlow): Expression {
  if (state.step === 'choosing') return 'caring';
  const w = state.weather;
  if (state.step === 'done')
    return w === 'sunny' ? 'celebrate' : w === 'cloudy' ? 'happy' : 'caring';
  return w === 'sunny' ? 'happy' : w === 'cloudy' ? 'together' : 'caring';
}
