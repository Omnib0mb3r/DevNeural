# Dashboard text overflows on small form factor screens

**Status:** open
**Date opened:** 2026-05-11
**Severity:** medium

---

## Symptoms

On small form factor screens (mobile or narrow window), dashboard header elements overflow off the visible area. The main nav items (Home, Brainstorms, Wiki) render acceptably, but the search bar and similar wide controls expand past the screen edge.

## Reproduction

1. Open dashboard on a phone or narrow browser window
2. Observe header bar
3. Search bar and any wide labeled controls extend beyond the right edge of the screen

## Expected

Header content fits within the viewport at all common breakpoints. On narrow screens, wide controls collapse to icon-only or use a responsive layout.

## Fix direction

- Add a responsive breakpoint (likely under 768px)
- Below the breakpoint: search bar becomes an icon that expands on click into a modal or overlay
- Any other wide controls (project pickers, mode selectors) follow the same icon-collapse pattern
- Keep nav text items (Home, Brainstorms, Wiki) as they already work, or collapse to icons if needed for very narrow widths (under 480px)

## Suspected location

`08-dashboard/src/components/TopBar.tsx` (or wherever the header lives). Likely needs responsive CSS, possibly a `useMediaQuery`-style hook, or Tailwind responsive classes.

## Status

Open. Should be picked up alongside any dashboard polish pass. Belongs in Wave 4 or earlier if user lands on a small screen often.
