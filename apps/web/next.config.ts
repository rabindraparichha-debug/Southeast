import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { missingLegalEnv } from './src/lib/legal-env.mjs';

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

// A production build for a hosted project must name the operator and the grievance officer's
// contact on the legal pages (D-181); local builds are not checked.
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const missing = missingLegalEnv(process.env);
    if (missing.length) {
      throw new Error(`Set ${missing.join(' and ')} before building for a hosted project (legal pages, docs/DECISIONS.md D-181).`);
    }
  }
  return nextConfig;
}
