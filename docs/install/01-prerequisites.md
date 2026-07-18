# 01: Prerequisites

> What must already be on the machine before you can install DevNeural.
> Each item: what it is, why DevNeural needs it, how to install on Windows, how to verify.

---

## Required

### Node.js 20 or newer

**Why:** the daemon, the dashboard, the embedder, and the SQLite metadata store all run on Node. The hook runner is a tiny Node binary that fires on every Claude Code tool call.

**Install (Windows):**
- Download the LTS installer from https://nodejs.org/ (pick 20.x or 22.x LTS)
- Or via winget: `winget install OpenJS.NodeJS.LTS`

**Verify:**
```powershell
node --version    # expect v20.x.x or higher
npm --version     # expect 10.x.x or higher
```

If `node` is not on `PATH` after install, log out and back in.

---

### Git

**Why:** clone the DevNeural repo, clone `dev-template` for new projects, version-control the wiki itself.

**Install:**
- https://git-scm.com/download/win
- Or: `winget install Git.Git`

**Verify:**
```powershell
git --version    # expect git version 2.40+
```

---

### ollama

**Why:** the local LLM that runs ingest, lint, reconcile, summarization, glossary, and current-task. DevNeural's default provider. No API costs.

**Install:**
- https://ollama.com/download/windows
- Or: `winget install Ollama.Ollama`
- Run the installer, accept defaults.

**Pull the default model:**
```powershell
ollama pull qwen3:8b
```

If `qwen3:8b` is not available in your ollama version, fall back to:
```powershell
ollama pull qwen2.5:7b-instruct
```
And set `DEVNEURAL_OLLAMA_MODEL=qwen2.5:7b-instruct` (see `04-step-by-step.md`).

**Verify ollama is running:**
```powershell
curl http://localhost:11434/api/tags
```
Expect a JSON response listing your pulled models.

If ollama is not running, launch the desktop app or run `ollama serve` from a separate shell.

---

### Visual Studio Code (or compatible)

**Why:** DevNeural integrates with Claude Code, which runs inside an editor (VS Code, Cursor, OpenCode, etc). The Phase 3 dashboard and Phase 4 orb expect to be able to open project folders and Claude sessions in your editor.

**Install:**
- https://code.visualstudio.com/
- Or: `winget install Microsoft.VisualStudioCode`

**Verify the `code` CLI is on PATH:**
```powershell
code --version
```

If not, open VS Code, press `Ctrl+Shift+P`, run "Shell Command: Install 'code' command in PATH."

---

### Claude Code

**Why:** DevNeural attaches to Claude Code via hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification, SessionStart) and reads session transcripts written under `~/.claude/projects/<slug>/`.

**Install:**
- Follow https://docs.claude.com/en/docs/claude-code/getting-started
- The CLI is installed via `npm install -g @anthropic-ai/claude-code` or the official installer.

**Verify:**
```powershell
claude --version
```

---

### Tailscale (optional in Phase 1, required for Phase 3 remote dashboard access)

**Why:** the Phase 3 dashboard exposes the system over Tailscale so Michael can hit it from anywhere without exposing it to the public internet.

**Install:**
- https://tailscale.com/download/windows
- Or: `winget install tailscale.tailscale`

**Verify after install:**
```powershell
tailscale status
```
Expect a list of devices on your tailnet, including the current machine.

If you only need DevNeural locally on `OTLCDEV` (no remote access), Tailscale can be skipped at install time and added later.

---

## Recommended

### PowerShell 7+

**Why:** older Windows PowerShell 5.1 has subtle differences with some commands DevNeural's setup uses. PS7 is the modern shell.

**Install:**
- `winget install Microsoft.PowerShell`

---

### Windows Terminal

**Why:** better tabbed terminal experience for working with multiple Claude sessions.

**Install:**
- Microsoft Store, or `winget install Microsoft.WindowsTerminal`

---

## NOT required

- Python (DevNeural is Node-only; the embedder runs ONNX in Node)
- Docker (no containers in DevNeural)
- A web server (the daemon serves its own HTTP)
- A database server (SQLite is embedded, vector store is in-process)
- An Anthropic API key
- An OpenAI API key
- Any cloud account

---

## Sanity check

Before continuing to `02-architecture-and-dependencies.md`, run:

```powershell
node --version
npm --version
git --version
code --version
claude --version
curl http://localhost:11434/api/tags
```

If all of those succeed, you have the foundation in place.

If any one fails, fix that one before proceeding. Each prereq is independent.
