# 04: Step-by-step install

> The actual install procedure. Sequenced. Each step has a verification command. If a verification fails, fix that step before continuing.
> Assumes prerequisites from `01-prerequisites.md` are satisfied.

---

## Step 0: Decide your data root

DevNeural defaults to `C:/dev/data/skill-connections/`. To override, set `DEVNEURAL_DATA_ROOT` in your environment before continuing.

```powershell
# Optional: pick a different data root
$env:DEVNEURAL_DATA_ROOT = "D:/devneural-data"
[Environment]::SetEnvironmentVariable("DEVNEURAL_DATA_ROOT", "D:/devneural-data", "User")
```

If you keep the default, do nothing.

---

## Step 1: Clone the repo

```powershell
mkdir C:/dev/Projects -Force
cd C:/dev/Projects
git clone https://github.com/Omnib0mb3r/DevNeural
cd DevNeural
```

**Verify:**
```powershell
ls 07-daemon, docs, INSTALL.md
```

If those exist, you're in the right place.

---

## Step 2: Install npm dependencies for the daemon

```powershell
cd 07-daemon
npm install
```

This pulls everything listed in `02-architecture-and-dependencies.md`. ~250MB of disk.

**Verify:**
```powershell
ls node_modules/.package-lock.json
```

If that file exists, install succeeded.

---

## Step 3: Build the daemon

```powershell
npm run build
```

TypeScript compiles all of `src/` to `dist/`. Should produce no output on success (errors print to stderr).

**Verify:**
```powershell
ls dist/daemon.js, dist/capture/hooks/hook-runner.js, dist/cli/setup.js
```

All three should exist.

---

## Step 4: Run the test suite

```powershell
npm test
```

Expect: the daemon suite passing (703 unit + integration tests as of 2026-05-16).

If a test fails, do not continue. Open an issue or read the failure carefully. Most failures here mean a Node version mismatch or a missing native binary.

---

## Step 5: Run setup

```powershell
npm run setup
```

This is the idempotent setup command. It:

1. Creates the data root and wiki scaffold
2. Pings ollama and reports model availability
3. Installs hooks in `~/.claude/settings.json` (with backup)
4. Prints a final status report

**Expected output (best case):**

```
DevNeural setup
================

▸ Setting up data root at C:/dev/data/skill-connections
  wiki: created=8 updated=0 present=0

▸ Checking ollama at http://localhost:11434
  ollama ready: qwen3:8b, qwen2.5:7b-instruct

▸ Installing Claude Code hooks
[install-hooks] wrote C:/Users/<you>/.claude/settings.json

▸ Final status
DevNeural status
================
  ok   data root   C:/dev/data/skill-connections
  warn daemon      not running (will lazy-start on next hook event)
  ok   hooks       devneural hooks active
  ok   wiki        pages=0 pending=0 archive=0
  ok   llm         ollama http://localhost:11434, model qwen3:8b

setup done.
```

**If ollama is not yet running** or the model is not pulled, setup will say so and tell you what to run. Fix and re-run `npm run setup`.

**If the hook install fails** (most commonly because dist isn't built), re-run `npm run build` then `npm run setup`.

---

## Step 6: Verify hooks are wired (without firing the daemon)

Open `~/.claude/settings.json` and look at the `hooks` block. You should see six entries that resolve to `07-daemon/dist/capture/hooks/hook-runner.js` (after the silent-shim wrap is applied, the path appears inside `silent-runner.vbs`'s args; the raw form is shown below for clarity):

- `PreToolUse` (matcher `*`) → runs `hook-runner.js pre`
- `PostToolUse` (matcher `*`) → runs `hook-runner.js post`
- `UserPromptSubmit` → runs `hook-runner.js prompt`
- `Stop` → runs `hook-runner.js stop`
- `Notification` → runs `hook-runner.js notification` (forwards CC's permission/elicitation message to the daemon so the dashboard surfaces it with answer buttons)
- `SessionStart` → runs `hook-runner.js session_start` (marks the prior session in this workspace as superseded on `/clear`)

Other entries (Claude-Setup hooks, plugin hooks, your own hooks) should be unchanged.

**Apply the silent-shim wrap so spawns run hidden:**
```powershell
npm run silence-hooks
```

This wraps every hook (DevNeural's plus any others) in `silent-shim.exe` so child processes do not flash a console window on every event. Idempotent on re-run.

**Verify the backup exists:**
```powershell
ls $env:USERPROFILE\.claude\settings.json.devneural.bak
```

If you ever want to roll back: copy the `.bak` over `settings.json`.

---

## Step 7: Trigger the daemon to lazy-start

The daemon starts automatically on the first Claude Code hook event after install. To force this without opening Claude Code:

```powershell
node dist/capture/hooks/hook-runner.js pre <<< '{"session_id":"test","cwd":"C:/dev/Projects/DevNeural","tool_name":"Bash","tool_input":{"command":"echo hi"}}'
```

(On bash this is `echo '{...}' | node ...`.)

Wait 3 seconds, then:

```powershell
curl http://127.0.0.1:3747/health
```

**Expected:**
```json
{"ok":true,"pid":<some-number>,"phase":"P3.2-reference-corpus","raw_chunks":0,"wiki_pages":0,"llm":{...}}
```

If you see this, the daemon is alive and listening.

---

## Step 8: Verify the embedder loads

The first embedder call downloads the MiniLM ONNX model (~90 MB) into `c:/dev/data/skill-connections/models/`. Force this now so it doesn't happen during your first real prompt:

```powershell
curl -X POST -H "Content-Type: application/json" -d '{\"q\":\"warmup\",\"collection\":\"raw_chunks\"}' http://127.0.0.1:3747/search
```

First call may take 30-60 seconds (model download). Subsequent calls are < 50ms. The response will be `{"ok":true,...,"results":[]}` because the store is empty.

---

## Step 9: Open Claude Code in any project

Open VS Code, navigate to any project under `C:/dev/Projects/`, start a Claude Code session.

Type a substantive prompt (not a greeting). For example:

> walk me through how the daemon decides which wiki pages to inject

The hook fires `UserPromptSubmit`, calls `/curate`, gets back an empty injection (because the wiki is empty on day 1), and Claude responds normally.

**Verify capture happened:**

```powershell
ls C:/dev/data/skill-connections/projects/*/observations.jsonl
```

You should see at least one project directory with observations.

**Verify reinforcement is wired (after Claude replies):**

The daemon's transcript watcher will see the assistant turn and try to evaluate. With an empty wiki nothing scores high enough; check `daemon.log` for any errors.

---

## Step 10: Trigger initial corpus seed

If you have an `ANTHROPIC_API_KEY` set OR ollama with a model pulled, the daemon will automatically run the initial corpus seed in the background on first launch. To force it manually:

```powershell
curl -X POST http://127.0.0.1:3747/reseed
```

This iterates over `~/.claude/skills/`, `~/.claude/plugins/`, your projects, and recent sessions. It can take 10 minutes to a few hours depending on your corpus size and ollama speed.

Watch progress in the log:

```powershell
Get-Content C:/dev/data/skill-connections/daemon.log -Wait -Tail 30
```

Look for `[corpus-seed] ... created=N` lines. Each `created=1` means a new pending wiki page exists.

---

## Step 11: Inspect the wiki

After the seed completes (or partially completes):

```powershell
ls C:/dev/data/skill-connections/wiki/pending/
```

Each `.md` file is a draft wiki page. Open one in any editor:

```powershell
code C:/dev/data/skill-connections/wiki/pending/some-page.md
```

You should see frontmatter with `[trigger] → [insight]` style title, summary, body sections, and evidence pointing back at sources.

---

## Step 12: Sanity check end to end

Run the status command:

```powershell
npm run status
```

Expected: all green, except possibly `daemon` may be `warn` if you haven't fired a hook recently and the daemon idle-shut.

If everything is green: install complete.

---

## Optional: configure Tailscale for remote access

If you want to hit the dashboard from outside `OTLCDEV`:

1. Install Tailscale (`winget install tailscale.tailscale`)
2. `tailscale up` and authenticate
3. Note your tailnet domain (e.g. `OTLCDEV.<tailnet-name>.ts.net`)
4. The dashboard is served by the daemon on `0.0.0.0:3747` at `/` on `OTLCDEV` and is reachable at that URL from any device on your tailnet

Tailscale is only needed for remote access; local daemon operation on `OTLCDEV` does not require it.

---

## Optional: enable autostart

DevNeural ships this as a one-liner. From `07-daemon`:

```powershell
npm run install-daemon-autostart
```

This registers a Task Scheduler task (`DevNeural-Daemon`) that runs `start-daemon.ps1` at log on, so the daemon comes back after a reboot without waiting for the first Claude Code hook to lazy-start it. Undo with `npm run uninstall-daemon-autostart`.

If you would rather not autostart: the hook lazy-starts the daemon on the first tool call, so if you use Claude immediately after log on that works too.

---

## Optional: install the 09-bridge VS Code extension

The bridge makes the dashboard's "focus VSCode window" and "send prompt to terminal" actions actually drive your editor. Without it, the daemon writes queue files but nothing consumes them.

```powershell
cd C:/dev/Projects/DevNeural/09-bridge
npm install
npm run build
npm run package
& "C:\Users\michael\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd" --install-extension .\devneural-bridge.vsix
```

After install, reload the VS Code window (Command Palette → "Developer: Reload Window") so the extension activates. Confirm with `code --list-extensions | findstr devneural`. The output channel "DevNeural Bridge" prints activation, watched dir, and every send/focus event.

Verify end-to-end (replace the session id with a live one from `/sessions`):

```powershell
curl -sk -X POST "https://OTLCDEV.<tailnet>.ts.net/sessions/<session-id>/focus"
# Then check
ls C:/dev/data/skill-connections/session-bridge/
# A <session-id>.in JSONL should appear, and the bridge output channel should log [focus] requested...
```

The watched dir `C:/dev/data/skill-connections/session-bridge` is created on demand by the daemon's first queue write; if you check before any prompt/focus it will not exist yet.

---

## Done

Capture is alive. The daemon is reachable. The wiki has been seeded (or is in progress). Claude Code sessions will start being augmented as the wiki accumulates canonical pages.

Next read: `05-coexistence-with-claude-setup.md` (placeholder until Phase 5) and `07-troubleshooting.md`.

---

## Optional: tuning environment variables

DevNeural runs sensibly with no env vars set. The following exist for cases where you want to deviate from defaults. All optional, all read at daemon start.

| Var | Default | Effect |
|---|---|---|
| `DEVNEURAL_DATA_ROOT` | `C:/dev/data/skill-connections` | Where the wiki, vector store, SQLite, and session-state live |
| `DEVNEURAL_PORT` | `3747` | Daemon HTTP/WS bind port |
| `DEVNEURAL_LLM_PROVIDER` | `ollama` | `ollama` (local), `anthropic` (cloud), or `none` (disable LLM ops) |
| `DEVNEURAL_AUTO_INGEST_INTERVAL_MS` | `300000` (5 min) | Periodic wiki auto-ingest cadence. Lower = more responsive, more LLM calls |
| `DEVNEURAL_AUTO_INGEST_MIN` | `600` | Minimum bytes of new transcript before periodic ingest fires. End-of-session pipeline bypasses this floor |
| `DEVNEURAL_DECAY_INTERVAL_MS` | `86400000` (24h) | Reinforcement decay cadence. `0` to disable (dev boxes that don't want page weights to drift) |
| `DEVNEURAL_PASS2_FALLBACK` | unset | `anthropic` to retry exhausted Pass 2 LLM calls against Anthropic Haiku. Requires `ANTHROPIC_API_KEY`. Off by default to preserve local-first |
| `DEVNEURAL_WIKI_PUSH_INTERVAL_MS` | `300000` (5 min) | Off-site wiki git-push cadence. Skipped silently if no remote configured |
| `DEVNEURAL_SUMMARY_TURNS` | `8` | Turns between rolling session-summary refreshes |
| `DEVNEURAL_SUMMARY_MIN_MS` | `300000` (5 min) | Minimum time between summary refreshes when turns aren't hitting the threshold |
| `ANTHROPIC_API_KEY` | unset | Required when using anthropic provider or Pass 2 fallback |
| `DEVNEURAL_WHISPER_BIN` | auto-detected | Path to `whisper-cli.exe` (cuBLAS) for voice STT |

### Recommended for borderline local-LLM hardware

If `qwen3:8b` is slow on your box and the wiki shows fewer pages than you'd expect after several sessions, enable the Pass 2 fallback:

```powershell
[Environment]::SetEnvironmentVariable("DEVNEURAL_PASS2_FALLBACK", "anthropic", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

Restart the daemon. Pass 2 calls that exhaust local retries now retry once against Anthropic Haiku (~$0.004 per fallback, typically a handful per day).

### Disabling decay

A dev box where you don't want page weights to drift while you experiment:

```powershell
[Environment]::SetEnvironmentVariable("DEVNEURAL_DECAY_INTERVAL_MS", "0", "User")
```

This stops the daily decay tick. Lint shape-fixes still run; only the weight multiplier is paused.
