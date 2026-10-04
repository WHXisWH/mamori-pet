// Remote browser voices may transmit text to an unknown provider. Never fall back
// to them for children's replies; absence of a local Japanese voice is explicit.
export function readLocally(
  text: string,
  speech: SpeechSynthesis,
  create: (text: string) => SpeechSynthesisUtterance = (value) =>
    new SpeechSynthesisUtterance(value),
): boolean {
  try {
    speech.cancel();
    const voice = speech
      .getVoices()
      .find((candidate) => candidate.localService && /^ja(?:-|_)/i.test(candidate.lang));
    if (!voice || !text.trim()) return false;
    const utterance = create(text);
    utterance.voice = voice;
    utterance.lang = 'ja-JP';
    utterance.rate = 0.9;
    speech.speak(utterance);
    return true;
  } catch {
    return false;
  }
}
