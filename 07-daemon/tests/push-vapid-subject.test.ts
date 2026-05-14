/**
 * VAPID subject safety + migration.
 *
 * Bug 2026-05-14-pwa-reminders-not-pushing: Apple's APNs JWT
 * validator rejects mailto subjects whose domain part is a non-
 * routable TLD (`.local`, `.invalid`, `.localhost`, `.example`,
 * `.test`) with 403 BadJwtToken so every push to an iPhone PWA
 * fails silently while desktop FCM keeps delivering. The
 * isolation probe at C:/tmp/probe-ios-push.mjs captured Apple
 * rejecting `mailto:noreply@devneural.local` (the legacy default
 * baked into the persisted vapid.json) and accepting `.app` /
 * `.com` / `https://` subjects.
 *
 * isSafeVapidSubject + the loader migration here implement the
 * fix: existing files carrying the legacy bad subject get
 * upgraded in place; brand new files default to the safe value;
 * the env override still wins when set to something accepted.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VAPID_SUBJECT,
  LEGACY_BAD_VAPID_SUBJECT,
  isSafeVapidSubject,
} from '../src/dashboard/push.js';

describe('isSafeVapidSubject', () => {
  it('rejects the legacy default that Apple returns BadJwtToken for', () => {
    expect(isSafeVapidSubject(LEGACY_BAD_VAPID_SUBJECT)).toBe(false);
  });

  it('rejects every non-routable TLD we have seen Apple reject', () => {
    expect(isSafeVapidSubject('mailto:foo@bar.local')).toBe(false);
    expect(isSafeVapidSubject('mailto:foo@bar.localhost')).toBe(false);
    expect(isSafeVapidSubject('mailto:foo@bar.invalid')).toBe(false);
    expect(isSafeVapidSubject('mailto:foo@bar.example')).toBe(false);
    expect(isSafeVapidSubject('mailto:foo@bar.test')).toBe(false);
    expect(isSafeVapidSubject('https://anything.local')).toBe(false);
  });

  it('accepts the new default + real-TLD mailtos + https URLs', () => {
    expect(isSafeVapidSubject(DEFAULT_VAPID_SUBJECT)).toBe(true);
    expect(isSafeVapidSubject('mailto:noreply@example.com')).toBe(true);
    expect(isSafeVapidSubject('mailto:contact@devneural.app')).toBe(true);
    expect(isSafeVapidSubject('https://github.com/Omnib0mb3r/DevNeural')).toBe(true);
    expect(isSafeVapidSubject('http://devneural.dev')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isSafeVapidSubject(undefined)).toBe(false);
    expect(isSafeVapidSubject(null)).toBe(false);
    expect(isSafeVapidSubject('')).toBe(false);
    expect(isSafeVapidSubject('not-a-uri')).toBe(false);
    expect(isSafeVapidSubject('mailto:')).toBe(false);
    expect(isSafeVapidSubject('mailto:@example.com')).toBe(false);
    expect(isSafeVapidSubject('mailto:noreply@')).toBe(false);
    expect(isSafeVapidSubject('mailto:noreply@no-tld')).toBe(false);
    expect(isSafeVapidSubject('ftp://devneural.dev')).toBe(false);
  });
});
