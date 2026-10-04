import { Shippori_Mincho, Zen_Maru_Gothic } from 'next/font/google';

export const mincho = Shippori_Mincho({
  weight: ['500', '700'],
  display: 'swap',
  preload: false,
  variable: '--font-mincho',
});

export const maru = Zen_Maru_Gothic({
  weight: ['400', '500', '700'],
  display: 'swap',
  preload: false,
  variable: '--font-maru',
});
