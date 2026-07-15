import { describe, expect, it } from 'vitest';
import { ptyKill, setPtyHostLogger } from '../src/dashboard/pty-host.js';

/**
 * daemon.stdout.log / daemon.stderr.log sit at 0 bytes after days of
 * uptime (Start-Process redirect targets are never actually written to),
 * so every console.log/warn in pty-host.ts was an invisible diagnostic.
 * setPtyHostLogger wires the module's console.* call sites into the
 * daemon's rotation-capped daemon.log instead. This pins the wiring:
 * a representative diagnostic (ptyKill against an unknown id, which
 * needs no real PTY) must reach the injected logger, and the module
 * must default to a silent no-op when no logger has been set.
 */
describe('pty-host injected logger', () => {
  it('defaults to a silent no-op when no logger has been set', () => {
    // No setPtyHostLogger call in this test: must not throw.
    expect(() => ptyKill('never-spawned-pty-id')).not.toThrow();
  });

  it('routes a representative diagnostic through setPtyHostLogger', () => {
    const captured: string[] = [];
    setPtyHostLogger((msg) => captured.push(msg));

    const result = ptyKill('never-spawned-pty-id-2');

    expect(result).toBe(false);
    expect(
      captured.some((m) =>
        m === '[pty-host] ptyKill: handle not found for never-spawned-pty-id-2',
      ),
    ).toBe(true);

    // Restore the no-op so later assertions in other files never see
    // this test's spy fire.
    setPtyHostLogger(() => undefined);
  });
});
