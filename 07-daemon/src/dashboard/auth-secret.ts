/**
 * Dashboard HMAC secret store.
 *
 * Holds the long-lived secret used to derive HMACs for the cross-session
 * prompt-injection flow. Persisted at $DATA_ROOT/dashboard/auth.json so
 * other host-local callers can read it directly (see
 * lex/cross-session-inject.ts).
 *
 * Historically this file also held a bcrypt-hashed dashboard PIN; that
 * concept has been removed (host-binding is the trust boundary now).
 * Legacy fields are stripped on first read.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DATA_ROOT, ensureDir } from '../paths.js';

const DASHBOARD_DIR = path.posix.join(DATA_ROOT, 'dashboard');
const AUTH_FILE = path.posix.join(DASHBOARD_DIR, 'auth.json');

interface SecretState {
  version: 1;
  secret: string;
}

function defaultState(): SecretState {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString('hex'),
  };
}

function load(): SecretState {
  ensureDir(DASHBOARD_DIR);
  if (!fs.existsSync(AUTH_FILE)) {
    const fresh = defaultState();
    save(fresh);
    return fresh;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')) as Partial<SecretState> & {
      secret?: string;
    };
    if (typeof parsed.secret === 'string' && parsed.secret.length > 0) {
      const state: SecretState = { version: 1, secret: parsed.secret };
      // Rewrite to strip any legacy PIN fields if present.
      save(state);
      return state;
    }
    const fresh = defaultState();
    save(fresh);
    return fresh;
  } catch {
    const fresh = defaultState();
    save(fresh);
    return fresh;
  }
}

function save(state: SecretState): void {
  ensureDir(DASHBOARD_DIR);
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

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
