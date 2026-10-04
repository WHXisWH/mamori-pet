import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // コンテナイメージ（Dockerfile）のビルド時は NEXT_OUTPUT=standalone を設定する。ローカルの next start と e2e には影響しない
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@ijime/api-types', '@ijime/ui'],
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=()' },
      ],
    },
  ],
};

export default nextConfig;
