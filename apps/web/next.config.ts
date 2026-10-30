import type { NextConfig } from 'next';

// Every dashboard page is per-user and per-kitchen, so Cache Components stays off:
// pages render on each request with the caller's Supabase session (RLS applies).
const nextConfig: NextConfig = {
  transpilePackages: ['@tiffin/core', '@tiffin/db'],
  // The service worker must always be fetched fresh so updates reach installed apps.
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
