# Keyboard shortcuts

DevNeural ships as a Windows-only build, so every modifier reads
as `Ctrl` or `Alt`. Mac glyphs (`Cmd` / `Option`) are not in the
rendered UI.

## Global

| Shortcut       | What it does                                    |
|----------------|-------------------------------------------------|
| `Ctrl+K`       | Open the command palette. Fuzzy-search every page, brainstorm, project, and reference doc. |
| `Ctrl+Alt+.`   | Fire the panic button. Halts the live worker session and lands a panic-log row. Confirmation toast appears in the top bar. |
| `Esc Esc`      | Double-press anywhere to fire the panic button. Same effect as the Ctrl+Alt+. chord. |

## Lex chat

| Shortcut          | What it does                                 |
|-------------------|----------------------------------------------|
| `Ctrl+Enter`      | Send the pending message in the Talk-to-Lex compose box. The Send button does the same thing. |
| `Esc`             | Close any open modal (command palette, notification dropdown, brainstorm picker). |

## Voice panel

The voice panel exposes one button per voice control rather than
keyboard chords. Voice commands themselves are spoken (see the
Voice commands section above). The dashboard mic icon toggles
mic capture without speaking; the speaker icon toggles soft mute.

## Notes

Browser shortcuts (`Ctrl+L`, `Ctrl+R`, `Ctrl+W`, etc.) work as
the browser normally handles them. DevNeural does not intercept
the browser-reserved shortcuts.
