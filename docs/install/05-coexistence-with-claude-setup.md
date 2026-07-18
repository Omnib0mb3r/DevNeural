# 05: Coexistence with Claude-Setup

> How DevNeural fits alongside the existing Claude setup recorded at https://github.com/Omnib0mb3r/Claude-Setup, plus other plugins (superpowers, GSD, deep-implement, deep-plan, etc.) without nuking them.
>
> This file holds the coexistence rules plus the concrete inventory of the actual `~/.claude/settings.json` and `~/.claude/CLAUDE.md` content on `OTLCDEV`, captured by the Phase 5 settings audit.

---

## The relationship

`Claude-Setup` is the canonical record of how the user's Claude Code installation is configured: hooks, MCPs, statusline, plugins, global `CLAUDE.md`. It is the recovery source if `~/.claude/` is wiped.

`DevNeural` is one *contributor* to that configuration. It adds 6 hook entries to `~/.claude/settings.json` and reads (but never writes) several other things in `~/.claude/`.

The rule: **DevNeural never assumes ownership of any file it didn't create.** Anything in `~/.claude/` that pre-exists is treated as "user-owned, do not modify."

---

## Hooks: the only thing DevNeural writes outside its data root

Of all the things in `~/.claude/`, only `settings.json` is modified by DevNeural, and only the `hooks` block, and only specific entries DevNeural recognizes as its own.

**DevNeural's hook entries (added by `npm run install-hooks`):**

| Event | Matcher | Phase arg | Purpose |
|---|---|---|---|
| `PreToolUse` | `*` | `pre` | Captures tool-start observation |
| `PostToolUse` | `*` | `post` | Captures tool-complete observation |
| `UserPromptSubmit` | (none) | `prompt` | Captures prompt + posts to `/curate` for injection |
| `Stop` | (none) | `stop` | Marks session_stop, clears any pending permission prompt |
| `Notification` | (none) | `notification` | Captures CC's permission/elicitation message; posts to `/sessions/:id/pending-prompt` so the dashboard surfaces it with answer buttons |
| `SessionStart` | (none) | `session_start` | Marks the prior session in this workspace as superseded on `/clear` |

Each entry is materialized by `install-hooks.ts` as a wscript-wrapped invocation of `silent-runner.vbs <phase>`, which in turn launches `node "07-daemon/dist/capture/hooks/hook-runner.js" <phase>`. The whole thing is then re-wrapped by `silence-all-hooks.ps1` in `silent-shim.exe` so the hook runs invisibly (no console flash) on Windows.

**Inner-arg escape convention:** `silent-shim.exe` takes one quoted argument that is the inner command. Embedded `"` characters inside that argument are escaped with backslash `\"`, NOT cmd-style `""`. Reason: Claude Code on Windows runs hook commands through bash (Git Bash), and bash treats `""` inside `"..."` as empty-string concatenation rather than an escaped quote. `\"` is honored by both bash dq AND the Windows CRT (CommandLineToArgvW), so the wrap survives either invocation path. If you re-run `silence-all-hooks.ps1`, it now no-ops on already-wrapped entries (anchored detection regex).

**Detection rules used by `install-hooks`:**

- An entry is "DevNeural v2" if its command contains `07-daemon/dist/capture/hooks/hook-runner.js` OR `07-daemon/dist/capture/hooks/silent-runner.vbs` (raw and wrapped forms both detected).
- An entry is "DevNeural v1" if its command contains `01-data-layer/dist/hook-runner.js` or `04-session-intelligence/dist/session-start.js`. Purged on every install.
- All other entries are treated as foreign and **left alone**.

**Install behavior:**

1. Back up `~/.claude/settings.json` to `~/.claude/settings.json.devneural.bak`.
2. Strip any existing DevNeural v1 or v2 entries from the `hooks` block.
3. Add the six v2 entries above.
4. Write the file. All non-DevNeural entries (other hooks, plugin entries, MCP servers, model preferences, statusline, etc.) are preserved exactly.

---

## What DevNeural reads but never writes

- `~/.claude/CLAUDE.md` — your global instructions. DevNeural reads it as part of session context but never modifies.
- `~/.claude/skills/**/SKILL.md` — used as initial corpus seed material.
- `~/.claude/plugins/**/SKILL.md` — same.
- `~/.claude/projects/<slug>/<session>.jsonl` — session transcripts. Read incrementally via byte offset; never written to.
- Any other file under `~/.claude/` — not touched.

---

## Plugins DevNeural is known to coexist with

DevNeural has been verified to coexist with these (their hooks remain functional after DevNeural install):

- `superpowers` (skills, hooks, MCP)
- `deep-implement`, `deep-plan`, `deep-project`
- `gsd` family
- `cli-anything`
- standalone helpers like `gsd-statusline`, `gsd-context-monitor`, `gsd-prompt-guard`, `gsd-check-update`

If you have other plugins, DevNeural's surgical hook editing should leave them alone, but verify by diff:

```powershell
git diff (Get-Content $env:USERPROFILE\.claude\settings.json.devneural.bak) (Get-Content $env:USERPROFILE\.claude\settings.json)
```

You should only see additions to the `hooks` block.

---

## Phase 5 audit: actual `OTLCDEV` settings inventory

> Captured 2026-05-04 from `~/.claude/settings.json` on `OTLCDEV`. Refresh whenever a major plugin is added or the `Claude-Setup` repo updates. No secrets present in this snapshot; `[REDACTED]` placeholders shown for any field that would carry one.
>
> **Refresh note 2026-05-04 (later in day):** the v1 entries in the inventory below were migrated to v2 by `install-hooks`; all hook entries are now silent-shim-wrapped with backslash-escaped inner args; and a fifth DevNeural entry was added for the `Notification` event so CC permission prompts surface in the dashboard. The duplicates flagged with `!` below were not removed; they remain pending the next manual `dedupe-hooks` pass. Counts in the per-event tables therefore reflect the pre-migration snapshot, not the current state.

### Top-level shape

| Field | Value |
|---|---|
| `env` | empty `{}` |
| `permissions.defaultMode` | `dontAsk` |
| `skipDangerousModePermissionPrompt` | `true` |
| `voiceEnabled` | `true` |
| `agentPushNotifEnabled` | `true` |
| `effortLevel` | `high` |

The harness runs in `dontAsk` mode with the dangerous-mode prompt suppressed. This is intentional for a single-user developer machine inside Tailscale; do not export this verbatim to a less-trusted machine.

### Permission allowlist

Wide allow + targeted deny. Build tools, FS tools, search tools, web tools, both Anthropic-shipped MCPs (`mcp__monday-mcp__*`, `mcp__magic__*`) and a single skill (`Skill(codex)` + `Skill(codex:*)`).

Deny list is the standard destructive set: `rm -rf`, `del /s|/f`, `rmdir /s`, `rd /s`, `sudo`, `su`, `chmod 777`, `dd`, `mkfs`, `format`, `shutdown`, `reboot`, `git push --force|-f`, `git reset --hard`, `git clean -fd`, `reg delete|add`, `taskkill /f`.

### Additional working directories (11)

Beyond the cwd, the harness also has read/write under:

- `C:\dev\data\skill-connections` — DevNeural data root
- `C:\dev\Projects\DevNeural` — this repo
- `C:\dev` — convenience for cross-project work
- `~/.claude` and `~/.claude/skills` — for skill authoring
- `~/.claude/projects/c--dev-Projects-devneural-projects` — devneural-projects sibling repo
- `C:\tmp` — scratch
- `C:\dev\Projects\autolisp-skill` and `~/.claude/skills/autolisp` — AutoLISP skill workspace
- `C:\dev\Projects\New-Letter-and-TikToks\docs\superpowers` — sibling project
- `C:\dev\Projects\otlc-guardian\.claude` — guardian project sandbox

If you wipe `~/.claude/`, this list does NOT regenerate automatically; capture it from the backup before nuking anything.

### Hook inventory (categorized)

Every entry that the harness runs at every event, with the owner. **`!`** marks a duplicate that should be deduped by the next install-hooks run.

#### `SessionStart` (10 entries)

| # | Owner | Purpose |
|---|---|---|
| 1 | gsd standalone | `~/.claude/hooks/gsd-check-update.js` — checks GSD plugin for updates |
| 2 | plugin: deep-project | `capture-session-id.py` (uv-runs Python) — records session id for /deep-plan + /deep-implement |
| 3 | DevNeural v1 (`startup` matcher) | `04-session-intelligence/dist/session-start.js` — loads context (10s timeout) |
| 4 | DevNeural v1 (`resume` matcher) | same file, no statusMessage |
| 5 | DevNeural v1 (`clear` matcher) | same file |
| 6 | DevNeural v1 (`compact` matcher) | same file |
| 7 | devneural-projects | `c:/dev/Projects/devneural-projects/scripts/fill-devneural.mjs` — fills `devneural.jsonc` placeholders |
| 8 | stream-deck (.NET app) | `session-start.sh` |
| 9 | stream-deck (.NET app) | same file `!` (duplicate of #8) |
| 10 | plugin: caveman | `caveman-activate.js` |

#### `PostToolUse` (4 entries)

| # | Matcher | Owner | Purpose |
|---|---|---|---|
| 1 | `Bash\|Edit\|Write\|MultiEdit\|Agent\|Task` | gsd standalone | `gsd-context-monitor.js` |
| 2 | `*` | DevNeural v1 | `01-data-layer/dist/hook-runner.js` (transcript ingest) |
| 3 | (none) | stream-deck | `deck-hook.sh working` |
| 4 | (none) | stream-deck | same `!` (duplicate of #3) |

#### `PreToolUse` (3 entries)

| # | Matcher | Owner | Purpose |
|---|---|---|---|
| 1 | `Write\|Edit` | gsd standalone | `gsd-prompt-guard.js` |
| 2 | (none) | stream-deck | `deck-hook.sh pending` |
| 3 | (none) | stream-deck | same `!` (duplicate of #2) |

#### `UserPromptSubmit` (4 entries)

| # | Owner | Purpose |
|---|---|---|
| 1 | DevNeural | `~/.claude/hooks/devneural-skill-tracker.js` |
| 2 | stream-deck | `deck-hook.sh working` |
| 3 | stream-deck | same `!` (duplicate of #2) |
| 4 | plugin: caveman | `caveman-mode-tracker.js` |

#### `Stop` (2 entries) — both stream-deck `deck-hook.sh idle`, second is a `!` duplicate.

#### `Notification` (6 entries) — three matchers (`permission_prompt`, `idle_prompt`, `elicitation_dialog`) each registered twice on the stream-deck hook. All three duplicates should be removed.

#### `SessionEnd` (2 entries) — both stream-deck `session-end.sh`, second is `!` duplicate.

### Statusline

Owner: gsd standalone. Command: `node "~/.claude/hooks/gsd-statusline.js"`.

### Enabled plugins

| Slug | Marketplace | Role |
|---|---|---|
| `superpowers` | claude-plugins-official | TDD, brainstorming, debugging, parallel agents, plan/execute |
| `caveman` | caveman | Mode tracker (focus discipline) |
| `deep-project` | piercelamb-plugins | High-level requirements decomposition |
| `deep-plan` | piercelamb-plugins | Sectionized TDD plans |
| `deep-implement` | piercelamb-plugins | Implementation from plans |

`extraKnownMarketplaces` registers the `piercelamb/deep-project` GitHub source and the `JuliusBrussee/caveman` source. Anthropic's official marketplace is implicit.

### Standalone hook scripts in `~/.claude/hooks/`

Inventory (all are committed to `Claude-Setup`, not DevNeural):

- `caveman-activate.js`, `caveman-mode-tracker.js`, `caveman-config.js`, `caveman-stats.js` — caveman plugin runtime
- `caveman-statusline.ps1`, `caveman-statusline.sh` — statusline (not currently bound; gsd is)
- `devneural-skill-tracker.js` — DevNeural-owned skill-usage telemetry, hooked at `UserPromptSubmit`
- `gsd-check-update.js`, `gsd-context-monitor.js`, `gsd-prompt-guard.js`, `gsd-statusline.js`, `gsd-workflow-guard.js` — GSD plugin runtime (some referenced by hooks above, others available as workflow guardians)
- `package.json` — npm shim so `node "~/..."` paths can resolve modules

### Duplicates flagged

Re-running `cd 07-daemon && npm run install-hooks` will **not** dedupe non-DevNeural entries. The seven `!` duplicates above came from running stream-deck's installer twice. To clean them up by hand, edit `~/.claude/settings.json` and remove the second occurrence of every duplicate group; back up first.

### Migration note: v1 → v2

This snapshot shows DevNeural **v1** hooks (`01-data-layer/...`, `04-session-intelligence/...`). The v2 install-hooks installer (`07-daemon/dist/capture/hooks/install-hooks.js`) is designed to detect both v1 paths and replace them with the six v2 entries that route through `07-daemon/dist/capture/hooks/hook-runner.js`. Run it once to migrate:

```powershell
cd C:\dev\Projects\DevNeural\07-daemon
npm run install-hooks
```

The installer backs up `~/.claude/settings.json` to `~/.claude/settings.json.devneural.bak` before any change.

### `CLAUDE.md` (global) inventory

Not duplicated here (the file is private to this user). Sections noted at audit time:

- Project Context (read OTLC-Brainstorm.md if present)
- Security (no `echo $VAR`, redact secrets, sanitize file dumps)
- User Input (case-insensitive normalization)
- Unknown Commands and References (stop and ask)
- Answering Questions (answer and stop, no implicit action)
- No Em Dashes (durable rule)
- Correcting Confusion (correct misunderstandings, do not encode them as memory)
- Commits (no `Co-Authored-By: Claude`, no AI attribution)
- Windows Environment (PowerShell-native, no bash idioms)
- Autonomy (act autonomously, escalate architecture/scope/dep changes)
- Root Cause First (no workarounds unless truly the only option)
- Bluntness (call out obvious mistakes directly)
- Output Style (full file paths, recommendation-first numbered options)

These rules are user-owned; DevNeural reads them but never writes.

### MCP servers

`settings.json` does not register MCP servers globally on this install. MCPs are project-scoped via `.claude/settings.local.json` per project (Chrome DevTools, Playwright, Context7 are surfaced for projects that need them).

### Backup checklist before wiping `~/.claude/`

If you ever need to nuke and rebuild:

1. `~/.claude/settings.json` — single source of truth for hooks, permissions, plugins, statusline
2. `~/.claude/CLAUDE.md` — global rules
3. `~/.claude/skills/` — your private skills (currently `OTLC-Design/SKILL.md`)
4. `~/.claude/hooks/` — every standalone script (10+ files; all from caveman, gsd, devneural)
5. `~/.claude/plugins/cache/<marketplace>/` — plugin sources (re-installable from marketplaces, but cache speeds it up)
6. `~/.claude/agents/` — custom subagent definitions (if any)
7. `~/.claude/commands/` — custom slash commands (if any)
8. `~/.claude/projects/<slug>/<sid>.jsonl` — session transcripts; DevNeural reads these incrementally so losing them is an irreversible memory loss

Push the redacted version of items 1–4 into `Claude-Setup` after each material change. The transcripts in item 8 are NOT pushed anywhere; they live only on `OTLCDEV`.

---

## What you do if Claude-Setup and DevNeural disagree

`Claude-Setup` is the canonical recovery source for everything except DevNeural's own additions. So:

- If `~/.claude/settings.json` is corrupted, restore from Claude-Setup, then run `cd 07-daemon && npm run install-hooks` to re-add DevNeural's entries.
- If `~/.claude/CLAUDE.md` is corrupted, restore from Claude-Setup. DevNeural is not involved.
- If a plugin breaks, restore from Claude-Setup or reinstall the plugin. DevNeural is not involved.
- If DevNeural's daemon misbehaves, see `07-troubleshooting.md`. Do not restore from Claude-Setup; it doesn't own DevNeural's data.

---

## What goes in Claude-Setup vs what goes in DevNeural

| Lives in Claude-Setup | Lives in DevNeural |
|---|---|
| Global `CLAUDE.md` | The wiki, the daemon, the dashboard |
| Standalone hook scripts under `~/.claude/hooks/` | DevNeural hook script (under DevNeural repo) |
| Plugin install commands | DevNeural setup commands |
| MCP server registrations (other than DevNeural's) | DevNeural's own MCP registration if/when added |
| Statusline config | (none) |
| Theme / model preferences | (none) |
| The reference copy of `settings.json` (your canonical version) | The six hook entries DevNeural adds at install time |

Treat them as independent: Claude-Setup is your machine's nervous system config, DevNeural is one organ that hooks into it.

---

## Reconstruction order if you start over

If `OTLCDEV` is wiped and you need to rebuild from scratch:

1. **Install OS** + Windows updates.
2. **Install prereqs** (Node, Git, ollama, VS Code, Tailscale, Claude Code) per `01-prerequisites.md`.
3. **Restore `~/.claude/`** from your `Claude-Setup` repo:
   - clone the repo
   - copy `settings.json` to `~/.claude/`
   - copy `CLAUDE.md` to `~/.claude/`
   - copy the standalone hook scripts to `~/.claude/hooks/`
   - reinstall any plugins via `/plugin install` in Claude Code
4. **Pull the ollama model** (`ollama pull qwen3:8b`).
5. **Clone DevNeural** to `C:/dev/Projects/DevNeural/`.
6. **Run setup**: `cd 07-daemon && npm install && npm run setup`.
7. The setup will detect existing hooks (from step 3), not nuke them, and add DevNeural's six entries (Pre/Post/Prompt/Stop/Notification/SessionStart). Then run `npm run silence-hooks` to wrap every hook in `silent-shim.exe`.
8. **Optionally restore your wiki** from a backup (see `06-recovery-and-reconstruction.md`).
9. **Run npm run status** to verify.

You should be back in working order in under an hour, most of which is OS install and ollama model download.

---

Continue to `06-recovery-and-reconstruction.md` for the disaster-recovery procedures.
