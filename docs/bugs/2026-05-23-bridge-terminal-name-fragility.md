## 2026-05-23 bridge terminal-name match is fragile (cosmetic; binding is fine)

**Status:** open (low; binding works, this is an ergonomics / fallback improvement)
**Severity:** low — process-tree walk is the authoritative bind; name match is a fallback
**Filed by:** Lex during Fix 19 / Fix 20 settings.json triage

### Background

The bridge VSIX (`09-bridge/src/extension.ts`) picks which VS Code terminal is the Claude Code worker via two paths:

1. **Authoritative:** process-tree walk. `findClaudeDescendant(rootPid)` walks each terminal's shell process tree looking for a descendant whose CommandLine contains `claude`. This is what backs the deliverability flag (`has_terminal_for_uuid`) in the presence-file pipeline (PROJECT-ANCHORS / Fix 18). Parentage is deterministic; two terminals with the same name still resolve correctly.
2. **Fallback / cosmetic:** terminal-name substring match against `devneural.bridge.terminalNamePattern` (in `.vscode/settings.json`). Used when process-tree walk can't decide and for the explicit "Pick Terminal" command.

### The fragility

The committed default `"powershell"` matches any PowerShell terminal — too broad. A working-tree attempt to tighten it to `"✳ initial coding session setup"` (CC's startup banner string) showed the underlying problem: terminal titles change. CC doesn't currently set its own terminal title, so the name match never deterministically identifies a Claude session by name alone.

Reverted to `"claude"` as a sane substring on 2026-05-23 (matches the in-code fallback default `'claude'`, which is also what the OSC title write below would produce). Binding still works because process-tree walk is the truth.

### Permanent fix (proposed)

Have Claude Code's session-start hook (or DevNeural's wrapper script) write the terminal title via OSC escape:

```
printf '\x1b]0;claude · %s · %s\x07' "$PROJECT_SLUG" "$SHORT_SESSION_ID"
```

That gives:

- Human-readable VS Code tab label (`claude · devneural · 088aaaec`).
- Project + short session-id makes the name match uniquely identifying — pattern `"claude"` still matches every CC terminal, AND the user can visually distinguish multiple workers.
- Process-tree walk remains the authoritative bind; OSC title is purely cosmetic + a better fallback when process-tree can't decide.

### Collision case

Two terminals truly identical (same project, same session-id prefix, same workspace) is rare enough that the explicit "Pick Terminal" VS Code command is the right escape hatch. Do not try to disambiguate further programmatically; ask the user.

### Action

1. ✅ Revert `.vscode/settings.json` to `"claude"` substring (committed alongside this bug doc).
2. ⏳ Implement OSC title write in CC session-start hook (or DevNeural launcher wrapper). Acceptance: opening a fresh worker shows `claude · <project> · <id>` in the VS Code terminal tab; bridge name-match continues to succeed; multiple workers are visually distinct.
3. ⏳ Smoke: spawn two workers in different projects, verify each terminal renders the correct title and the bridge binds each to the correct anchor.

### Related

- `09-bridge/src/extension.ts:285-319` (terminal resolution).
- `09-bridge/src/presence.ts` (presence file payload; deliverability flag).
- Fix 18 in `FIXES.md` (cross-session-inject deliverability gate; multi-window safe presence files).
- `docs/spec/PROJECT-ANCHORS.md` (authoritative bind contract).
