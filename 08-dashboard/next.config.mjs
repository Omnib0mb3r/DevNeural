/** @type {import('next').NextConfig} */
const DAEMON = process.env.DEVNEURAL_DAEMON_URL ?? 'http://localhost:3747';

// In production we statically export the dashboard so the daemon can serve it
// from a single port (the same port that handles the API and the cookie). In
// dev we keep the rewrite-proxy pattern.
const PROD = process.env.NODE_ENV === 'production';

const DAEMON_PATHS = [
  'auth',
  'dashboard',
  'sessions',
  'services',
  'projects',
  'reference',
  'reminders',
  'notifications',
  'push',
  'search',
  'upload',
  'graph',
];

const nextConfig = PROD
  ? {
      // Static export, daemon serves 08-dashboard/out/ via @fastify/static.
      // No app-level auth gate: trust is host-binding (localhost / Tailscale).
      output: 'export',
      reactStrictMode: true,
      // Convert dynamic [id] route to a parameterized SPA fallback during
      // export. The page is rendered as a shell that fetches the session
      // by id at runtime.
      trailingSlash: false,
      images: { unoptimized: true },
    }
  : {
      reactStrictMode: true,
      // Single-origin pattern: every daemon endpoint is reachable from the Next dev
      // server through a transparent rewrite. The daemon issues Set-Cookie on its
      // own response; Next passes the header through; the browser stores it on the
      // Next origin (localhost:3000) which means subsequent fetches carry it back.
      async rewrites() {
        return DAEMON_PATHS.flatMap((p) => [
          { source: `/${p}`,        destination: `${DAEMON}/${p}` },
          { source: `/${p}/:path*`, destination: `${DAEMON}/${p}/:path*` },
        ]);
      },
      /* Cross-origin isolation in dev. Production builds are served by
       * the daemon, which sets these headers on every response. In dev
       * Next serves HTML + chunks, so it needs to emit the same set or
       * crossOriginIsolated stays false and ORT falls back to the
       * unthreaded path that OOMs on VAD remount. */
      async headers() {
        return [
          {
            source: '/:path*',
            headers: [
              { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
              { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
              { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
            ],
          },
        ];
      },
    };

export default nextConfig;
