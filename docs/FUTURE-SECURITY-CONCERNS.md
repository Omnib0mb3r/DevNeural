# FUTURE-SECURITY-CONCERNS

Running log of intentional security trade-offs. Each entry is a debt
the project chose to take on with a documented rationale and a recovery
path. Lex retains this corpus so future iterations can revisit any
entry if the threat model changes.

## 2026-05-13: loopback bypass for `GET /sessions`

**Change:** `07-daemon/src/dashboard/auth.ts` was patched so that
`GET /sessions` (and any `/sessions/...` subpath) returns 200 without
the `dn_session` cookie when the request originates from the loopback
interface (`127.0.0.1`, `::1`, or the IPv4-mapped `::ffff:127.0.0.1`).
Every other protected API still requires the PIN-derived cookie.

**Why:** the 09-bridge VS Code extension polls `/sessions` from inside
the same host to populate its `daemonActiveSessions` map, which feeds
the cwd to cc_session_id lookup that writes `cc_session_ids` into the
bridge presence file. Without the bypass the bridge gets a 401 on
every poll, the lookup map stays empty, the presence file ships
without `cc_session_ids`, and the daemon's `reconcileBridgePresence`
never binds any project_session anchor to a live CC session. Net
effect: `open_projects` in the voice snapshot stays empty and Lex
loses its answer to "what projects do I have open".

**Residual risk:** any process running on the same host as the daemon
can now enumerate active Claude Code session ids without the dashboard
PIN. On this single-user workstation (Tailscale tailnet plus physical
access required to reach loopback) the residual risk is acceptable;
the dashboard PIN was originally there to protect the Tailscale-reachable
surface, not local processes. If the project ever ships to a
multi-tenant or shared-host environment this exception must be revisited.

**Recovery path:** delete the `isSessionsGet && isLoopbackRequest(req)`
block in `authMiddleware`. The bridge will need a real auth surface
(shared-secret header signed at daemon launch, or a separate read-only
session enumeration route gated by a different secret) before that
deletion can ship without breaking `open_projects`.
