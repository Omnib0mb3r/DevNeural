# Dev vs Prod dashboard — which port serves what, when to rebuild

## TL;DR

There are TWO dashboards running concurrently against the same Next.js codebase. Knowing which is which avoids "I changed the code and nothing happened after restart" confusion.

| Port  | Mode        | Source path                       | Updates when                                       |
|-------|-------------|------------------------------------|----------------------------------------------------|
| 3000  | Dev (next dev)   | `08-dashboard/` source files (TSX) | Edit any `.tsx`/`.ts` file. Hot-reload, instant.   |
| 3747  | Prod (Fastify static) | `08-dashboard/out/` static bundle  | Only after `cd 08-dashboard && npm run build`.     |

Daemon restart by itself does NOT update either dashboard. The dev server is hot-reload (live). The prod static bundle is frozen until you rebuild.

## Mental model

- **Port 3000 = scratch pad.** Edit, see, repeat. No build step. For active dashboard development.
- **Port 3747 = the published version.** Tailscale points here. What other people (or future-you on mobile) see. Only changes when you decide to publish via `npm run build`.

Workflow:

1. Editing dashboard code? Use port 3000.
2. Happy with the change? `cd 08-dashboard && npm run build` to regen `08-dashboard/out/`.
3. Port 3747 now reflects the new code. Tailscale tunnel sees it.
4. Daemon restart is NOT required for dashboard changes. The daemon serves `out/` as static files; new files = new content on next request.

## Why both are running

The daemon's `dashboard-supervisor.ts` module spawns `next dev -p 3000` as a child process on daemon start (default: ON). The same daemon also serves the prod static bundle at port 3747 via `@fastify/static`. So a single daemon process gives you both.

Toggle via runtime_config:

```bash
# turn the dev server off (kills port 3000)
curl -X POST http://localhost:3747/runtime-config/dashboard_supervisor_enabled \
  -H 'Content-Type: application/json' --data-binary '{"value":"off"}'

# turn it back on
curl -X POST http://localhost:3747/runtime-config/dashboard_supervisor_enabled \
  -H 'Content-Type: application/json' --data-binary '{"value":"on"}'
```

Env override (boot-time only): `DEVNEURAL_DASHBOARD_SUPERVISOR=off`.

`CI=true` forces it off so test runs do not bind port 3000.

## "I changed a dashboard component and restart didn't fix it"

You probably bookmarked port 3747 (the prod static path) and hit it expecting fresh code. Two options:

1. Switch to port 3000 — auto-reload, no build needed.
2. Stay on 3747 — run `cd 08-dashboard && npm run build`. Refresh browser. No daemon restart needed.

Daemon restart only matters when YOU CHANGED `07-daemon/` source code. Daemon restart will NOT pick up dashboard code changes either way; dashboard files are independent.

## Daemon restart gotcha

During daemon restart, the child `next dev` process is killed and respawned. Port 3000 returns connection-refused for a few seconds until it boots. Port 3747 returns connection-refused for the entire daemon-down window. After restart:

- Port 3000: live within ~10-30 s once next-dev finishes its boot compile.
- Port 3747: live immediately once Fastify is back.

## When to choose dev vs prod for Tailscale exposure

Tailscale forwards `https://otlcdev.tail27b46b.ts.net/` to `http://localhost:3747`. Default is prod-static.

Two reasonable setups:

- **Shipped / showing-it-off mode** — Tailscale on 3747. Need to `npm run build` before others see new changes. Stable, predictable.
- **Active dev mode** — point Tailscale at 3000 (`tailscale serve --bg --https=443 http://localhost:3000`). Every edit auto-pushes to anyone watching. Risk: half-broken UI visible to others during edits. Use only when working solo.

To flip Tailscale to dev:

```powershell
tailscale serve --bg --https=443 http://localhost:3000
```

To flip back to prod:

```powershell
tailscale serve --bg --https=443 http://localhost:3747
```

Check current state:

```powershell
tailscale serve status
```

## Recap of the gotcha that triggered this doc

2026-05-26: operator restarted daemon expecting Fix 41 (smart-compact policy refactor) to take effect. Daemon restarted but `07-daemon/dist/` was never rebuilt → old scheduler kept ticking → wrap-prompt spam to worker. The dashboard side of this confusion ALSO existed: edits to dashboard components at port 3000 did not appear at port 3747 because nobody had run `cd 08-dashboard && npm run build`.

Lesson: there are THREE independent build steps, not one.

| What changed                          | Action to make it live                                      |
|---------------------------------------|-------------------------------------------------------------|
| `07-daemon/src/**.ts`                 | `cd 07-daemon && npm run build`, then restart daemon.       |
| `08-dashboard/**.tsx` (or any source) | `cd 08-dashboard && npm run build`. Port 3747 picks it up. (Port 3000 auto-reloads regardless.) |
| `09-bridge/src/**.ts`                 | `cd 09-bridge && npm run build && npm run package`, reinstall VSIX in VS Code. |

None of these chain automatically. Each is its own command. Restart-daemon alone covers one third of one of them.

## See also

- [HOW-TO-dashboard-serving](HOW-TO-dashboard-serving.md) - lower-level Fastify static-serving mechanics
- [INSTALL](../INSTALL.md) - first-time build/install order
- [SHIP-CHECKLIST](../SHIP-CHECKLIST.md) - pre-ship build verification
