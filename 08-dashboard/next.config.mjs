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
  'stats',
  'lex',
  'admin',
  'pty',
];

// Prefixes that also carry an app-router page route (app/sessions/page.tsx,
// app/projects/page.tsx, app/reminders/page.tsx). The default array-form
// rewrite (equivalent to Next's "afterFiles" phase) only runs after the
// filesystem/page match has already been resolved, so a plain afterFiles
// rule for these exact paths never fires: the page wins and a fetch() to
// e.g. GET /sessions gets the page's HTML instead of the daemon's JSON.
// These get dedicated beforeFiles rules below, gated to JSON-only requests
// so browser navigation to the page keeps working untouched.
const COLLIDING_PATHS = ['sessions', 'projects', 'reminders'];

// Matches only fetch()/XHR calls that declare they want JSON back (see
// lib/daemon-client.ts request(), which always sends this header). Browser
// navigation requests send `Accept: text/html,...` and fall through to the
// normal page/dynamic-route resolution.
const JSON_ONLY_HAS = [
  { type: 'header', key: 'accept', value: '.*application/json.*' },
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
        return {
          // beforeFiles rules take priority over page/static-file resolution
          // even on an exact-path match, which is exactly what's needed to
          // unblock JSON fetches to paths that double as page routes.
          beforeFiles: COLLIDING_PATHS.flatMap((p) => [
            { source: `/${p}`,        destination: `${DAEMON}/${p}`,        has: JSON_ONLY_HAS },
            { source: `/${p}/:path*`, destination: `${DAEMON}/${p}/:path*`, has: JSON_ONLY_HAS },
          ]),
          // Original behavior, preserved for EVERY prefix including the
          // colliding ones: afterFiles only loses to an actual page match,
          // so deep non-page paths under a colliding prefix (WebSocket
          // upgrades like /sessions/:id/terminal-ws, SSE, binary fetches
          // that do not send an application/json Accept header) still
          // proxy exactly as they did with the old array-form config.
          afterFiles: DAEMON_PATHS.flatMap((p) => [
            { source: `/${p}`,        destination: `${DAEMON}/${p}` },
            { source: `/${p}/:path*`, destination: `${DAEMON}/${p}/:path*` },
          ]),
          fallback: [],
        };
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
