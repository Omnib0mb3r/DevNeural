# DevNeural Session Bridge

VS Code extension that delivers queued prompts from the DevNeural daemon into the Claude Code terminal in your editor, and publishes presence files so the daemon knows which terminal belongs to which session. Text only: OS-level window focus and key injection moved to the StreamDeck.App tray app (commit `aee3053`; see `src/extension.ts` for the removal note and the virtual-input path).

## What it does

When the dashboard (or any caller) sends a prompt to a session via the daemon endpoint:

```
POST http://localhost:3747/sessions/<session-id>/prompt
{ "text": "summarize where we are and propose the next step" }
```

the daemon writes a JSON line to:

```
C:/dev/data/skill-connections/session-bridge/<session-id>.in
```

This extension watches that directory inside VS Code, picks the right terminal in this window, and sends the prompt into it as if you typed it. A `focus` action is acknowledged but does nothing here; focus is the tray app's job.

## Install

The extension is local-only; not published to the marketplace.

```powershell
cd C:/dev/Projects/DevNeural/09-bridge
npm install
npm run build
npm run package          # produces devneural-bridge.vsix
code --install-extension devneural-bridge.vsix
```

Reload VS Code. The extension activates on startup.

## Configuration

Settings under `devneural.bridge`:

| Setting | Default | Notes |
|---|---|---|
| `enabled` | `true` | Disable to pause the bridge without uninstalling. |
| `dataRoot` | `C:/dev/data/skill-connections` | Must match the daemon's `DEVNEURAL_DATA_ROOT`. |
| `terminalNamePattern` | `claude` | Case-insensitive substring match against terminal names. The bridge sends prompts to the most-recently-active terminal whose name contains this. |

## Commands

| Command | Description |
|---|---|
| `DevNeural: Bridge Status` | Prints current config + watched dir + open terminals to the output channel. |
| `DevNeural: Toggle Bridge` | Pause / resume without changing config. |
| `DevNeural: Pick Claude Terminal for This Window` | If your Claude terminal has a non-default name, set the pattern interactively. |

## How prompt routing works

For each `<session-id>.in` file, the extension only acts on messages whose session's `cwd` (read from `c:/dev/data/skill-connections/session-state/<session-id>.meta.json`) starts with this VS Code window's workspace folder. If no metadata exists yet, all VS Code windows attempt to handle the message; the file's truncation acts as a last-writer-wins lock.

For the `focus` action, the bridge only logs it; the StreamDeck.App tray app owns window focus.

## Output

Open the "DevNeural Bridge" output channel (View → Output → "DevNeural Bridge") to see every send / focus / parse error in real time.

## Limitations

- Only one Claude terminal per VS Code window is supported reliably.
- If the terminal pattern matches multiple terminals, the most recently active one wins.
- Window focus is not done by this extension any more (tray app). If focus seems broken, look at StreamDeck.App, not here.
- Terminal input goes through `terminal.sendText(text, true)`. Special characters may need escaping by the caller.
