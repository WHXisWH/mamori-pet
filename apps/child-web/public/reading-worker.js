/* global importScripts */
importScripts('/readings/kuromoji-0.1.2/build/kuromoji.js');

const ready = new Promise((resolve, reject) => {
  self.kuromoji.builder({ dicPath: '/readings/kuromoji-0.1.2/dict/' }).build((error, tokenizer) => {
    if (error) reject(error);
    else resolve(tokenizer);
  });
});
// A failed download must not become an unhandled rejection before the first request.
ready.catch(() => {});

self.onmessage = async ({ data }) => {
  const { id, text } = data;
  if (!Number.isSafeInteger(id) || typeof text !== 'string') return;
  try {
    const tokenizer = await ready;
    const tokens = tokenizer.tokenize(text).map(({ surface_form, word_type, reading }) => ({
      surface_form,
      word_type,
      reading,
    }));
    self.postMessage({ id, tokens });
  } catch {
    self.postMessage({ id });
  }
};
