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

Fixed (pending soak) — 2026-05-11, Wave 3 fixup sprint.

## Fixes shipped

- `08-dashboard/components/TopBar.tsx`:
  - Header wrapper now uses `gap-2 min-w-0` so all children participate
    in flex-shrinking; horizontal padding drops from `px-5` to `px-3`
    below `sm`.
  - Brand wordmark ("DevNeural" + "Hub") hides below `sm`; the icon
    badge remains as the clickable anchor.
  - Search bar collapses to an icon-only `lift` button below `md`;
    the wide placeholder copy ("Search wiki, sessions, projects...")
    only renders at `md` and up.
  - Right cluster (notifications, settings, auth pill, rollup pill)
    drops the inline text labels below `sm` and falls back to
    `title=` tooltips so the icons + status dots stay readable.
  - Bottom nav row gains `overflow-x-auto` + `whitespace-nowrap` so
    the 11 tabs scroll horizontally instead of wrapping or overflowing.

## Verification

Manual:
1. Resize the browser to 360px wide (typical mobile portrait).
2. Header fits inside the viewport; no horizontal page scroll.
3. Tab row scrolls horizontally; every tab remains reachable.
4. Search icon opens the command palette via the same `open-cmdk`
   event the wide button used.
5. Resize back to >=768px and confirm the wide search bar and full
   auth + rollup labels re-appear.

`tsc --noEmit` clean on `08-dashboard`.
