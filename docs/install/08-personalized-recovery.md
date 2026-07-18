# 08: Personalized recovery for `OTLCDEV`

> One-page recovery checklist, specific to this machine's actual configuration as audited 2026-05-04 in Phase 5. Follow top-to-bottom if you ever need to rebuild from scratch. Generic version of this procedure lives in `06-recovery-and-reconstruction.md`; this file ties it to the personalized inventory in `05-coexistence-with-claude-setup.md`.

---

## What you must keep backed up

Inside `Claude-Setup` (or another safe place):

- `~/.claude/settings.json` (the audited shape, see 05)
- `~/.claude/CLAUDE.md` (global rules)
- `~/.claude/skills/OTLC-Design/SKILL.md` (the design-website skill; substrate is at `C:/dev/Projects/design-system/`)
- `~/.claude/hooks/*.js`, `*.ps1`, `*.sh` (standalone scripts, currently 10+ files)
- The list of `enabledPlugins` (from settings.json; reinstallable from marketplaces)
- `permissions.additionalDirectories` (the 11-entry list — does not regenerate)
- The 5 separate Projects-Claude pairings on this machine (so each can be rehydrated): DevNeural, devneural-projects, design-system, stream-deck, otlc-guardian

Inside `Claude-Setup` (separately):

- `~/.claude/agents/` (if you author any custom subagents)
- `~/.claude/commands/` (if you author any custom slash commands)

NOT pushed anywhere (lost forever if `OTLCDEV` is wiped):

- Session transcripts at `~/.claude/projects/*/<session>.jsonl` — DevNeural reads these incrementally so the captured chunks ARE in `c:/dev/data/skill-connections/raw_chunks/`. Once that store has them, the original transcripts are nice-to-have but not load-bearing
- The DevNeural data root at `c:/dev/data/skill-connections/` itself — wiki, vector store, embeddings cache, reference corpus, models. Backed up only if YOU back it up. Treat it like a database.

---

## Recovery order (clean machine to working state)

Estimated time: ~45 minutes, most of which is OS install + ollama model download.

### 1. Base OS

Windows 11 install + updates. Set hostname to `OTLCDEV` (or whatever name your tailnet expects).

### 2. Prereqs (per `01-prerequisites.md`)

```powershell
# Package manager-driven; idempotent.
winget install OpenJS.NodeJS.LTS         # node 20+
winget install Git.Git
winget install Ollama.Ollama
winget install Microsoft.VisualStudioCode
winget install Tailscale.Tailscale
winget install Anthropic.Claude          # Claude Code
winget install Gyan.FFmpeg               # for Phase 3.5 audio/video
```

Sign into Tailscale: `tailscale up`. Confirm `tailscale status` lists `OTLCDEV`.

### 3. Pull the local LLM and embedder cache

```powershell
ollama pull qwen3:8b
# embedder downloads on first daemon start; stored at c:/dev/data/skill-connections/models/
```

### 4. Restore `~/.claude/`

From `Claude-Setup` (clone first):

```powershell
git clone https://github.com/Omnib0mb3r/Claude-Setup C:\tmp\Claude-Setup
Copy-Item C:\tmp\Claude-Setup\settings.json $env:USERPROFILE\.claude\settings.json
Copy-Item C:\tmp\Claude-Setup\CLAUDE.md       $env:USERPROFILE\.claude\CLAUDE.md
Copy-Item C:\tmp\Claude-Setup\hooks\*.*       $env:USERPROFILE\.claude\hooks\
Copy-Item -Recurse C:\tmp\Claude-Setup\skills $env:USERPROFILE\.claude\
```

Reinstall plugins (these don't ship in `Claude-Setup`; they reinstall from their marketplaces):

```
/plugin install superpowers@claude-plugins-official
/plugin install deep-project@piercelamb-plugins
/plugin install deep-plan@piercelamb-plugins
/plugin install deep-implement@piercelamb-plugins
/plugin install caveman@caveman
```

### 5. Clone the projects

DevNeural is the one that takes work; the others are mostly clone-and-go:

```powershell
git clone https://github.com/Omnib0mb3r/DevNeural             C:\dev\Projects\DevNeural
git clone https://github.com/Omnib0mb3r/devneural-projects    C:\dev\Projects\devneural-projects
git clone https://github.com/Omnib0mb3r/dev-template          C:\dev\Projects\dev-template
git clone https://github.com/Omnib0mb3r/design-system         C:\dev\Projects\design-system
# stream-deck and otlc-guardian: optional, restore from their own remotes
```

### 6. Install DevNeural

```powershell
cd C:\dev\Projects\DevNeural\07-daemon
npm install
npm run setup                                # builds + scaffolds wiki at c:/dev/data/skill-connections/wiki/
npm run install-hooks                        # registers 6 v2 hook entries (Pre/Post/Prompt/Stop/Notification/SessionStart); replaces any v1 entries from step 4
npm run silence-hooks                        # wraps every hook in silent-shim.exe so child spawns run hidden; idempotent

cd C:\dev\Projects\DevNeural\08-dashboard
npm install --legacy-peer-deps               # @tremor/react has a React-18 peer expectation; works on 19
npm run build                                # produces 08-dashboard/out/ (prebuild rimraf + next build + SW version stamp)

cd C:\dev\Projects\DevNeural\09-bridge
npm install
npm run build
npm run package
code --install-extension devneural-bridge.vsix
```

### 7. Optional: restore the wiki + reference corpus

If you have a backup of `c:/dev/data/skill-connections/`:

```powershell
robocopy <backup>\skill-connections C:\dev\data\skill-connections /MIR /XJ
```

If you don't, the system rebuilds from observed sessions over the first few days of use.

### 8. Optional: audio/video binaries

If you want Phase 3.5 (audio/video upload) working, follow `docs/install/AUDIO-VIDEO.md`. ffmpeg from step 2; whisper.cpp clone+build separately.

### 9. Start it

```powershell
cd C:\dev\Projects\DevNeural\07-daemon
npm run start                        # daemon listens on 0.0.0.0:3747
                                     # auto-detects 08-dashboard/out/ and serves the dashboard at the same port
npm run install-daemon-autostart     # reboot recovery: Task Scheduler DevNeural-Daemon -> start-daemon.ps1 (npm run start alone does not survive a reboot)
```

Open `http://otlcdev:3747` in any browser on the tailnet, you're back (no PIN gate; the tailnet is the trust boundary).

---

## Verification: did it work?

Run from any tailnet device:

```powershell
curl http://otlcdev:3747/health                  # 200 with phase=P3.2-reference-corpus
curl http://otlcdev:3747/health                  # ok:true confirms the daemon is up; there is no PIN gate (trust boundary is host + tailnet)
curl http://otlcdev:3747/dashboard/health        # rolls up service statuses
curl http://otlcdev:3747/graph                   # graph data for the orb
```

In the dashboard:

- Home shows the daily brief (empty until the lint pass writes whats-new.md)
- Sessions populates as you open Claude Code in any DevNeural-aware repo
- System reports CPU, memory, disks, and the 5 monitored services
- Orb is empty until you have wiki pages with cross-references

---

## What you'd lose if recovery failed mid-way

Categorized by recoverability:

| Item | Lost if `~/.claude` lost | Lost if `c:/dev/data/skill-connections` lost | Lost if the repo is lost |
|---|---|---|---|
| Hook configuration | yes — restore from Claude-Setup | no | no |
| Global CLAUDE.md | yes — restore from Claude-Setup | no | no |
| Plugins | yes — reinstall from marketplaces | no | no |
| Permissions allowlist | yes — restore from Claude-Setup | no | no |
| Wiki pages | no | **yes — irreversible** | no (the daemon source rebuilds; the captured insights do not) |
| Vector embeddings | no | no — rebuildable from raw chunks | no |
| Raw transcript chunks | no | **yes — irreversible** (these capture what Claude saw, second-by-second) | no |
| Reference corpus | no | yes — re-upload | no |
| The dashboard build | no | no | yes — re-clone |
| The daemon code | no | no | yes — re-clone |

The `c:/dev/data/skill-connections/` data root is the irreplaceable thing. Back it up to a separate volume on a schedule.

---

## Backup automation

The data root at `c:/dev/data/skill-connections/` is the only irreversible thing on `OTLCDEV`. Phase 5 ships a robust backup pipeline. Run it once to install the scheduled task; it then runs daily without intervention.

### One-time install

```powershell
cd C:\dev\Projects\DevNeural\07-daemon
npm run install-backup-task                 # daily at 03:00, keep 14 snapshots
```

Override the schedule or retention if you want:

```powershell
npm run install-backup-task -- -Time 04:30 -Keep 30 -BackupRoot D:\backups
```

### What gets captured

Every snapshot at `<backup-root>/<timestamp>/`:

| Folder | What | Method |
|---|---|---|
| `sqlite/` | Every `.sqlite` and `.db` under the data root | `sqlite3 .backup` (atomic point-in-time clone) if sqlite3 is on PATH; falls back to a file copy |
| `files/` | Wiki, vector-store, reference corpus, session-state, dashboard state (auth.json, vapid.json, push-subscriptions.jsonl, reminders.jsonl, notifications.jsonl) | `robocopy /MIR` excluding sqlite (handled separately), models, daemon log |
| `MANIFEST.json` | timestamps, file count, byte total, sqlite count, daemon git commit | written last |

Models (embedder, whisper) are excluded by default since they re-download. Pass `-IncludeModels` to `npm run backup` if you want them inside snapshots (adds ~500 MB per snapshot).

### What gets pruned

The script keeps the last `-Keep` snapshots (default 14) and deletes the rest after a successful run. Snapshots are written as `<timestamp>.partial` first, then atomically renamed to `<timestamp>` once everything succeeds, so a crashed run never leaves a partial snapshot in the rotation.

### Manual operations

```powershell
npm run backup                                  # one-shot snapshot (also called by the scheduled task)
npm run verify-backup                           # PRAGMA integrity_check on every captured sqlite + JSON parse on every state file
npm run restore                                 # picks the most recent; prompts for confirmation; saves a pre-restore safety copy
npm run restore -- -Snapshot 2026-05-04T03-00-00 # restore a specific timestamp
```

`restore` refuses to run while the daemon is up (in-process state would diverge from on-disk). Stop the daemon first or pass `-Force` if you really mean it.

### Daemon hand-shake

`backup.ps1` POSTs `/flush` before reading files. The daemon flushes the in-memory vector buffer to disk and runs `PRAGMA wal_checkpoint(TRUNCATE)` so the snapshot captures the consistent state. Best-effort: if the daemon is down or the endpoint isn't there, the script proceeds cold.

### Verify the schedule landed

```powershell
Get-ScheduledTask -TaskName DevNeural-Backup
Get-ScheduledTaskInfo -TaskName DevNeural-Backup
Start-ScheduledTask -TaskName DevNeural-Backup    # trigger it now to confirm
```

In the Task Scheduler UI: `taskschd.msc` → Task Scheduler Library → DevNeural-Backup.

### What this does NOT cover

- **Off-machine backups.** The default backup root is `C:\dev\backups\skill-connections` on the same machine. Same disk, same fire. Set `-BackupRoot` to a network share, an external disk, or a cloud-synced folder if you want true durability. A common setup is OneDrive: `-BackupRoot "$env:USERPROFILE\OneDrive\devneural-backups"`.
- **The repo source.** Everything under `C:/dev/Projects/DevNeural/` is in git already. Push regularly and you're covered for that. Backup pipeline does not include the repo because it would add hundreds of MB of node_modules and build artifacts that re-create.
- **`~/.claude/`.** Claude-Setup is the canonical recovery source for that. The hooks audit in `05-coexistence-with-claude-setup.md` plus a regular push of redacted settings.json into Claude-Setup keeps that in sync.

## When to re-run this audit

Phase 5 is a snapshot, not a one-time event. Re-run when any of these happen:

- A major plugin is added or removed (changes `enabledPlugins`)
- The `Claude-Setup` repo is updated (the canonical recovery source moved)
- Claude Code's hook protocol changes (new event names, new matcher semantics)
- DevNeural's hook entries change shape
- An OS or shell change alters how paths resolve (rare on Windows; common on macOS migrations)
- You add a new project that needs an `additionalDirectories` entry

The procedure: re-read `~/.claude/settings.json`, re-categorize each entry, update the tables in 05 and the recovery sequence in this file. Commit with message `docs(install): refresh phase 5 audit`.
