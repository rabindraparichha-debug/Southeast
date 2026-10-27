import type { NextConfig } from 'next';

// Every dashboard page is per-user and per-kitchen, so Cache Components stays off:
// pages render on each request with the caller's Supabase session (RLS applies).
const nextConfig: NextConfig = {
  transpilePackages: ['@tiffin/core', '@tiffin/db'],
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
