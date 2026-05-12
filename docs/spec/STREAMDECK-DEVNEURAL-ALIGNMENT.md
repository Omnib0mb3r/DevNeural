# Spec: Align StreamDeck.App with DevNeural project anchor model

**Created:** 2026-05-12 (brainstorm session "DevNeural Testing")
**Status:** Ready to plan/implement after PROJECT-ANCHORS lands (it has, commits 708233d through 1ff109a).
**Repo affected:** stream-deck (C:/dev/Projects/stream-deck). DevNeural side is the contract surface and is already shipped.

---

## Goal

StreamDeck.App today binds buttons to transient Claude Code session UUIDs and maintains its own identity model on disk. DevNeural just shipped durable `project_session` anchors (cwd-keyed, UUID-stable, survive /clear and /compact). Buttons should bind to anchor IDs, not session UUIDs, so a deck button keeps working forever once configured.

Approach: StreamDeck.App becomes a thin HTTP client of the DevNeural daemon. The daemon owns truth (anchor model, liveness, spawn-or-bind, panic targeting); the deck app reads the daemon's API for what to render and POSTs back to it for actions.

This eliminates the parallel codepath between the web dashboard and the deck, and means future changes (new tile states, new actions, event-driven supervision) ship in the daemon once and propagate to both clients automatically.

---

## What CHANGES on the stream-deck side

### Identity model
- **Before:** `%LOCALAPPDATA%\stream-deck\identity\<sessionId>.json` was authoritative for liveness via mtime freshness. Buttons referenced session UUIDs.
- **After:** Buttons reference `anchor_id` (UUID from `project_session.id`). Tray polls `GET /projects/anchor-tiles` for the current tile list and renders by anchor_id. Identity files retained for editor-detection only (which VS Code window to focus on tile click — see "What MUST NOT change" below).

### Tile rendering data source
- **Before:** Local state derived from identity dir + ad-hoc heuristics.
- **After:** `GET /projects/anchor-tiles` returns the canonical tile feed (label, phase, status, badge counts). Deck renders from that response. Refresh interval: 1s default, configurable via env. Future: WebSocket push from daemon when event-driven supervision lands (see EVENT-DRIVEN-SUPERVISION.md).

### Button press actions
- **Single press:** `POST /projects/:anchor_id/open`. Daemon's spawn-or-bind contract handles whether to focus an existing window or launch a fresh one.
- **Long press (defer to Phase 2):** `POST /projects/:anchor_id/end` to flip dormant.
- **Panic gesture (when PANIC-BUTTON.md ships):** `POST /projects/:anchor_id/interrupt` to send double-ESC to the worker.
- All button actions go through HTTP. No direct PTY writes from the deck app.

### Configuration storage
- **Before:** Button-to-session-UUID mapping in deck app local config.
- **After:** Button-to-anchor-id mapping. Anchor UUIDs are stable across daemon restarts and CC session rotation, so the mapping never goes stale. If an anchor is deleted, the button shows a "missing anchor" placeholder.

### Tile labels
Read from `anchor.title || anchor.derived_title || anchor.project_slug`, in that order. Same priority chain DevNeural's web dashboard uses.

---

## DevNeural usage map (authoritative — where DevNeural reads/writes deck artifacts)

If anything below breaks after a stream-deck change, this is the audit trail to fix it. All paths are concrete as of commit 1ff109a.

| Deck artifact | DevNeural file | DevNeural symbol | Purpose |
|---|---|---|---|
| `%LOCALAPPDATA%\stream-deck\identity\<sessionId>.json` | `07-daemon/src/dashboard/sessions.ts:66` | `STREAMDECK_IDENTITY_DIR` | Editor-detection only post Step 6 (resolves which VS Code window holds session X for tile-tap focus). Not consulted by `listSessions` for liveness anymore. |
| `%LOCALAPPDATA%\stream-deck\virtual-input\<sessionId>.in` | `07-daemon/src/dashboard/sessions.ts:738` | `VIRTUAL_INPUT_DIR` | Daemon writes here; deck app's VirtualInputWatcher dispatches keystrokes via WindowManager.FocusWindow + NavKeymap.InjectFor. |
| `%LOCALAPPDATA%\stream-deck\.heartbeat` | `07-daemon/src/dashboard/sessions.ts:764` | `STREAMDECK_HEARTBEAT` | Deck app touches this file periodically; daemon checks freshness within `STREAMDECK_STALE_MS` (60s) to determine if the tray is alive. |
| `%LOCALAPPDATA%\stream-deck\app.log` | `07-daemon/src/dashboard/sessions.ts:765` | `STREAMDECK_LOG` | Secondary liveness signal; daemon reads mtime as a fallback heartbeat. |
| `<cwd>/.workspace-inject/` | `07-daemon/src/dashboard/projects-new.ts:27` | `.workspace-inject` constant | Daemon writes marker per `POST /projects/:id/open` spawn path. Bridge in the resulting VS Code window picks it up on next tick. |
| `<cwd>/.workspace-inject/` markers (consumer) | `07-daemon/src/dashboard/projects-routes.ts:195` | spawn path comment block | Same pipeline reused by the new project anchor open endpoint. |
| Hook script `deck-hook.sh` | invoked from user's global Claude Code settings as `stop_hook` | (caller is CC, not daemon) | Worker stop_hook fires `deck-hook.sh idle` after each turn. Must complete sub-second. |
| Phase push from worker | `07-daemon/src/capture/hooks/hook-runner.ts:38` and `transcript-watcher.ts:339` | hook push to `/sessions/:id/phase` | Daemon pushes phase to dashboard tile feed, which the deck consumes via the tile feed (now `/projects/anchor-tiles`). |

If the deck-app refactor breaks something, walk this table from the symptom (e.g. tiles go grey) to the deck artifact (heartbeat file) to the daemon symbol (STREAMDECK_HEARTBEAT) and check the deck side stopped writing.

---

## Out of scope (do NOT touch)

- **Bottom 5 deck keys.** These are universal computer-control bindings (media, app launch, OS macros — owned by the user, NOT by DevNeural). They do NOT control Claude Code sessions and must remain unaffected by the anchor migration. The anchor model applies only to deck buttons currently bound to CC sessions; the bottom row stays in whatever local config the deck app uses for OS-level bindings.
- Any deck button currently bound to a non-CC action (Spotify, OBS, custom hotkey, etc) — leave alone.
- The deck firmware / Elgato HID protocol — DevNeural never touches it.

---

## What MUST NOT change (the contract DevNeural depends on)

These are the integration points where the deck app produces filesystem artifacts the DevNeural daemon reads, or consumes filesystem artifacts the daemon writes. Touching any of them without coordinating with DevNeural will break the daemon. Each one must keep its current shape AND its current location.

### 1. Workspace-inject marker watcher
- **Path:** `%LOCALAPPDATA%\stream-deck\workspace-inject\` (or whatever PROJECT-ANCHORS.md migration plan step 3 wired up — verify exact path against the daemon source `07-daemon/src/dashboard/projects-routes.ts`).
- **Producer:** DevNeural daemon, on `POST /projects/:id/open` spawn path.
- **Consumer:** StreamDeck.App tray watcher.
- **Contract:** marker file appears, deck app launches `code -n <cwd>` so a fresh VS Code window opens. Keep reading these markers; don't change the watch directory or the marker JSON shape without coordinating a daemon-side change first.

### 2. Identity file directory
- **Path:** `%LOCALAPPDATA%\stream-deck\identity\<sessionId>.json`.
- **No longer used for liveness** (Step 6 of PROJECT-ANCHORS migration retired that), but **still used for editor-detection**: the daemon resolves "which VS Code window holds session X" from these files when it needs to focus a window. Keep writing them per current cadence and shape. Removing this dir breaks tile-tap focus.

### 3. Virtual-input watcher
- **Path:** `%LOCALAPPDATA%\stream-deck\virtual-input\<sessionId>.in`.
- **Producer:** DevNeural daemon, when it needs the deck app to inject a key sequence into a VS Code window (Nav-mode keys, focus rights it can't claim itself).
- **Consumer:** StreamDeck.App's VirtualInputWatcher.
- **Contract:** keep watching, keep dispatching through WindowManager.FocusWindow + NavKeymap.InjectFor. Don't change the file format or the per-session naming convention.

### 4. deck-hook.sh
- **Path:** `C:/dev/Projects/stream-deck/src/StreamDeck.App/bin/Debug/net8.0-windows/hook-scripts/deck-hook.sh`
- **Caller:** DevNeural worker sessions invoke it as a `stop_hook` (configured in user's global Claude Code settings).
- **Contract:** must accept `idle` / other phase args and not error. Must not block the worker for more than ~500ms (currently sub-second per the existing hookInfos). Don't rename, don't move, don't change argv contract.

### 5. ResolveVSCodeWindowSmart cwd resolution
- DevNeural relies on the smart workspace-root resolution (deepest-to-shallowest cwd segment walk). Keep that behavior. A session opened in `07-daemon` must still resolve the workspace-root window labeled `DevNeural`.

### 6. PIN auth boundary
- The DevNeural daemon's HTTP surface is PIN-gated via cookie session. Deck app needs a way to authenticate. The simplest path: deck app prompts for the PIN once at first launch, stores the session cookie in DPAPI-protected local storage, refreshes when 401 returned. Do NOT bypass auth, do NOT store the PIN in plaintext.

---

## Migration plan (stream-deck side)

1. **Phase 0: Auth.** Add daemon authentication client. PIN prompt on first launch, cookie stored DPAPI-encrypted. 401 handler re-prompts. Verify against `GET /projects` returning 200.

2. **Phase 1: Tile rendering.** Replace local identity-based tile derivation with HTTP polling against `GET /projects/anchor-tiles`. Render by `anchor_id`. Keep the existing visual vocabulary (LED states, ring colors). Tiles configured against deleted anchors render as muted "missing" placeholders.

3. **Phase 2: Button-to-anchor binding.** Migrate existing button configs from session-UUID keys to anchor-id keys. Migration script: for each existing config, query the daemon for the anchor that matches the cwd recorded with the old session UUID, write the new anchor_id binding. Old session UUIDs without a matching anchor become unbound buttons (user re-binds manually).

4. **Phase 3: Press actions.** Single-press wires to `POST /projects/:id/open`. Long-press wires to `POST /projects/:id/end` (gate behind a setting). Remove all direct PTY writes from the deck app.

5. **Phase 4: Panic gesture (when PANIC-BUTTON.md ships).** Bind a deck-wide gesture (chord, dedicated red button, or hold-corner) to `POST /projects/:id/interrupt` resolving to the active anchor.

6. **Phase 5: Verification.** Soak with the daemon for one full week. Run through full button matrix on the physical deck and the virtual deck (dashboard). Confirm the contract surface (sections 1-6 in "What MUST NOT change") is untouched by running DevNeural's existing daemon tests (234+ tests, currently green).

---

## Already done — do NOT redo

- DevNeural side: PROJECT-ANCHORS migration shipped end to end (commits 708233d, ec96e23, ffb3e12, d26351f, b97af11, 1ff109a). Anchor model, endpoints, sanity-check feed all live.
- Cross-session inject pipeline shipped commit `8f68121`. Deck panic gesture should reuse the same auth surface (HMAC token issued via `POST /auth/cross-session-token`) when PANIC-BUTTON.md lands, not a new one.
- Tile-tap focus + Nav-mode key inject already routed through the StreamDeck.App tray (commit 3147c41 in stream-deck repo, 59cfd2e in DevNeural). Don't tear that out; just rewire the trigger source from local state to the HTTP press handler.

---

## Constraints / decisions

- Daemon is single source of truth. Deck app stores no anchor state locally beyond its button-to-anchor-id config.
- HTTP polling at 1s default. WebSocket push deferred to EVENT-DRIVEN-SUPERVISION.md.
- Identity files keep being written (editor-detection); daemon no longer treats them as liveness-authoritative (Step 6 of PROJECT-ANCHORS already removed that).
- Workspace-inject marker contract is sacred. No changes without a coordinated daemon PR.
- No direct PTY writes from the deck app. All actions go through daemon HTTP.
- PIN-protected. No bypass, no plaintext storage.
- Symmetry with PROJECT-ANCHORS: deck buttons mirror project_session anchors the same way the dashboard tiles do. One mental model, two front-ends.

---

## Risk and rollback

- Keep the old code path behind a feature flag (`DECK_USE_DAEMON_API=true`) for the first soak week. Toggle off if anything breaks; deck reverts to legacy local-state behavior. Identity files are still written either way, so the daemon-side liveness path keeps working through the soak.
- Run DevNeural's daemon tests before each deck-app commit. If a daemon test fails after a deck-app change, the contract was probably touched. Investigate before merging.
- Capture the contract surface (sections 1-6) as integration tests in DevNeural's daemon test suite that exercise the marker watchers with golden fixtures. Tests fail loudly if shape drifts.
