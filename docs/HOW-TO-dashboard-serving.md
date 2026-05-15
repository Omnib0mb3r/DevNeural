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

## When to start `npm run dev`

Only when **all** of these are true:

- You are actively editing files under `08-dashboard/`.
- You want hot-reload re-renders without a full `npm run build`.
- You have explicitly asked for it (or the user has explicitly asked for it).

Never start `npm run dev` reflexively because port 3000 has nothing on it. Port 3000 is supposed to be empty by default. The dashboard is on 3747.

## When the dashboard appears down

1. Check the daemon: `Get-NetTCPConnection -State Listen -LocalPort 3747` + `curl http://127.0.0.1:3747/health`. If daemon is down, restart the daemon: `cd C:/dev/Projects/DevNeural/07-daemon && npm run start`.
2. If daemon is up + healthy but the page looks stale or broken, rebuild the static export: `cd C:/dev/Projects/DevNeural/08-dashboard && npm run build`. The daemon picks up the new `out/` directory without restart.
3. Tailscale serve config: `tailscale serve status` should show `/ proxy http://localhost:3747`. If it's pointing elsewhere, restore it with `tailscale serve --bg --https=443 http://localhost:3747`.

Port 3000 has nothing to do with any of these steps.
