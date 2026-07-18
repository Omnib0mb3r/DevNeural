# 07: Troubleshooting

> Symptom-driven fixes. Find the symptom you're seeing, follow the steps.

---

## "ollama unreachable"

**Where you see this:** `npm run status`, `daemon.log`, ingest output.

**Cause:** ollama isn't running, or `DEVNEURAL_OLLAMA_HOST` points at the wrong place.

**Fix:**
```powershell
# Check whether ollama is running
curl http://localhost:11434/api/tags

# If that fails, launch the desktop app or:
ollama serve
```

If you've changed the host:
```powershell
echo $env:DEVNEURAL_OLLAMA_HOST
```
Should be empty (defaults to `http://localhost:11434`) or a valid URL.

---

## "model qwen3:8b not pulled"

**Where:** daemon.log on first ingest, status output.

**Fix:**
```powershell
ollama pull qwen3:8b
```

If qwen3:8b is unavailable in your ollama version:
```powershell
ollama pull qwen2.5:7b-instruct
[Environment]::SetEnvironmentVariable("DEVNEURAL_OLLAMA_MODEL", "qwen2.5:7b-instruct", "User")
```
Then restart your shell so the new env var takes effect.

---

## Hooks aren't firing (no observations being captured)

**Symptom:** `C:/dev/data/skill-connections/projects/<id>/observations.jsonl` doesn't exist or isn't growing.

**Possible causes and fixes:**

1. **Hook not installed.** Run:
   ```powershell
   cd C:/dev/Projects/DevNeural/07-daemon
   npm run install-hooks
   ```

2. **Hook installed but Claude Code isn't seeing it.** Restart Claude Code. Hook config is read at session startup, not hot-reloaded.

3. **Hook is being skipped by guards.** Check `daemon.log` for "skipped" entries. Likely causes:
   - `CLAUDE_CODE_ENTRYPOINT` env not in allowed list (`cli`, `sdk-ts`, `claude-desktop`, `claude-vscode`)
   - `DEVNEURAL_HOOK_PROFILE=minimal` set
   - `DEVNEURAL_SKIP_OBSERVE=1` set
   - cwd matches a path in `DEVNEURAL_OBSERVE_SKIP_PATHS`
   - `.devneural-ignore` file at the project root

4. **dist not built.** Run `npm run build` and verify `dist/capture/hooks/hook-runner.js` exists.

5. **Settings.json is malformed.** Check Claude Code's startup output for errors. Restore from `~/.claude/settings.json.devneural.bak` and re-run `install-hooks`.

---

## Daemon won't lazy-start

**Symptom:** hook fires, but no daemon comes up. `npm run status` shows daemon=warn.

**Causes:**

1. **Port 3747 already in use.**
   ```powershell
   netstat -ano | findstr :3747
   ```
   Either kill the offender or set `DEVNEURAL_PORT` to a free port.

2. **Spawn lock stuck.**
   ```powershell
   Remove-Item C:/dev/data/skill-connections/daemon.lock -Recurse -Force -ErrorAction SilentlyContinue
   ```

3. **Stale PID file.**
   ```powershell
   Remove-Item C:/dev/data/skill-connections/daemon.pid -Force -ErrorAction SilentlyContinue
   ```

4. **dist not built.** `npm run build` in `07-daemon`.

5. **Node not on PATH for the spawned process.** Verify `where node` returns a path. If not, fix PATH.

After fixing, manually start to verify:
```powershell
node C:/dev/Projects/DevNeural/07-daemon/dist/daemon.js
```
Watch for errors. Once it's healthy, kill it (`Ctrl+C`) and let the next hook event lazy-start it normally.

---

## "fetch failed" during ingest, even though ollama is up

**Cause:** ollama process crashed mid-call, or the model failed to load (e.g. out of memory).

**Fix:**
1. Restart ollama
2. Try a smaller model: `DEVNEURAL_OLLAMA_MODEL=qwen2.5:7b-instruct` (or `:3b` if you're tight)
3. Check ollama logs: usually printed to its own console window

The corpus seed will resume on its own after 3 consecutive failures (the abort-after-failures guard).

---

## Wiki pages aren't being created

**Symptom:** ingest runs without errors but `wiki/pending/` stays empty.

**Cause hierarchy:**

1. **`new_page_warranted: false` from Pass 1.** The LLM is saying "no new transferable insight here." This is often correct for short tool calls, syntax questions, or content that's just running existing patterns. Look at `daemon.log` for ingest events; if every ingest reports `affected_candidates=0, new_page_warranted=false`, the model is being too conservative.

2. **Pass 2 producing pages that fail validation.** Check daemon.log for `pass2 failed after N attempts`. The validator is rejecting outputs because:
   - Title missing `→`
   - Summary too long
   - No evidence cited
   - Body too long

   The repair retry should handle most. If it consistently fails, the local model is producing weak structured output. Try a stronger model.

3. **Schema document is wrong.** If you've edited `wiki/DEVNEURAL.md` heavily, the LLM may be following bad instructions. Restore from `docs/spec/DEVNEURAL.md`:
   ```powershell
   Copy-Item C:/dev/Projects/DevNeural/docs/spec/DEVNEURAL.md C:/dev/data/skill-connections/wiki/DEVNEURAL.md
   ```

---

## Search returns nothing

**Symptom:** `POST /search` returns empty results even though you've used the system for a while.

**Causes:**

1. **Embedder didn't load.** First call is slow (model download). If it errored, see daemon.log. Try a manual warm:
   ```powershell
   curl -X POST -H "Content-Type: application/json" -d '{\"q\":\"hello\",\"collection\":\"raw_chunks\"}' http://127.0.0.1:3747/search
   ```

2. **No content to find.** Check vector store sizes via `/health`. If both `raw_chunks` and `wiki_pages` are 0, capture isn't producing or hasn't been triggered yet.

3. **Wrong collection.** Search defaults to `raw_chunks`. Try with `"collection":"wiki_pages"`.

---

## Claude isn't using my injected context

**Symptom:** UserPromptSubmit hook fires, `/curate` returns a non-empty injection, but Claude's reply doesn't seem to use it.

**Possible explanations:**

1. **Injection actually IS being used, but subtly.** The reinforcement loop measures cosine of reply vs page summary. Check `reinforcement.log.jsonl` for hit/no-hit decisions. Cosine threshold is 0.65 by default; lower it if you're sure pages are helping but not crossing the bar:
   ```powershell
   [Environment]::SetEnvironmentVariable("DEVNEURAL_HIT_COSINE", "0.55", "User")
   ```

2. **Page is irrelevant.** Cosine search returned a page because nothing else was closer, but the page wasn't actually a fit. Increase the floor:
   ```powershell
   [Environment]::SetEnvironmentVariable("DEVNEURAL_COSINE_FLOOR_WIKI", "0.65", "User")
   ```
   Better to inject nothing than wrong context.

3. **Claude saw the injection but chose not to use it.** That's the system working correctly; the page wasn't actually useful for THIS prompt. Reinforcement will adjust.

---

## Reinforcement isn't updating page weights

**Symptom:** Pages always at weight 0.30, no hits, no corrections recorded.

**Cause:** the transcript watcher isn't seeing assistant turns, or the pending-injection tracker is timing out before the reply.

**Fix:**

1. Verify transcript watcher is running:
   ```powershell
   curl http://127.0.0.1:3747/health
   ```
   Should report `phase: P3.2-reference-corpus`.

2. Check `daemon.log` for `[transcript-watcher]` lines as you use Claude. Should show `+N chunks` events.

3. If the reply takes longer than 10 minutes (PENDING_TTL), the pending injection is dropped. Reinforcement only fires if the reply lands within that window.

---

## SQLite "database is locked"

**Cause:** previous daemon crashed without releasing the WAL.

**Fix:**
```powershell
taskkill /F /PID (Get-Content C:/dev/data/skill-connections/daemon.pid) -ErrorAction SilentlyContinue
Remove-Item C:/dev/data/skill-connections/index.db-shm -Force -ErrorAction SilentlyContinue
Remove-Item C:/dev/data/skill-connections/index.db-wal -Force -ErrorAction SilentlyContinue
node C:/dev/Projects/DevNeural/07-daemon/dist/daemon.js
```

---

## Wiki git repo has conflicts

**Symptom:** daemon.log reports git commit failures during ingest.

**Cause:** something else (you, a backup tool) modified a file in `wiki/` while the daemon was about to commit.

**Fix:**
```powershell
cd C:/dev/data/skill-connections/wiki
git status
git stash      # or git add -A && git commit -m "manual"
```

---

## Disk almost full

**Symptom:** writes failing, daemon erroring.

**Where space goes:**

```powershell
# Top directories
Get-ChildItem C:/dev/data/skill-connections -Recurse -Directory | Measure-Object -Property Length -Sum
```

Likely culprits:
- Old observation archives — auto-purge after 30 days but verify
- `chroma/collections/` — grows with usage
- `models/` — only ~90MB but could be more if you've installed multiple
- Daemon log — rotates? not in v1; manually truncate if huge

To manually truncate the log:
```powershell
Stop-Service ... # if you've made daemon a service
Clear-Content C:/dev/data/skill-connections/daemon.log
```

To manually purge old archive data:
```powershell
Get-ChildItem C:/dev/data/skill-connections/projects/*/observations.archive -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item
```

---

## Hook firing on every keystroke / too noisy

**Cause:** unlikely for hooks themselves (Claude Code only fires PreToolUse / PostToolUse on actual tool calls), but if you're seeing absurd hook frequency, check:

1. The `signal_every_n` throttle (default 20 events). Daemon doesn't process every observation; it batches.
2. Whether you accidentally enabled some other tool's hook chain that's flapping.

For now: not a known DevNeural failure mode.

---

## Audio upload says "transcript_extracted: 0" or daemon log shows "whisper exited with code 1"

**Cause:** `DEVNEURAL_WHISPER_BIN` is set to `C:\dev\whisper.cpp\Release\main.exe`. Recent whisper.cpp builds replaced `main.exe` with a deprecation stub that prints a warning and exits without transcribing. The audio module then sees no `.txt` output and reports failure.

**Fix:**
```powershell
setx DEVNEURAL_WHISPER_BIN "C:\dev\whisper.cpp\Release\whisper-cli.exe"
# Restart the daemon so the new env value is inherited
taskkill /F /PID (Get-Content C:/dev/data/skill-connections/daemon.pid) -ErrorAction SilentlyContinue
cd C:\dev\Projects\DevNeural\07-daemon; powershell -File scripts\start-daemon.ps1
```

Alternative: unset the env var entirely so `audio.ts` falls back to its built-in path list (which already prefers `whisper-cli.exe` over `main.exe`).

---

## PostToolUse / PreToolUse hook errors: "silent-shim.exe: silent-shim.exe: cannot execute"

**Cause:** older `silence-all-hooks.ps1` versions used cmd-style `""` to escape inner-arg quotes. Bash (Claude Code's shell on Windows) treats `""` as empty-string concatenation, so the inner exe path collapses with its arguments and `silent-shim` tries to launch a path fragment.

**Fix:**
```powershell
cd C:\dev\Projects\DevNeural\07-daemon
powershell -File scripts\reescape-hook-args.ps1   # one-shot: rewrites "" -> \"
```

If you ever ran an old `silence-all-hooks.ps1` more than once, the detection regex bug may also have wrapped your hooks in two layers of `silent-shim`. Repair with:
```powershell
powershell -File scripts\repair-double-wrapped-hooks.ps1   # peels one shim layer where double-wrapped
```

Both scripts back up `~/.claude/settings.json` before writing and accept `-DryRun` to preview. Re-running `silence-all-hooks.ps1` is idempotent on the corrected state.

---

## Dashboard "Restart Daemon" returns "start-daemon.ps1 not found at C:\dev\Projects\DevNeural\scripts\start-daemon.ps1"

**Cause:** old daemon build (pre 2026-05-09). The restart endpoint resolved the script via `process.cwd()`, which is the project root when launched by Task Scheduler / autostart, not `07-daemon/`. Real path is `07-daemon/scripts/start-daemon.ps1`.

**Fix:** rebuild and restart the daemon.
```powershell
cd C:/dev/Projects/DevNeural/07-daemon
npm run build
taskkill /F /PID (Get-Content C:/dev/data/skill-connections/daemon.pid) -ErrorAction SilentlyContinue
powershell -File scripts/start-daemon.ps1
```

The fix in `src/dashboard/routes.ts` resolves the script relative to the compiled module via `fileURLToPath(import.meta.url)`, so cwd is irrelevant. Affects local browser and Tailscale access equally.

---

## "I don't know what changed but it's slow"

```powershell
cd C:/dev/Projects/DevNeural/07-daemon
npm run status
Get-Content C:/dev/data/skill-connections/daemon.log -Tail 100
curl http://127.0.0.1:3747/health
```

Share the output with whoever is helping (or your future self via memory).

---

## Total reset (nuclear option)

If everything is broken and you've tried the tier 1-4 recoveries in `06-recovery-and-reconstruction.md`:

```powershell
# Stop daemon
taskkill /F /PID (Get-Content C:/dev/data/skill-connections/daemon.pid) -ErrorAction SilentlyContinue

# Backup everything you might want
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Compress-Archive C:/dev/data/skill-connections "C:/Backups/devneural-everything-$stamp.zip"

# Restore Claude settings.json from backup
Copy-Item $env:USERPROFILE\.claude\settings.json.devneural.bak $env:USERPROFILE\.claude\settings.json -Force

# Wipe DevNeural data + dist
Remove-Item C:/dev/data/skill-connections -Recurse -Force
Remove-Item C:/dev/Projects/DevNeural/07-daemon/dist -Recurse -Force
Remove-Item C:/dev/Projects/DevNeural/07-daemon/node_modules -Recurse -Force

# Reinstall
cd C:/dev/Projects/DevNeural/07-daemon
npm install
npm run setup
```

Done. Anything important is in the backup zip.

---

## When in doubt

Run, in order:
1. `cd 07-daemon && npm run status`
2. `Get-Content C:/dev/data/skill-connections/daemon.log -Tail 50`
3. `curl http://127.0.0.1:3747/health`

These three answer most "is something wrong" questions in 30 seconds.

---

## Session-end pipeline didn't run

**Symptom:** A voice or brainstorm session ended but the rolling session summary at `C:/dev/data/skill-connections/session-state/<sid>.summary.md` is stale, or no `kind:'brainstorm-summary'` chunk shows up in retrieval.

**Diagnose:**
```powershell
Get-Content C:/dev/data/skill-connections/daemon.log -Tail 100 | Select-String "session-end"
```

You should see at least:
- `[session-end] embedded brainstorm-summary mode=<conversation|notes|push-to-talk> ...`

If you only see `[session-end] ... no claude session id; skipping pipeline`: the session ended before its jsonl was discovered. Expected for very-short sessions.

If you see `[auto-ingest:force] ... nothing past cursor`: the wiki ingest cursor was already caught up; the summary still embeds.

If you see `LLM not configured`: check `npm run status` for the LLM provider line. Either ollama is not reachable or `DEVNEURAL_LLM_PROVIDER` is set to `none`.

---

## Wiki page weights aren't decaying

**Symptom:** `wiki_pages_meta` shows pages with `last_touched_ms` from weeks ago at full weight.

**Check the daily decay tick:**
```powershell
Get-Content C:/dev/data/skill-connections/daemon.log -Tail 200 | Select-String "decay"
```

You should see `[decay] interval started, every 86400s` on daemon boot.

If you see `[decay] interval disabled`: `DEVNEURAL_DECAY_INTERVAL_MS=0` is set. Unset it (or pick a non-zero ms value) and restart the daemon.

For an immediate decay run without waiting for the 24h tick:
```powershell
curl -X POST http://127.0.0.1:3747/decay
```

---

## Wiki Pass 2 keeps failing on borderline hardware

**Symptom:** `daemon.log` shows `[ingest] pass2 failed: pass2 failed after N attempts: ...` repeatedly. `wiki/pending/` has fewer pages than expected.

**Enable the Anthropic fallback:**
```powershell
[Environment]::SetEnvironmentVariable("DEVNEURAL_PASS2_FALLBACK", "anthropic", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

Restart the daemon. After this, exhausted local Pass 2 calls retry once against Anthropic Haiku. Verify with:
```powershell
Get-Content C:/dev/data/skill-connections/daemon.log -Tail 200 | Select-String "fallback"
```

You should see `[ingest] pass2 fallback to anthropic after local exhaustion` followed by `[ingest] pass2 fallback succeeded`.

---

## Cross-project pages keep getting flagged

**Symptom:** Many wiki pages have `flag_for_review: true` in their frontmatter and `## Log` entries like `verifier: cross-project evidence flagged (project X)`.

**Why:** When a page first gains evidence from a 2nd project, the cross-project verifier asks the LLM whether the new evidence describes the same recurring pattern. False/uncertain → flag instead of silent merge. This is correct behaviour; the goal is to prevent vocabulary collisions ("logging" in two domains) from fusing into one page.

**Resolution:** Open the flagged page, look at the new evidence chunk, decide:
- Same pattern → set `flag_for_review: false`, `human_edited: true`. The page now ignores future verifier passes.
- Different pattern → split into a new page, remove the misplaced evidence, set `flag_for_review: false`.

If the verifier is firing too aggressively for your taste (e.g. local LLM is conservative), you can disable it by setting `DEVNEURAL_LLM_PROVIDER=none` for the verifier role only — but that defeats the purpose. Better to lean on the flag and triage manually.

---

## Sessions flip to inactive after daemon restart

**Symptom:** After restarting the DevNeural daemon, the `/sessions` panel shows every session as inactive even though Claude Code jsonl files are being appended. Stream Deck tiles grey out. The state usually self-heals after the deck tray app re-registers identity files.

**Why:** The daemon's session-liveness path prefers the deck tray identity directory (`%LOCALAPPDATA%/stream-deck/identity/`) as the authoritative live-set. The identity files have an mtime freshness window (default 1h). If the deck tray app is slow to re-register after a daemon restart, or the host's filesystem journal lags, every identity file can age past the window simultaneously and the daemon flips to the mtime fallback only after the entire window elapses.

**Workaround:** widen the freshness window via `DEVNEURAL_IDENTITY_FRESH_MS` (milliseconds, clamped to `[1000, 86_400_000]`). 15s is overkill defensively; the daemon defaults to 1h.

```powershell
[Environment]::SetEnvironmentVariable("DEVNEURAL_IDENTITY_FRESH_MS", "15000", "User")
```

Restart the daemon. Subsequent identity-file reads accept files up to 15s old as live before falling back to mtime-based liveness.
