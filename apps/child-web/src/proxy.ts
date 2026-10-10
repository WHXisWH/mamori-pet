import { NextResponse, type NextRequest } from 'next/server';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8080';
const VOICE_WS_URL = process.env.NEXT_PUBLIC_VOICE_WS_URL ?? 'ws://localhost:8083';
const isDev = process.env.NODE_ENV === 'development';

export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${API_BASE_URL} ${VOICE_WS_URL} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseappcheck.googleapis.com https://recaptchaenterprise.googleapis.com https://www.google.com https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com`,
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        '/((?!_next/static|_next/image|sw\\.js|reading-worker\\.js|readings/|manifest\\.webmanifest|icons/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
