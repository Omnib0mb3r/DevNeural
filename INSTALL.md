# DevNeural — Installation

> Entry point for installing or rebuilding DevNeural on a new (or wiped) machine.
> Goal: any developer (or a Claude reading this doc) can stand the system up cleanly without breaking an existing setup.
> Last updated: 2026-05-04.

This file is the table of contents. The detailed instructions live under [docs/install/](docs/install/).

---

## Read in order

1. [docs/install/01-prerequisites.md](docs/install/01-prerequisites.md)
   What must already be on the machine before you start. Versions, install commands, verification steps.

2. [docs/install/02-architecture-and-dependencies.md](docs/install/02-architecture-and-dependencies.md)
   What DevNeural is made of, what each piece does, what each piece depends on, what protocol they use to talk to each other.

3. [docs/install/03-files-and-paths.md](docs/install/03-files-and-paths.md)
   Every file DevNeural creates, modifies, or reads. Inside the repo, in the user's home, on the data drive. With backup-first rules for anything outside the repo.

4. [docs/install/04-step-by-step.md](docs/install/04-step-by-step.md)
   The actual install procedure. Sequenced. Verifiable at each step.

5. [docs/install/05-coexistence-with-claude-setup.md](docs/install/05-coexistence-with-claude-setup.md)
   How DevNeural fits alongside the existing Claude setup (https://github.com/Omnib0mb3r/Claude-Setup) and other plugins (superpowers, GSD, deep-implement, etc.) without nuking them. Includes the Phase 5 audit of the actual `~/.claude/settings.json` on `OTLCDEV` with hooks categorized by owner.

6. [docs/install/06-recovery-and-reconstruction.md](docs/install/06-recovery-and-reconstruction.md)
   "I lost my machine" / "I want to start fresh." Order of operations to restore.

7. [docs/install/07-troubleshooting.md](docs/install/07-troubleshooting.md)
   Common failures and how to fix them.

8. [docs/install/08-personalized-recovery.md](docs/install/08-personalized-recovery.md)
   `OTLCDEV`-specific recovery checklist tying Claude-Setup, dev-template, and DevNeural together. Includes the backup-pipeline section (install-backup-task, snapshot rotation, verify, restore).

Plus topic-specific docs:

- [docs/install/TAILSCALE.md](docs/install/TAILSCALE.md) — remote access from your phone
- [docs/install/AUDIO-VIDEO.md](docs/install/AUDIO-VIDEO.md) — whisper.cpp + ffmpeg for audio/video uploads

Operating-the-stack docs (read after install, when something breaks
or before you touch a wired-in surface):

- [docs/HOW-TO-supervision-pipelines.md](docs/HOW-TO-supervision-pipelines.md) — bridge presence, cross-session inject, smart compact, event-driven supervision, brainstorm threading
- [docs/HOW-TO-dashboard-ux.md](docs/HOW-TO-dashboard-ux.md) — panic button, transcript history, Past Sessions compact, collapse helper
- [docs/HOW-TO-voice-and-push.md](docs/HOW-TO-voice-and-push.md) — voice/TTS knobs, text-input-bypasses-TTS, UUID rule, reminders → web push + iOS smoke test

---

## At-a-glance checklist

This is the short version. The detailed steps are in `04-step-by-step.md` and the production gate is in `../SHIP-CHECKLIST.md`.

```
[ ] Prereqs installed (Node 20+, Git, ollama, VS Code, Tailscale; ffmpeg if you want audio/video)
[ ] Repo cloned to C:/dev/Projects/DevNeural/
[ ] Default model pulled (`ollama pull qwen3:8b`)
[ ] cd 07-daemon && npm install && npm run setup
[ ] cd 07-daemon && npm run install-hooks       # registers 5 v2 hook entries (Pre/Post/Prompt/Stop/Notification); backs up settings.json
[ ] cd 07-daemon && npm run silence-hooks       # wraps every hook in silent-shim.exe so spawns run hidden; idempotent
[ ] cd 08-dashboard && npm install --legacy-peer-deps && NODE_ENV=production npx next build
[ ] cd 09-bridge && npm install && npm run build && npm run package
[ ]   code --install-extension devneural-bridge.vsix
[ ] cd 07-daemon && npm run install-backup-task # CRITICAL — your data root is irreplaceable
[ ] cd 07-daemon && npm run start               # daemon on :3747; dashboard at /
[ ] Open http://localhost:3747, verify the home view loads
[ ] Verify: npm run status returns all green or actionable warnings
[ ] Optional: install Tailscale on phone + sign into same tailnet (docs/install/TAILSCALE.md)
[ ] Optional: install whisper.cpp + ffmpeg for audio/video (docs/install/AUDIO-VIDEO.md)
```

For the full ship gate (backup, push, hooks, PWA, etc.), walk [`../SHIP-CHECKLIST.md`](../SHIP-CHECKLIST.md) before declaring production-ready.

---

## What this doc explicitly protects

- **Existing `~/.claude/settings.json` content.** DevNeural's installer detects existing hooks (from Claude-Setup, plugins, other tools) and surgically adds its own without overwriting yours. A backup is written before any change.
- **Existing `~/.claude/CLAUDE.md` and project CLAUDE.md files.** DevNeural never modifies these. If a file needs to be added, the install doc tells you where.
- **Existing project-local files.** DevNeural reads `devneural.jsonc`, READMEs, OTLC-Brainstorm.MD, etc., but does not write to them.
- **Existing data directories.** If `c:/dev/data/skill-connections/` already exists from a previous DevNeural install, the installer reuses it (and warns about v1 artifacts, see migration in `06-recovery-and-reconstruction.md`).

If at any step the doc tells you to overwrite or replace something, it will say so explicitly and tell you where the backup is.

---

## What you do NOT need

- No Anthropic API key (default config uses local LLM).
- No OpenAI key.
- No cloud accounts (everything is local; Tailscale is the network layer).
- No internet during steady-state operation (initial model download requires it).
- No paid services.
- No additional users or accounts.

---

## Where to ask for help

The system is designed so that running `cd 07-daemon && npm run status` answers most "is something broken" questions in 5 seconds. If that doesn't help, see `docs/install/07-troubleshooting.md`.

---

*Michael Collins. Stay on the level.*
