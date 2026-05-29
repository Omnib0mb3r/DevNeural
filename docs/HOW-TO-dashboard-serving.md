# How the DevNeural dashboard is served

## TL;DR

The dashboard you interact with at `https://otlcdev.tail27b46b.ts.net/` (and at `http://127.0.0.1:3747/`) is the **daemon's static serve**. The Next.js codebase under `08-dashboard/` is built once via `npm run build` into `08-dashboard/out/`, and the daemon (Fastify) serves that directory via `@fastify/static`. Tailscale forwards `https://otlcdev.tail27b46b.ts.net/` to `http://localhost:3747`.

Health check for the dashboard:

```bash
curl http://127.0.0.1:3747/health
```

A `200` here means the dashboard is live. Do NOT treat "nothing listening on port 3000" as "dashboard is down" — port 3000 is not the dashboard.

## Two servers, one codebase

| Port | Process | Purpose |
|------|---------|---------|
| 3747 | Fastify daemon (`07-daemon`) | Production dashboard static serve from `08-dashboard/out/`. Always-on. Tailscale entry point. |
| 3000 | Next.js dev server (`08-dashboard`) | Hot-reload, dev-only. Used **only** when actively editing dashboard code and you want live re-renders. |

The daemon serving the dashboard is part of the daemon's normal job. The dev server is a separate, optional thing that lives alongside it.

## When `npm run dev` is running

The daemon's `dashboard-supervisor.ts` module spawns `next dev -p 3000` as a child process on daemon start. Default is ON (toggle via runtime_config key `dashboard_supervisor_enabled` or env `DEVNEURAL_DASHBOARD_SUPERVISOR`). So port 3000 is NOT empty by default on a running daemon.

For the full "which port serves what + which build step makes which change live" story, see [HOW-TO-dev-vs-prod-dashboard](HOW-TO-dev-vs-prod-dashboard.md). Short version: port 3000 = hot-reload dev (edit, see, repeat), port 3747 = prod static (only updates after `npm run build`).

## When the dashboard appears down

1. Check the daemon: `Get-NetTCPConnection -State Listen -LocalPort 3747` + `curl http://127.0.0.1:3747/health`. If daemon is down, restart the daemon: `cd C:/dev/Projects/DevNeural/07-daemon && npm run start`.
2. If daemon is up + healthy but the page looks stale or broken, rebuild the static export: `cd C:/dev/Projects/DevNeural/08-dashboard && npm run build`. The daemon picks up the new `out/` directory without restart.
3. Tailscale serve config: `tailscale serve status` should show `/ proxy http://localhost:3747`. If it's pointing elsewhere, restore it with `tailscale serve --bg --https=443 http://localhost:3747`.

If you want to test dashboard edits with hot-reload, hit port 3000 directly. See [HOW-TO-dev-vs-prod-dashboard](HOW-TO-dev-vs-prod-dashboard.md).
