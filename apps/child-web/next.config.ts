import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@ijime/api-types', '@ijime/kb-loader'],
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(), geolocation=(self), microphone=(self)' },
      ],
    },
    {
      source: '/sw.js',
      headers: [
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Service-Worker-Allowed', value: '/' },
      ],
    },
  ],
};

export default nextConfig;
