# Spec (future state): Split `07-daemon` into three planes

**Created:** 2026-05-11 (brainstorm session "DevNeural Testing")
**Status:** Future state — DEFERRED. Do not implement until:
- Project anchors (`PROJECT-ANCHORS.md`) shipped and soaked.
- Smart compact (`SMART-COMPACT.md`) shipped and soaked.
- Wave 3 Lane A (orb unification) shipped.

The single-process daemon is fine for now. This document captures the target
architecture so when the split happens, the seams are already in mind.

---

## Why split

The current `07-daemon` is a kitchen sink: sessions + PTY + voice WS + Lex
personality + brainstorms + wiki + curator + embed + stats + inject + heartbeat,
all in one Node event loop. Problems compounding as features land:

- A blocking embed job or a stuck `ollama` call stalls voice WS replies.
- A voice WS crash takes down the wiki indexer with it.
- Restart cycles get expensive: every code change to voice forces a daemon
  restart that also drops live PTYs and pauses brainstorm distillation.
- GPU-heavy work (embedder, llama jobs) competes with latency-sensitive
  work (voice + inject) on the same scheduler.
- File watchers and timers proliferate, each one a foot-gun for the wrong
  plane.

---

## Three planes

### 1. `07-core` — "what's running"

Owns:
- Sessions registry, PTY host, bridge connections.
- Cross-session inject endpoint.
- Project anchors (`project_session` table reads/writes).
- Lex anchors (`lex_session` table reads/writes).
- Heartbeat receiver + watcher integration.
- PTY exit reaper, anchor liveness sync.

Port: 3747 (today's port — stays for backward compat).

Smallest event loop. Few external dependencies. Cheapest to restart.

### 2. `07-voice` — "what Lex hears and says"

Owns:
- Lex voice WS (`lex/lex-voice-ws.ts`).
- TTS (piper) + STT pipeline.
- Lex system prompt assembly + personality files + few-shots.
- live_state snapshot builder (reads from core via HTTP).
- Tool gate (web search vocabulary check, etc).
- Lex retrieval helpers (chunk-search, recall) — proxied to memory plane.

Port: 3748.

Restarts independently. Voice client reconnects via WS retry. Core stays up
through voice restarts.

### 3. `07-memory` — "what we know"

Owns:
- Brainstorm store, brainstorm chunks, distillation pipeline.
- Wiki pages, lineage, frontmatter.
- Embedder (Xenova / ollama), reindex jobs.
- Curator decisions, audit findings, reinforcement log.
- Stats endpoints (curator-health, brainstorm-kpi, outbound).
- Long-running batch jobs (lint nightly, self-audit nightly, raw chunks cull).

Port: 3749.

GPU + disk heavy. Slow background work isolates here. Voice + core unaffected
by long-running reindex.

### Dashboard

`08-dashboard` becomes a thin aggregator. Existing routes proxy / fan-out to
the right plane. Eventually some routes can call planes directly from the
client, but during the migration the dashboard route layer absorbs the
indirection so the frontend doesn't have to know about the split.

---

## Transport between planes

HTTP over loopback for v1. JSON request/response, same patterns as today's
`/lex/...` routes. Trivial to swap to unix sockets or named pipes later if
loopback latency matters.

No shared SQLite handle: each plane talks to `index.db` through its own
connection. Existing WAL mode handles concurrency. If contention shows up,
move read-only stats to a replica.

---

## Migration plan (when activated)

1. **Extract memory plane.** Move `store/`, `wiki/`, `curator/`, `embed/`,
   `lex/chunk-search.ts`, `lex/recall.ts`, stats endpoints. New
   `07-memory/` package. Core proxies legacy endpoints to memory plane
   so dashboard doesn't break. Soak 2 weeks.
2. **Extract voice plane.** Move `voice/`, `lex/lex-voice-ws.ts`,
   `lex/system-prompt.ts`, personality files. New `07-voice/` package.
   Core proxies WS upgrades to voice plane. Soak 2 weeks.
3. **Rename remaining daemon to `07-core`.** Drop the proxy shims. Update
   dashboard daemon-client to address planes directly where appropriate.
4. **Boot orchestration.** `start.bat` (and nssm services) launch all three.
   Crash of any one doesn't take down the others. Restart policy per plane.

---

## Decisions / constraints

- One database file (`index.db`) shared across planes. WAL mode is enough.
- Bridge and inject stay in core (transport for voice's reach to workers).
- No new auth surface — planes trust loopback. External callers still hit
  core's auth boundary.
- Stream Deck tray app talks to core (existing identity-file path).
- Migrations stay in the `07-daemon/scripts/migrations` lineage but each
  plane runs the relevant subset on boot.

---

## Open questions (defer to plan)

- Do voice and core share the lex_session anchor table or does voice cache
  via HTTP? Probably HTTP-cache with TTL.
- live_state assembly today reads from many tables. Build it in core and
  let voice fetch, or build it in voice from raw core data? Recommend
  build-in-core, voice consumes.
- Hot-reload story per plane.
