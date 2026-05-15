/* Module-level registry for the daemon's graceful shutdown.
 *
 * Used to surface the SIGTERM/SIGINT shutdown path to route handlers
 * (notably /admin/daemon/restart) without circular imports between
 * daemon.ts and dashboard/routes.ts. daemon.ts calls setShutdownHook
 * once after defining its shutdown closure; routes call
 * triggerShutdown to run it.
 *
 * If triggerShutdown is called before setShutdownHook (e.g. during
 * tests that mount routes against a bare app), the call resolves to
 * a no-op so callers can still await it.
 */

export type ShutdownFn = (reason: string) => Promise<void>;

let registered: ShutdownFn | null = null;

export function setShutdownHook(fn: ShutdownFn): void {
  registered = fn;
}

export function hasShutdownHook(): boolean {
  return registered !== null;
}

export async function triggerShutdown(reason: string): Promise<void> {
  if (!registered) return;
  await registered(reason);
}
