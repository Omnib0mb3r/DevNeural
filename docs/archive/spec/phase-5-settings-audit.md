# Phase 5: Settings audit and personalized install docs

> Status: complete. Settings.json shape audited, all hooks wrapped via silent-shim.exe (07-daemon/scripts/silent-shim). Off-site backup pipeline verified end-to-end: daily 03:00 task points at the OneDrive path, and the wiki repo is now mirrored to the private `Omnib0mb3r/devneural-wiki` GitHub repo with a daemon-side push every 5 min. Audio/video pipeline verified end-to-end (extractAudioTranscript ok on a generated mp3); a stale `DEVNEURAL_WHISPER_BIN` env var that pinned the deprecated `main.exe` stub was corrected to `whisper-cli.exe` and the daemon was restarted. Phase 4 Orb shipped. Notification hook added: hook-runner now handles a fifth phase (`notification`) and the dashboard surfaces CC's permission/elicitation prompts with answer buttons (see `feat(notification)`). silent-shim escape switched from cmd-style `""` to backslash `\"` so the wrap survives bash invocation; detection regex anchored so re-runs are idempotent.
> Last updated: 2026-05-04.

---

## Why deferred

The install documentation under `docs/install/` is structurally complete, but five files (especially `05-coexistence-with-claude-setup.md`) intentionally hold placeholders for personalized contents. The contents in `~/.claude/settings.json` and `~/.claude/CLAUDE.md` will change during Phase 1-4 work as plugins are added or removed, hooks are tweaked, and DevNeural's surface evolves.

Capturing the personalized inventory mid-flight produces stale documentation that has to be rewritten anyway. Phase 5 captures it once the system has stabilized.

---

## Scope

Phase 5 is a documentation-only phase. No code changes. The deliverables are updates to existing files, not new modules.

### Inputs

- `~/.claude/settings.json` on `OTLCDEV` (current state)
- `~/.claude/CLAUDE.md` on `OTLCDEV` (the global)
- `~/.claude/skills/` directory listing
- `~/.claude/plugins/` directory listing
- `~/.claude/hooks/` standalone scripts (if any)
- The `Omnib0mb3r/Claude-Setup` repo as the canonical recovery model
- The `Omnib0mb3r/dev-template` repo for new-project context

### Outputs (file updates)

1. **`docs/install/05-coexistence-with-claude-setup.md`** — fill in:
   - Concrete current contents of `settings.json` with secrets redacted
   - Per-hook annotation (DevNeural / Claude-Setup / plugin / standalone)
   - Per-MCP annotation
   - Plugin list with version + role
   - Standalone hook script inventory
   - The "what to back up before wiping" checklist keyed to Claude-Setup's recovery model
   - Diff of `settings.json` before vs after DevNeural was installed

2. **`docs/install/03-files-and-paths.md`** — replace generic per-user examples with the actual per-user paths for `OTLCDEV`.

3. **`docs/install/04-step-by-step.md`** — flag any steps where the user has customized behavior (custom data root, custom model, custom hook profile) so they're not surprised on a rebuild.

4. **New file: `docs/install/08-personalized-recovery.md`** — a single `OTLCDEV`-specific recovery checklist that ties Claude-Setup, dev-template, and DevNeural together for one-shot reconstruction.

### What is NOT in scope

- Inspecting the `Claude-Setup` repo itself (that's its own concern)
- Editing or "improving" the user's `~/.claude/CLAUDE.md`
- Removing plugins or hooks
- Touching MCP credentials in any way

---

## Procedure when Phase 5 runs

1. **Read** `~/.claude/settings.json` with secret redaction in place per the user's CLAUDE.md (any value matching the secret-scrub regex becomes `[REDACTED]`).
2. **Categorize** each entry by ownership:
   - `devneural` — created by `install-hooks` from this repo
   - `claude-setup` — listed in the Claude-Setup repo
   - `plugin:<name>` — installed by a Claude Code plugin
   - `standalone` — script under `~/.claude/hooks/` referenced by an inline command
   - `unknown` — flagged for the user to identify
3. **Inventory** all `~/.claude/skills/` and `~/.claude/plugins/` directories.
4. **Render** the personalized contents into the placeholder sections.
5. **Diff** the current `settings.json` against `~/.claude/settings.json.devneural.bak` to show exactly what DevNeural added.
6. **Commit** the updated docs as a single `docs(install): phase 5 settings audit` commit.
7. **Optionally**: push the (redacted) snapshot of settings.json into the Claude-Setup repo so its recovery surface stays fresh.

---

## Triggers

Phase 5 should be re-run whenever:

- The Claude Code hook protocol changes
- A major plugin is added or removed
- The `Claude-Setup` repo is updated
- DevNeural's hook entries change shape (e.g., a new hook event added in a future phase)
- An OS or shell change alters how paths resolve

It is not a one-time event. Treat it as a snapshot to refresh quarterly or after major changes.

---

## Output policy

All outputs of Phase 5 honor the global CLAUDE.md security rules:

- No raw API keys, tokens, or secrets in any committed file
- Sensitive plugin configurations marked `[REDACTED]`
- File paths under `~/` rendered as `~/` (no `C:/Users/<name>/` exposure)
- Backup file references use generic names

---

## Dependencies

- Phase 1 (daemon): done
- Phase 2 (burndown): should be done so the docs reflect the post-burndown state
- Phase 3 (dashboard): should be done so any dashboard-related hooks are documented
- Phase 4 (orb): should be done so orb-related entries (if any) are documented

If you run Phase 5 before all of the above complete, you'll capture a partial state and need to re-run later. That's fine, just expected.

---

*Michael Collins. Stay on the level.*
