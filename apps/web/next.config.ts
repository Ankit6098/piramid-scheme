import path from 'node:path';
import type { NextConfig } from 'next';

/** Monorepo root (pnpm workspace) — used for Turbopack resolution and standalone file tracing. */
const workspaceRoot = path.join(__dirname, '../..');

/**
 * Where the browser-facing `/api/*` requests are forwarded when they reach Next.js directly
 * (local dev, or `next start` without nginx). In production nginx routes `/api` to the API before
 * Next.js sees it, so this rewrite is only a fallback. Evaluated at build/start time.
 */
const apiInternalUrl = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(
  /\/+$/,
  '',
);

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
  poweredByHeader: false,
  reactStrictMode: true,

  // @app/shared is a workspace package (CJS build in packages/shared/dist). Transpiling it keeps
  // client/server bundling identical regardless of how pnpm links it.
  transpilePackages: ['@app/shared'],

  // Cache Components (+ Partial Prefetching) are OFF. The app never used `"use cache"`: every page is
  // a client shell that loads session data with TanStack Query, so the static prerender gives the
  // same result. With them on, ~4% of full page loads under load stayed on the loading skeleton
  // (an out-of-order streamed Suspense boundary revealed but never hydrated — React 19.3 /
  // Next 16.4). Re-evaluate after upgrading React/Next. See docs/frontend.md ("Rendering model").
  cacheComponents: false,
  partialPrefetching: false,

  turbopack: {
    root: workspaceRoot,
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },

  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
