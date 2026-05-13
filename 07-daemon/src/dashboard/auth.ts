/**
 * PIN authentication for the dashboard.
 *
 * Tailscale is the network perimeter. PIN is the per-person guard
 * (someone picks up your unlocked phone). Bcrypt-hashed PIN stored at
 * c:/dev/data/skill-connections/dashboard/auth.json. Successful unlock
 * issues a signed session cookie. Lockout after 5 wrong PINs in 60s.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DATA_ROOT, ensureDir } from '../paths.js';

const DASHBOARD_DIR = path.posix.join(DATA_ROOT, 'dashboard');
const AUTH_FILE = path.posix.join(DASHBOARD_DIR, 'auth.json');
const COOKIE_NAME = 'dn_session';
const COOKIE_MAX_AGE_S = 12 * 60 * 60; // 12h
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 60 * 1000;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;

interface AuthState {
  version: 1;
  pin_hash: string | null;
  secret: string;
  failures: { ts: number }[];
  locked_until: number;
}

function defaultState(): AuthState {
  return {
    version: 1,
    pin_hash: null,
    secret: crypto.randomBytes(32).toString('hex'),
    failures: [],
    locked_until: 0,
  };
}

function load(): AuthState {
  ensureDir(DASHBOARD_DIR);
  if (!fs.existsSync(AUTH_FILE)) {
    const fresh = defaultState();
    save(fresh);
    return fresh;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')) as AuthState;
    if (parsed.version !== 1) return defaultState();
    return parsed;
  } catch {
    return defaultState();
  }
}

function save(state: AuthState): void {
  ensureDir(DASHBOARD_DIR);
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function isPinSet(): boolean {
  return load().pin_hash !== null;
}

export async function setPin(pin: string): Promise<void> {
  if (!/^\d{4,8}$/.test(pin)) {
    throw new Error('PIN must be 4-8 digits');
  }
  const state = load();
  state.pin_hash = await bcrypt.hash(pin, 10);
  state.failures = [];
  state.locked_until = 0;
  save(state);
}

interface UnlockResult {
  ok: boolean;
  reason?: 'no_pin_set' | 'locked' | 'wrong_pin' | 'invalid_format';
  retry_after_ms?: number;
}

export async function tryUnlock(pin: string): Promise<UnlockResult & { token?: string }> {
  const state = load();
  if (!state.pin_hash) return { ok: false, reason: 'no_pin_set' };

  const now = Date.now();
  if (state.locked_until > now) {
    return {
      ok: false,
      reason: 'locked',
      retry_after_ms: state.locked_until - now,
    };
  }

  if (!/^\d{4,8}$/.test(pin)) {
    return { ok: false, reason: 'invalid_format' };
  }

  const match = await bcrypt.compare(pin, state.pin_hash);
  if (!match) {
    state.failures = state.failures.filter((f) => now - f.ts < LOCKOUT_WINDOW_MS);
    state.failures.push({ ts: now });
    if (state.failures.length >= LOCKOUT_THRESHOLD) {
      state.locked_until = now + LOCKOUT_DURATION_MS;
      state.failures = [];
    }
    save(state);
    return { ok: false, reason: 'wrong_pin' };
  }

  state.failures = [];
  state.locked_until = 0;
  save(state);

  const token = signToken(state.secret, now + COOKIE_MAX_AGE_S * 1000);
  return { ok: true, token };
}

export function lockSession(): void {
  /* nothing server-side; client clears cookie */
}

/**
 * Returns the raw HMAC secret from auth.json so other modules (e.g.
 * cross-session injection) can derive their own keyed MACs without
 * duplicating the file-load logic.  Empty string when auth not yet set up.
 */
export function getAuthSecret(): string {
  try {
    return load().secret;
  } catch {
    return '';
  }
}

export function regenerateSecret(): void {
  const state = load();
  state.secret = crypto.randomBytes(32).toString('hex');
  save(state);
}

interface TokenPayload {
  exp: number;
}

function signToken(secret: string, exp: number): string {
  const payload: TokenPayload = { exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const state = load();
  const expected = crypto
    .createHmac('sha256', state.secret)
    .update(body)
    .digest('base64url');
  if (sig !== expected) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf-8'),
    ) as TokenPayload;
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * API path prefixes that require the dn_session cookie. Everything else
 * (HTML pages, static assets, _next chunks) is public — the dashboard
 * pages render unconditionally and detect 401s on API calls to redirect
 * to /unlock client-side. This keeps the auth model simple: the cookie
 * is only checked at the API surface, not at the page-render surface.
 */
const PROTECTED_API_PREFIXES = [
  '/dashboard/',
  '/sessions',
  '/services',
  '/projects',
  '/reference',
  '/reminders',
  '/notifications',
  '/push',
  '/search',
  '/upload',
  '/graph',
];

function isProtectedApi(url: string): boolean {
  // Strip query string for the prefix match
  const path = url.split('?')[0] ?? '/';
  return PROTECTED_API_PREFIXES.some(
    (p) => path === p.replace(/\/$/, '') || path.startsWith(p),
  );
}

/* Hosts that count as the local machine for the purposes of the
 * /sessions loopback bypass below. IPv4 and IPv6 loopback only.
 * Fastify reports IPv4-mapped IPv6 as `::ffff:127.0.0.1` so that
 * shape needs to round-trip too. */
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

function isLoopbackRequest(req: FastifyRequest): boolean {
  const ip = req.ip ?? '';
  if (LOOPBACK_HOSTS.has(ip)) return true;
  /* Fastify under Node 22+ occasionally surfaces the socket address
   * as a hostname rather than the numeric ip; fall through to the
   * socket itself when req.ip is empty or non-loopback. */
  const socket = (req as FastifyRequest & {
    socket?: { remoteAddress?: string | null };
  }).socket;
  const sockAddr = socket?.remoteAddress ?? '';
  return LOOPBACK_HOSTS.has(sockAddr);
}

export function authMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const url = req.url;

  // Always-public paths.
  if (
    url.startsWith('/auth/') ||
    url === '/health'
  ) {
    done();
    return;
  }

  // HTML pages, static assets, _next chunks → public. Auth only gates the API.
  if (!isProtectedApi(url)) {
    done();
    return;
  }

  // First-run: no PIN set, dashboard hasn't been initialized → allow.
  if (!isPinSet()) {
    done();
    return;
  }

  /* Loopback bypass for the read-only /sessions feed. The bridge
   * extension polls /sessions on a short interval from the same host
   * to drive its cwd -> cc_session_id lookup; without this exception
   * the bridge can never populate cc_session_ids in the presence
   * file and every project_session anchor stays dormant. Scope is
   * narrow on purpose: GET /sessions and its subpaths only, and only
   * when the request actually originated from 127.0.0.1 / ::1.
   * Other protected APIs (notifications, projects, push, etc.) still
   * require the dn_session cookie. See FUTURE-SECURITY-CONCERNS.md
   * for the residual risk: any local process on the host can now
   * enumerate active CC sessions without the dashboard PIN. */
  const path = url.split('?')[0] ?? '/';
  const isSessionsGet =
    req.method === 'GET' &&
    (path === '/sessions' || path.startsWith('/sessions/') ||
      path.startsWith('/sessions?'));
  if (isSessionsGet && isLoopbackRequest(req)) {
    done();
    return;
  }

  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> })
    .cookies;
  const token = cookies?.[COOKIE_NAME];
  if (!verifyToken(token)) {
    reply.code(401).send({ ok: false, error: 'unauthorized' });
    return;
  }
  done();
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/auth/status', async () => ({
    pin_set: isPinSet(),
    locked: load().locked_until > Date.now(),
  }));

  app.post('/auth/pin', async (req, reply) => {
    const body = req.body as { pin?: string; current_pin?: string };
    if (!body.pin || typeof body.pin !== 'string') {
      reply.code(400);
      return { ok: false, error: 'pin required' };
    }
    if (isPinSet()) {
      // Changing PIN requires the current one
      if (!body.current_pin) {
        reply.code(400);
        return { ok: false, error: 'current_pin required to change PIN' };
      }
      const r = await tryUnlock(body.current_pin);
      if (!r.ok) {
        reply.code(401);
        return { ok: false, error: 'current_pin incorrect' };
      }
    }
    try {
      await setPin(body.pin);
      regenerateSecret();
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post('/auth/unlock', async (req, reply) => {
    const body = req.body as { pin?: string };
    if (!body.pin) {
      reply.code(400);
      return { ok: false, error: 'pin required' };
    }
    const r = await tryUnlock(body.pin);
    if (!r.ok) {
      reply.code(r.reason === 'locked' ? 429 : 401);
      return r;
    }
    reply.setCookie(COOKIE_NAME, r.token ?? '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // tailnet only
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
    });
    return { ok: true };
  });

  app.post('/auth/lock', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}
