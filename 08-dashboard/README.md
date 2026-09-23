# 08-dashboard

The DevNeural dashboard: Next.js 15, Tailwind v4, Tanstack Query, statically exported and served by the daemon on port 3747. PWA-installable; reachable from a phone over Tailscale. There is no PIN gate; the trust boundary is the host plus the tailnet.

## What it shows

- Home: the KPI strip (size, quality, activity, velocity, health), daily brief, reminders, notifications, the Outbound card.
- Sessions: every Claude Code session with phase, the context gauge (fill with the auto-clear point and the ceiling marked), and inline answer buttons for permission and elicitation prompts.
- Lex: the brainstorm anchors, each with its supervised worker and both context gauges; the transcript panel; the voice client (mic, VAD, TTS, three modes: conversation, notes, push-to-talk); the handover list for the open brainstorm (newest first, worker draft and Lex review visible); the one Auto-clear switch (`off`, `shadow`, `live`).
- Projects, wiki, orb (force-directed graph), system (sparklines), reminders, settings, and the Stream Deck rail.

## Voice client

`components/VoiceClient.tsx` talks to the daemon's `WS /lex/voice`: microphone audio in (silero VAD, whisper.cpp on the daemon), TTS audio out on one continuous stream per reply (`lib/voice-engine/audio-stream-sink.ts`, a MediaStreamAudioDestination sink with an adaptive lead and silence padding between sentences, so the car link does not clip word onsets). Barge stops the sound at once; the daemon decides what happens next. Controls are spoken and interpreted by Layer 1 (`docs/spec/LAYER-1-CONTROL.md`); the panic phrase and the global panic button (`Ctrl+Alt+.`) are mechanical.

## Develop and build

```powershell
cd C:\dev\Projects\DevNeural\08-dashboard
npm install --legacy-peer-deps
npm run dev          # next dev on :3000 with a rewrite proxy to the daemon on :3747
npm run build        # static export to out/ (prebuild rimraf, next build, service-worker version stamp); the daemon serves out/
npm run typecheck    # tsc --noEmit
npm test             # vitest (332 passing as of 2026-09-23; the four voice-mic-init reds are BUG-023, the two Playwright specs run under npm run e2e, not vitest)
npm run e2e          # playwright
```

Port 3000 is the hot-reload dev server; port 3747 serves the frozen `out/` until the next `npm run build`. A daemon restart updates neither. See `../docs/HOW-TO-dev-vs-prod-dashboard.md`.

## Where the daemon routes are called

`lib/` holds the typed clients. The Lex surfaces read `/lex/anchors`, `/lex/anchor-tiles` (with `worker_ctx_pct`, `lex_ctx_pct`, `ctx_threshold_pct`, `ctx_ceiling_pct`), `/lex/anchors/:id/handovers`, `/lex/auto-clear/mode`, `/sessions` (with `ctx_pct`), and the voice WebSocket. The full route list with bodies lives in `../07-daemon/src/lex/system-prompt.ts` (the runtime route list Lex herself reads).

## Related docs

- `../docs/HOW-TO-dashboard-ux.md`: panel contracts.
- `../docs/HOW-TO-dashboard-serving.md`: how the bundle is served.
- `../docs/HOW-TO-voice-and-push.md`: voice knobs and web push.
- `BRIEF.md`, `VERIFICATION.md`, `POSTMORTEM.md`: the design brief, the token audit and the 2026-05 postmortem kept in this package.
