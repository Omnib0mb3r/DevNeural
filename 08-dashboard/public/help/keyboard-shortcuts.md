# Keyboard shortcuts

DevNeural ships as a Windows-only build, so every modifier reads
as `Ctrl` or `Alt`. Mac glyphs (`Cmd` / `Option`) are not in the
rendered UI.

## Global

| Shortcut       | What it does                                    |
|----------------|-------------------------------------------------|
| `Ctrl+K`       | Open the command palette. Fuzzy-search every page, brainstorm, project, and reference doc. |
| `Ctrl+Alt+.`   | Fire the panic button. Halts the live worker session and lands a panic-log row. Confirmation toast appears in the top bar. |

## Lex chat

| Shortcut          | What it does                                 |
|-------------------|----------------------------------------------|
| `Ctrl+Enter`      | Send the pending message in the Talk-to-Lex compose box. The Send button does the same thing. |
| `Esc`             | Close any open modal (command palette, notification dropdown, brainstorm picker). |

## Voice panel

The voice panel exposes one button per voice control, and the
same controls are also bound to keyboard chords as a fallback for
when speech recognition is unavailable (Firefox, or offline builds
that cannot reach the cloud STT backend):

| Shortcut       | What it does                                    |
|----------------|-------------------------------------------------|
| `Ctrl+Alt+M`   | Mute Lex. Works mid-reply, so you can silence the current turn without speaking. |
| `Ctrl+Alt+U`   | Unmute Lex. |
| `Ctrl+Alt+D`   | Disable the voice layer entirely. |

The chords are ignored while you are typing in an input, textarea,
select, or contentEditable field. The dashboard mic icon toggles
mic capture without speaking; the speaker icon toggles soft mute.

## Notes

Browser shortcuts (`Ctrl+L`, `Ctrl+R`, `Ctrl+W`, etc.) work as
the browser normally handles them. DevNeural does not intercept
the browser-reserved shortcuts.
