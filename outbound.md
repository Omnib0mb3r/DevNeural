# DevNeural Outbound

This file lists every code path that sends data off-host. Voice-session content (brainstorm and meeting) is forbidden in every outbound path, regardless of opt-in flags.

## Code paths

| Path | Destination | Purpose | Data class | Trigger | Opt-in flag |
|---|---|---|---|---|---|
| `07-daemon/src/wiki/ingest.ts` Pass 2 fallback | api.anthropic.com (Haiku) | Pass 2 schema retry when local model exhausts retries | wiki page candidates from project transcripts and reference docs | local model exhausts retries on a project ingest pass | `DEVNEURAL_PASS2_FALLBACK=anthropic` (default disabled) |
| `07-daemon/src/wiki/ingest.ts` cross-project verifier | api.anthropic.com (Haiku) | Cross-project pattern verification | wiki page candidate text + the existing page text | first cross-project merge attempt where N>=3 distinct projects share the page AND the existing page has no voice-session source | always on when CP path triggers (provider must already be Anthropic) |
| `07-daemon/src/heartbeat/poster.ts` (Wave 2) | configured `DEVNEURAL_HEARTBEAT_URL` | External liveness signal | daemon pid, version, ISO timestamp only; no payload | every 60s | `DEVNEURAL_HEARTBEAT_URL` set |

## Forbidden classes

The following payload classes and provenance flags are refused at three layers (defence-in-depth):

1. **Application layer** (`07-daemon/src/db/outbound-guard.ts`): the `outboundCall` wrapper rejects any call where `payloadClass` starts with `brainstorm-` or `meeting-`, OR where `containsVoiceSessionSource=true`. Refused calls throw `OutboundRefused` with `failureCode='voice-session-blocked'` and never reach the network.
2. **Cross-project verifier source filter** (`07-daemon/src/wiki/ingest.ts`): pages whose `source_brainstorms` OR `source_meetings` frontmatter is non-empty are skipped before the verifier is even called. Such pages are flagged for human / lint review only.
3. **Database trigger** (`07-daemon/scripts/migrations/006-outbound-log.sql`): the `outbound_no_voice_session` trigger aborts any insert into `outbound_log` whose `payload_class LIKE 'brainstorm-%'` or `'meeting-%'` or whose `contains_voice_session_source = 1`.

## Daily cap

`DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS` (default 200) and `DEVNEURAL_OUTBOUND_DAILY_CAP_BYTES` (default 5 MiB) cap outbound usage per UTC day. Cap reached = the next call refuses with `failureCode='daily-cap-calls'` or `'daily-cap-bytes'`. The dashboard `OutboundCard` shows `cap_remaining` and `paused: true` when the cap is reached.

## Audit

Every outbound call (including refused ones) writes a row to `outbound_log` (schema in `07-daemon/scripts/migrations/006-outbound-log.sql`). The dashboard `GET /stats/outbound` aggregates the last 7 days, exposes today's per-destination call counts, and asserts `brainstorm_outbound_count_alltime: 0` by contract. Any non-zero brainstorm outbound count is treated as a critical bug.
