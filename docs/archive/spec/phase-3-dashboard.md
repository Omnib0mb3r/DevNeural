# Phase 3: Central control dashboard

> Status: design in progress. Started after Phase 1 (daemon) shipped and before Phase 2 (v1 burndown) cleanup.
> Last updated: 2026-05-02.
> Companion docs: `docs/spec/devneural-v2.md` (system architecture), `docs/spec/DEVNEURAL.md` (wiki schema), `docs/spec/phase-4-orb.md` (orb rebind, future).

---

## 1. Vision

The dashboard is Michael's central hub. First thing opened in the morning, last thing checked at night, and the remote control he uses when away from `OTLCDEV` (his main machine, also the DevNeural server). It is:

- A single-page application served by `07-daemon` on the local machine.
- Reachable from anywhere via Tailscale into `OTLCDEV`.
- Responsive: works on a 32-inch desktop monitor and on a phone.
- Visually polished. Real-time. Mobile-installable as a PWA.
- The window into everything DevNeural knows plus everything `OTLCDEV` is doing right now.

There is one user, one machine. The dashboard does not need multi-tenant or multi-host complexity.

---

## 2. End state

You wake up. Tap the Dashboard icon on your phone (or open the tab on your desk). Tailscale is already connected. The dashboard loads in under 1 second.

Top of the screen: a daily brief. "Your second brain learned 3 new patterns yesterday. 1 page promoted to canonical. 2 sessions ran. No alerts." A green "all systems online" pill sits in the corner.

Below: a left rail showing every Claude session currently active on `OTLCDEV` as a vertical "stream deck." Each card shows the session name, project, current task, last activity time, and a status dot. You tap one. A side panel slides in showing the session's recent transcript and a small prompt box. You type "summarize where we are and propose the next step." It sends. The session on `OTLCDEV` receives it, replies, you watch it tick.

You see a notification: "Page coverage gap detected on the auto-lisp project. Want me to ingest the new content?" Tap approve.

You remember a conveyor manual you took a picture of yesterday. You drag the image onto the dashboard. Project dropdown: select "warehouse-sim." Upload progress bar fills. Daemon OCRs locally, chunks, embeds, stores in `reference/`. Done in 30 seconds. Now searchable forever.

You search "what was that bay-spacing decision again." Result hits both your wiki and the conveyor manual you uploaded last week. Click. Page opens. Click a cross-reference. Another page.

You tap "new project." Modal: name it, pick a stage, hit go. Daemon clones `dev-template`, scaffolds the folder under `C:/dev/Projects/<name>`, fills `devneural.jsonc`, opens VS Code on `OTLCDEV`, starts a Claude session in it. The session appears in your stream deck three seconds later. You're on a train; the project is up and running on your desk machine waiting for you to get home.

The orb (Phase 4) is one of the panels. The dashboard is the chassis the orb plugs into.

---

## 3. Access model

### 3.1 Network perimeter

Dashboard binds to `0.0.0.0:7474` on `OTLCDEV`. Tailscale handles the rest:
- `OTLCDEV.<your-tailnet>.ts.net` resolves over Tailscale only.
- All Tailscale traffic is encrypted device-to-device.
- Devices not on the tailnet cannot reach the dashboard at all.

No public exposure. No reverse proxy. No certificates to renew. No DDNS.

### 3.2 PIN unlock (removed 2026-05-15)

The PIN gate was removed. Trust now lives entirely at the network layer
(localhost / Tailscale binding). The locked indicator never reached the
renderer (the daemon refused to push state while locked) and the gate
blocked Chrome DevTools / Playwright MCP from auditing the dashboard, so
the layer cost more than it bought. The dashboard HMAC secret persists
at `dashboard/auth.json` (read-only consumer: cross-session prompt
injection), but no PIN, cookie, or lockout state is stored.

### 3.3 What's NOT in scope for v1

- Multi-user.
- WebAuthn / passkeys (overkill for one person).
- TOTP (overkill).
- Per-page sensitivity gating in the UI (deferred to a later phase along with privacy/demo mode).

---

## 4. Layout

Two screen sizes, one component tree, responsive layout.

### 4.1 Desktop (>= 1280px)

```
┌──────────────────────────────────────────────────────────────────┐
│ ⚡ DevNeural        [search…]      [⌘K]  [🔔3]   [●all-online] │
├────────┬───────────────────────────────────────────────┬─────────┤
│ Stream │  Tab: Home / Wiki / Sessions / Projects /     │ Live    │
│ Deck   │       System / Reminders / Orb                │ Activity│
│        │                                                │ Stream  │
│ ▣ S-1  │  [Daily Brief]                                 │         │
│ ▣ S-2  │   3 new pages, 1 promoted, 2 sessions          │ 09:14   │
│ ▣ S-3  │   No alerts. Wiki health: green.               │  page-X │
│ ▢ idle │                                                │  injected│
│ ──     │  [Whats-new digest]                            │         │
│ + new  │   ...                                          │ 09:13   │
│ session│                                                │  hit on │
│        │  [Project status grid]                         │  page-Y │
│        │                                                │         │
│        │  [Recent activity]                             │ ...     │
│        │                                                │         │
└────────┴───────────────────────────────────────────────┴─────────┘
```

- **Top bar**: brand mark, global search, command palette trigger, notification bell, system health pill.
- **Left rail (Stream Deck)**: vertical stack of Claude session cards. Each card: name, project, current task (one line), last-activity dot. Click → focus that VS Code window on the host AND open a session detail panel. "+ new session" launches the new-project flow.
- **Main area**: tabbed. Default tab is Home. Other tabs are Wiki, Sessions, Projects, System, Reminders, Orb.
- **Right rail (Live Activity Stream)**: collapsible. Real-time event feed. Toggleable.

### 4.2 Mobile (< 768px)

```
┌──────────────────────────┐
│ ⚡ DevNeural    [🔔] [⋮] │
├──────────────────────────┤
│ [search…]                │
├──────────────────────────┤
│                          │
│  Daily Brief             │
│  ...                     │
│                          │
│  Sessions (3 active)     │
│   ▣ S-1 →                │
│   ▣ S-2 →                │
│   ▢ S-3 idle →           │
│                          │
│  Recent Pages            │
│   ...                    │
│                          │
├──────────────────────────┤
│ [Home][Wiki][Sess][Sys]  │
└──────────────────────────┘
```

- **Top bar**: brand, notifications, settings menu.
- **Search**: collapses into a sticky search bar.
- **Single-column scroll**: Daily Brief, Sessions list, Recent Pages, Recent Activity.
- **Bottom tab bar**: Home, Wiki, Sessions, System (orb hidden on mobile by default; opt-in).

The Stream Deck collapses into a `Sessions` tab on mobile. Tapping a session shows the steering panel (mini chat).

---

## 5. Panels

### 5.1 Home (the daily brief)

The first thing you see in the morning.

- **Today's brief** (LLM-summarized): "You have 4 active projects. The wiki added 3 pending pages last 24h. 1 promoted to canonical (`page-id`). 2 corrections happened (low impact). Reminder: lint not run in 5 days."
- **Whats-new excerpt**: 3-5 most interesting items from `wiki/whats-new.md` rendered nicely.
- **Project status grid**: 1 row per active project. Stage badge, last commit, current task per active session in that project, alert dot if any issues.
- **Recent activity** (last 24h): scannable list of events with icons.

The brief itself is generated by the local LLM once a day (overnight), stored as `wiki/whats-new.md` (already exists), and the dashboard pulls and renders it.

### 5.2 Wiki

Search-first interface for everything searchable.

- **Search bar**: queries across `wiki_pages`, `raw_chunks`, AND `reference_chunks` (the new reference corpus).
- **Filters**: collection (wiki / raw / reference), project, status, recency, sensitivity (later).
- **Results**: each result shows source (wiki page / transcript chunk / doc page / image), preview, score, click-to-open.
- **Result detail**: click opens a rendered page. For wiki: full markdown + cross-refs. For raw chunk: surrounding context. For reference doc: document viewer (PDF, image, transcript).
- **Upload button**: drag-and-drop or click. Modal asks: which project? (dropdown of all known projects + "global / not project-specific"), tags, sensitivity. Background upload progress. Once processed, it's searchable.

### 5.3 Sessions

Detailed view of all Claude sessions on `OTLCDEV`.

- **Session list**: same data as Stream Deck but as a table with sortable columns.
- **Per-session detail**: opens in side panel or modal.
  - Current task memory (`<session>.task.md`)
  - Rolling summary (`<session>.summary.md`)
  - Recent transcript chunks (last N turns, scrollable)
  - Status: active / idle / errored
  - **Send prompt** chat input: type a prompt, hit send, it's queued for that session via the session bridge (see section 7).
  - **Focus this window** button: Windows automation focuses the matching VS Code window on the host. Disabled when accessing remotely (it'd just bring focus on a machine you can't see).

### 5.4 Projects

- **Project grid**: every project the daemon has registered. Each card: name, stage, last commit, last activity, active sessions, page count in wiki, alert badges.
- **New project** button: opens the new-project flow (section 8).
- **Click a project** opens detail: README first 200 lines, devneural.jsonc contents, recent commits (10), recent file edits (20 aggregated by directory), wiki pages tagged with this project, reference docs tagged with this project, active sessions.

### 5.5 System

Local PC metrics + daemon health + service statuses.

- **OTLCDEV vitals**: CPU, RAM, GPU (if any), disk per drive, network, ollama VRAM, currently loaded model. Live updating sparklines.
- **Service status grid**: every monitored service with online / warn / offline. From `dashboard.config.jsonc`. Examples:
  - `daemon` (this process): green
  - `ollama` at `localhost:11434`: green
  - `chroma collections`: green
  - `wiki git repo`: clean
  - `tailscale`: connected
  - `internet`: reachable
  - `orb`: not yet built (Phase 4)
  - any custom monitored URL or socket
- **Daemon log tail**: last 200 lines of `daemon.log`, filterable by level.
- **Daemon controls**: restart, force ingest, force lint, force decay, force whats-new. Confirmation modal before destructive actions.

### 5.6 Reminders

Local task list. Simple.

- **List**: open reminders, sorted by due date (no due = bottom).
- **Add**: title + optional due date + optional project tag.
- **Complete**: check it off; archived after 7 days.
- **Notification trigger**: dashboard polls; when due time hits, fires a web push notification (opt-in) AND surfaces a banner.

Reminders live at `c:/dev/data/skill-connections/dashboard/reminders.jsonl`.

### 5.7 Orb (Phase 4 placeholder)

Empty card in v1 with text "Orb visualization launches in Phase 4." Once Phase 4 ships, the orb renders here in a large pane. Dashboard chassis already routes `/graph` to it.

---

## 6. Reference corpus (the second brain)

External documents (manuals, books, PDFs, images, video, audio) become a searchable knowledge base alongside the wiki.

### 6.1 Why separate from the wiki

Wiki pages are YOUR insights from YOUR work. They follow the strict `[trigger] → [insight]` schema. They are precious.

Reference docs are bulk knowledge from the world. They are searchable but they are not insights you derived. Mixing them would dilute the wiki and break the trigger-and-insight discipline.

Both surface in dashboard search. They render differently and are tagged differently.

### 6.2 Storage

```
c:/dev/data/skill-connections/reference/
  docs/<doc-id>/
    meta.json               # source filename, project, tags, sensitivity, upload time, processor used
    original.<ext>          # the file as uploaded (for re-download / re-process)
    text.md                 # extracted text (after PDF/OCR/transcribe)
    chunks.jsonl            # chunk records with offsets back into text.md
  images/<img-id>/
    meta.json
    original.<ext>
    text.md                 # OCR output + optional vision-model description
    chunks.jsonl
  audio/<audio-id>/
    meta.json
    original.<ext>
    transcript.md           # whisper.cpp output
    chunks.jsonl
  video/<video-id>/
    meta.json
    original.<ext>
    transcript.md           # audio extracted then whisper
    frames/                 # optional sampled stills with OCR
    chunks.jsonl
  queue/                    # incoming, awaiting processing
    <upload-id>/
      meta.json
      original.<ext>
      .status               # pending | processing | done | failed
```

### 6.3 Chroma collection

A new `reference_chunks` collection alongside `raw_chunks` and `wiki_pages`. Same embedder. Metadata fields: `doc_id`, `kind` (pdf/image/audio/video/markdown), `project_id` (or 'global'), `tags`, `chunk_index`, `text_preview`.

### 6.4 Processing pipeline

Per upload:

1. **Upload**: multipart POST to `/upload` (size cap configurable, default 100MB). Lands in `reference/queue/<upload-id>/`.
2. **Detect kind**: file extension + magic bytes.
3. **Extract**:
   - `pdf`: `pdf-parse` for text. If text extraction yields under N chars per page, fall back to `pdf2pic` rasterization + `tesseract.js` OCR.
   - `image`: `tesseract.js` for OCR. Optional: vision model via ollama (LLaVA / qwen-vl) for richer description, off by default.
   - `audio`: `whisper.cpp` (local). Default model: `base.en` for speed, configurable.
   - `video`: ffmpeg extract audio → whisper. Optional: sample frames every N seconds for OCR.
   - `markdown` / `txt`: direct.
   - `docx`: `mammoth.js` to text.
4. **Chunk**: paragraph-aware chunking, target 800 chars per chunk, overlap 100 chars.
5. **Embed**: each chunk via the local embedder (already running).
6. **Store**: vector + metadata into `reference_chunks` Chroma collection. Chunks file written to disk.
7. **Index in SQLite**: metadata table `reference_meta` for filterable queries.
8. **Notify**: dashboard receives a "doc ready" event.

#### Status

Phase 3.5 (audio + video) is implemented at the code level:
`07-daemon/src/reference/audio.ts` shells out to whisper.cpp,
`07-daemon/src/reference/video.ts` demuxes via ffmpeg then transcribes
via the same audio extractor. Both binaries are external. When either
is missing the upload still lands on disk with status `queued` and the
dashboard receives a `warn` notification (see
`docs/install/AUDIO-VIDEO.md` for setup). End-to-end validation is
pending whisper.cpp + ffmpeg installation on `OTLCDEV`.

### 6.5 Cost discipline

All steps are local. Tesseract is fast and dumb. Whisper.cpp is a one-time-per-file cost. PDF parsing is cheap. Vision-model upgrade is opt-in if user wants better image understanding.

No API calls. No per-document cost.

### 6.6 Search behavior

Dashboard search hits a unified `/search/all` endpoint that queries all three Chroma collections in parallel and merges by score, with a result-type tag.

Default ordering: relevance first, but reference docs get a slight boost when the query looks like a "lookup" (heuristic: contains the word "manual", "spec", "documentation", or matches a known reference filename).

---

## 7. Session bridge (steering)

The dashboard needs to send prompts to a running Claude session on `OTLCDEV`.

### 7.1 The problem

Claude Code does not natively expose "send a prompt to this running session" over an API. We need a bridge.

### 7.2 Approach

A small VS Code extension installed on `OTLCDEV` (`08-bridge` or built into the daemon side):

- Listens for messages from the daemon over a localhost socket (or watches a file at `c:/dev/data/skill-connections/session-bridge/<session-id>.in`).
- When a message arrives for a session that exists, the extension finds the matching VS Code window with an active Claude Code terminal panel, focuses it, and pastes + submits the message.
- For the prompt to land cleanly, we use the existing UserPromptSubmit hook: the extension simulates the user typing and pressing enter via VS Code's terminal API.

Alternative if the extension is too much: powershell + AutoHotkey window-focus + paste, but more fragile.

### 7.3 Sending a prompt from the dashboard

```
POST /sessions/<session-id>/prompt
body: { text: "your prompt here" }
```

Daemon:
1. Look up the session.
2. Validate it's currently active.
3. Write to `session-bridge/<session-id>.in`.
4. Bridge picks it up, focuses the matching window, pastes, submits.
5. Daemon responds 202 Accepted with a request id.
6. Client polls or subscribes via WS for the assistant's reply (which the transcript watcher will see).

### 7.4 Stream Deck focus action

On the OTLCDEV machine specifically: clicking a Stream Deck card should focus the corresponding VS Code window. Same bridge mechanism: send a focus-only message.

When the dashboard is loaded over Tailscale on a remote device, the focus button is disabled (no point focusing a window you can't see). Send-prompt still works.

---

## 8. New project starter

End-to-end "I want a new project" flow.

### 8.1 UX

Dashboard → Projects → "+ New Project" button opens a modal:

| Field | Default |
|---|---|
| Name | required, kebab-case enforced |
| Stage | dropdown: alpha (default), beta, deployed, archived |
| Tags | optional comma-separated |
| Description | optional one-liner (auto-fills `devneural.jsonc`) |
| Open in VS Code? | checkbox, default true |
| Start Claude session? | checkbox, default true |

Hit "Create."

### 8.2 Backend flow

`POST /projects/new` with the form data. Daemon:

1. Validate name (kebab-case, no collision in `c:/dev/Projects/`).
2. Clone `https://github.com/Omnib0mb3r/dev-template` to `c:/dev/Projects/<name>` via `git clone`.
3. Run the existing `scripts/fill-devneural.mjs` (or its replacement) against the new directory to fill `devneural.jsonc` with name + stage + tags + description.
4. Initialize git remote if applicable.
5. Register project in `projects.json`.
6. If `Open in VS Code?` is true: spawn `code C:/dev/Projects/<name>` (assumes `code` CLI is on PATH).
7. If `Start Claude session?` is true: the dashboard tells the user "open a Claude session in the new VS Code window now" OR (advanced) we use a small helper to start `claude` with the project as cwd. Claude Code SDK has a way to start a session programmatically; if we use it, this becomes one click. If we don't, this is a manual final step.
8. Respond with the new project record.

### 8.3 Out-of-the-box from the template

`dev-template` already includes `devneural.jsonc` (REPLACE_ME placeholders), `CLAUDE.md`, `OTLC-Brainstorm.MD`, README. All get filled by the daemon in step 3.

---

## 9. Notifications and reminders

### 9.1 Notification sources

- **Daemon events**: `page promoted`, `lint flagged contradictions`, `ingest failed N times in a row`, `coverage gap detected`, `corpus seed completed`, `wiki page archived due to corrections`.
- **System events**: `daemon down`, `ollama crashed`, `disk over 90%`, `daemon restarted`, `tailscale disconnected`.
- **User reminders**: due reminders.
- **Approval queue**: `2 documents waiting for ingest approval`, `3 page edits flagged for review`.

### 9.2 Delivery channels

- **In-dashboard banner**: top of page, dismissible. Always available.
- **Notification bell badge**: top bar, count of unread.
- **Web push notification**: PWA service worker + VAPID keys. Opt-in. When the dashboard is closed, push still arrives on the device. iOS PWA push requires the user to "Add to Home Screen" first.
- **Stream Deck flash**: a Stream Deck card flashes red when its session has an alert (e.g., Claude is stuck waiting for input).

### 9.3 Severity levels

- `info`: green dot. Don't push. Show in feed.
- `warn`: yellow. Banner on dashboard. Optional push.
- `alert`: red. Banner + push always.

### 9.4 Storage

`c:/dev/data/skill-connections/dashboard/notifications.jsonl` (append-only, last 30 days kept).
`c:/dev/data/skill-connections/dashboard/reminders.jsonl` (append-only with completion records).

### 9.5 Web push setup

VAPID keys generated on first dashboard launch and stored at `dashboard/vapid.json`. Client subscribes via `PushManager.subscribe()`. Subscription stored at `dashboard/push-subscriptions.jsonl` (per device). Daemon sends pushes via `web-push` npm library.

---

## 10. Visual design language

The dashboard is the visible product surface of DevNeural. It needs to be visually stunning, not utilitarian. This section locks the design language so individual screens stay coherent.

### 10.1 Identity

- **Name**: DevNeural Dashboard. The "Hub."
- **Voice**: confident, terse, technical without being academic. No marketing fluff in copy.
- **Personality**: a control room. Not a CRM. Not a "productivity app." A cockpit.
- **Audience**: Michael primarily. A potential buyer secondarily. Both reward density and clarity over decoration.

### 10.2 Color palette

Dark theme is default and the only theme that ships in v1. (Light theme is a Phase 8 polish item if at all.)

| Role | Color | Hex (start) | Notes |
|---|---|---|---|
| Background base | true black | `#000000` | OLED-friendly, gives charts room to breathe |
| Surface 1 (cards) | near black | `#0A0A0B` | Subtle elevation |
| Surface 2 (modals, popovers) | dark slate | `#16161A` | Higher elevation |
| Border / divider | charcoal | `#26262B` | Hairline 1px |
| Text primary | off-white | `#F4F4F5` | Never pure white |
| Text secondary | mid gray | `#A1A1AA` | For metadata |
| Text tertiary | low gray | `#52525B` | For deemphasized |
| Brand accent | electric violet | `#8B5CF6` | Used sparingly for active state, brand mark |
| Status: healthy | green | `#10B981` | All systems operational |
| Status: warning | amber | `#F59E0B` | Attention needed |
| Status: error / blocked | red | `#EF4444` | Action required |
| Status: active session | cyan | `#22D3EE` | Live, in-progress |
| Status: AI event (ingest, hit, promotion) | indigo | `#818CF8` | Daemon doing work |
| Status: promoted-to-canonical highlight | gold | `#FBBF24` | Rare, celebratory |

Colors are tokens. Reference via Tailwind theme extension, never hex literals in components.

### 10.3 Typography

- **UI font**: Inter (variable). Fallback: system sans (`-apple-system, Segoe UI`).
- **Code / IDs / numerics**: JetBrains Mono.
- **Display headings (Daily Brief title, Section names)**: Inter Tight or Inter, weight 700, generous line-height.
- **Body**: Inter, weight 400, line-height 1.5.
- **Tabular numbers**: enabled site-wide (`font-variant-numeric: tabular-nums`) so changing values do not jiggle layout.
- **Sizes**: a small scale. `text-xs (12), text-sm (14), text-base (16), text-lg (18), text-xl (20), text-2xl (24), text-3xl (30), text-5xl (48)`. No more.

### 10.4 Spacing and layout

- **Spacing scale**: 4-based (`4, 8, 12, 16, 24, 32, 48, 64`). Tailwind defaults.
- **Container max-width**: `1440px` desktop. Centered. Side rails are part of the layout, not floating.
- **Card padding**: `16px` for compact, `24px` for primary cards. Consistent within a context.
- **Border radius**: `6px` for cards, `4px` for inputs and buttons, `9999px` for pills. No square corners anywhere.
- **Information density**: high. Compare to Linear, Raycast, Vercel dashboard, OpenStatus. Not Notion. Not Asana.
- **Whitespace between sections**: `48px` minimum so the eye can find groupings.

### 10.5 Motion

Motion is functional, not decorative. Every animation answers a question.

- **Page transitions**: 150ms fade + slight slide. Never longer.
- **Component mount**: subtle scale-in (0.97 → 1.0) over 120ms.
- **Hover**: 100ms color transition, no scale.
- **Status pill state change** (green → amber): 250ms color cross-fade, no flash.
- **Stream Deck card "active session" indicator**: 1.5s breathing pulse (opacity 0.6 → 1.0 → 0.6) for cyan dot.
- **Live activity stream entry arrives**: slides in from right, settles into list, ~200ms.
- **Page promoted to canonical event**: brief gold halo on the orb node (Phase 4) and a 600ms gold flash on the dashboard event card.
- **Long-running operations** (ingest, lint): inline spinner using brand accent. Never a full-screen blocker.

Use `framer-motion` for component animations, CSS for hover/focus.

### 10.6 Iconography

- **Library**: Lucide. Stroke 1.5px. Size 16/20/24 only.
- **No emoji in UI** (per global CLAUDE.md). Status icons use Lucide CheckCircle, AlertTriangle, XCircle, Clock, Zap, etc.
- **Brand mark**: a stylized neuron / orb glyph. To be designed in Phase 3.4 with Figma MCP.

### 10.7 Components

Built on shadcn/ui + Tailwind. Specific components used:
- Card, Badge, Button, Input, Dialog, Sheet, Tabs, Tooltip, Toast, Command (cmd+K), DropdownMenu, ScrollArea, Skeleton (loading states)
- Chart components from Tremor (LineChart, BarChart, AreaChart, DonutChart, SparkAreaChart) for system metrics
- Custom: StreamDeckCard, ServiceStatusPill, ActivityFeedItem, PageCard, ProjectCard, UploadDropzone, OrbPanel (Phase 4)

### 10.8 Mobile-first responsiveness

Phone view designed first. Desktop adds panels rather than the reverse.

- **Mobile (< 768px)**: single column scroll. Bottom tab bar (Home, Wiki, Sessions, System). No left rail. No right rail. Hamburger drawer for less-used pages (Reminders, Orb, Settings).
- **Tablet (768-1279px)**: single column main + collapsible right rail. Bottom tab bar still present.
- **Desktop (>= 1280px)**: full three-pane layout (Stream Deck left, content center, Activity Stream right).
- **Touch targets**: minimum 44x44px on mobile. Buttons sized by Tailwind `h-11` minimum.
- **Gestures**: swipe left/right to switch tabs on mobile. Long-press a Stream Deck card on mobile = quick-prompt sheet.

### 10.9 Loading and empty states

Every panel has three states: loading, empty, populated. Each is designed.

- **Loading**: skeleton placeholders matching final shape. Pulse animation 1.4s.
- **Empty**: icon + one-sentence explanation + one primary action. Example: empty Wiki tab → "Your wiki is still learning. Use Claude for a few days and pages will appear here automatically." + "Open recent sessions" button.
- **Error**: red-bordered card with the error, a "retry" button, and a link to the troubleshooting doc.

### 10.10 Accessibility

- All interactive elements keyboard-focusable. Visible focus ring (2px brand accent, 2px offset).
- Color contrast meets WCAG AA on every text + background combination.
- Screen reader labels on every icon-only button.
- `prefers-reduced-motion` respected: animations shortened to 0ms when set.

### 10.11 Tooling

- **Magic MCP**: used at dev time to generate component scaffolds quickly. Output reviewed before commit.
- **Figma MCP**: used at dev time for asset iteration (brand mark, illustrations, chart styling). Final assets exported as SVG and committed.
- **Storybook**: optional; if added, lives at `08-dashboard/.storybook/`.

### 10.12 Reference inspiration

Aesthetic direction (NOT to copy, just to anchor):
- **Linear**: density, dark theme, motion restraint
- **Raycast**: command palette as primary navigation, monospace for data
- **Vercel dashboard**: information density, status pills
- **OpenStatus**: monitoring board UX
- **Apple Watch**: glanceable status at very small sizes (mobile widget consideration)
- **Tremor catalog**: chart styling

The dashboard should feel like a tool a senior engineer keeps open all day. Not like a SaaS landing page.

---

## 11. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 with App Router | SSR for fast first paint, file-based routing, PWA support straightforward, mobile-friendly |
| UI kit | Tailwind CSS + shadcn/ui | High-quality default components, mobile-responsive, easy to customize. Pairs with Magic MCP and Figma MCP for design iteration. |
| Charts | Tremor + Recharts | Solid defaults, dashboard-grade |
| Icons | Lucide | Clean, consistent |
| Backend | Existing 07-daemon (Fastify) extended | One process, less surface area |
| WebSocket | `@fastify/websocket` (already installed) for real-time events | Same daemon, single port |
| Auth | None at app layer; trust via host-binding (localhost / Tailscale) | Simpler than a PIN, and the PIN gate blocked tooling like Chrome DevTools / Playwright MCP. |
| File upload | `@fastify/multipart` | Streaming uploads, progress |
| Document processing | `pdf-parse`, `tesseract.js`, `whisper-node` (whisper.cpp wrapper), `ffmpeg-static`, `mammoth` | All local, no API |
| Push notifications | `web-push` | Standard VAPID flow |
| State management (frontend) | React Server Components + Tanstack Query for client state | SSR-friendly |
| Build | Next.js dev/build, daemon serves the built `out/` directory in production | One process serves API and UI |
| Mobile | PWA: manifest.json + service worker | Installable on iOS / Android, push notifications |
| Tailscale | No special integration; daemon binds `0.0.0.0`, Tailscale routes | Zero config |

### 10.1 Why Next.js over a lighter alternative

- App Router gives clean server-side data fetching for pages like Daily Brief that need server-rendered content.
- PWA story is well-trodden.
- Mobile-first responsive defaults are easy with Tailwind + shadcn.
- Component library quality matters for "visually stunning" goal; Next.js + shadcn is a known-good combination.

### 10.2 What NOT to use

- No server-side authentication providers (NextAuth/Auth.js): trust is host-binding via Tailscale, the dashboard is single-user and never internet-exposed.
- No external database: all state lives in the daemon's existing SQLite + filesystem.
- No paid services anywhere (no Vercel hosting, no Pinecone, no Supabase). Self-hosted on `OTLCDEV`.
- No remote MCP servers in production. Magic MCP and Figma MCP are dev-time tools used to iterate the UI; they don't ship.

---

## 12. API extensions to the daemon

New routes on the existing Fastify instance.

```
GET  /dashboard/health              # all-in-one health summary for the home pill
GET  /dashboard/daily-brief         # rendered Daily Brief markdown + structured summary
GET  /dashboard/system-metrics      # CPU/RAM/disk/GPU/ollama (live snapshot)
WS   /dashboard/events              # live activity stream (page injected, hit, project change, etc)

GET  /sessions                      # list all active Claude sessions on OTLCDEV
GET  /sessions/:id                  # detail: task, summary, recent chunks
GET  /sessions/:id/transcript?from=…&n=…   # paged transcript chunks
POST /sessions/:id/prompt           # send a prompt via session bridge
POST /sessions/:id/focus            # focus the matching VS Code window (host-only)

GET  /projects                      # list registered projects with status
GET  /projects/:id                  # detail
POST /projects/new                  # clone template + scaffold + register

POST /upload                        # multipart upload of a doc/image/audio/video
GET  /reference/:doc_id             # doc detail
GET  /reference/:doc_id/file        # download original
GET  /search/all                    # unified search across wiki + raw + reference

GET  /reminders                     # list
POST /reminders                     # create
PATCH /reminders/:id                # update / complete
DELETE /reminders/:id               # delete

GET  /notifications                 # list (paged)
POST /notifications/:id/dismiss
POST /notifications/subscribe       # web push subscription

GET  /services                      # service status manifest

POST /auth/cross-session-token      # short-lived HMAC for cross-session prompt injection
```

No app-level auth gate. Trust is host-binding (localhost / Tailscale).

---

## 13. File layout

```
c:/dev/Projects/DevNeural/
  03-web-app/                       # orb only (Phase 4)
  05-voice-interface/               # reshapes later
  06-notebooklm-integration/        # reshapes later
  07-daemon/                        # existing daemon, gains new routes
    src/
      ...
      dashboard/                    # NEW: dashboard-specific server logic
        auth-secret.ts              # HMAC secret store (cross-session injection)
        daily-brief.ts              # generation + caching
        system-metrics.ts           # OS metrics
        services.ts                 # status manifest checker
        notifications.ts            # delivery + persistence
        reminders.ts                # CRUD
        push.ts                     # VAPID + web-push
      reference/                    # NEW: reference corpus
        upload.ts                   # multipart receiver
        process.ts                  # pipeline dispatcher
        pdf.ts                      # pdf-parse + OCR fallback
        image.ts                    # tesseract OCR
        audio.ts                    # whisper
        video.ts                    # ffmpeg + whisper
        chunk.ts                    # paragraph-aware chunking
        store.ts                    # reference_chunks Chroma + reference_meta SQLite
      sessions/                     # NEW: session bridge
        bridge.ts                   # outbound queue to VS Code extension
        list.ts                     # list active sessions
        focus.ts                    # window focus on host
      projects/                     # NEW: project scaffolding
        new.ts                      # clone template + scaffold
        list.ts
  08-dashboard/                     # NEW: Next.js app
    package.json
    next.config.mjs
    tailwind.config.ts
    public/
      manifest.json                 # PWA manifest
      icons/
      service-worker.js             # push handler
    app/
      layout.tsx                    # root, theme, auth gate
      page.tsx                      # home (daily brief)
      wiki/page.tsx                 # search + results
      sessions/page.tsx
      sessions/[id]/page.tsx
      projects/page.tsx
      projects/[id]/page.tsx
      system/page.tsx
      reminders/page.tsx
      orb/page.tsx                  # phase 4 placeholder
      api/                          # proxy routes to daemon (mostly thin pass-through)
    components/
      stream-deck/
      command-palette/
      search-bar/
      activity-stream/
      service-status-pill/
      daily-brief-card/
      project-grid/
      session-detail/
      upload-modal/
      ...
    lib/
      daemon-client.ts              # fetch wrapper, WS wrapper
      auth.ts                       # client-side cookie checks
      push.ts                       # subscribe / unsubscribe
  09-bridge/                        # NEW: VS Code extension for session bridge + window focus
    package.json
    src/
      extension.ts
      bridge-server.ts              # listens for daemon messages
      send-prompt.ts                # paste into terminal
      focus-window.ts
    README.md
  docs/
    spec/
      devneural-v2.md
      DEVNEURAL.md
      phase-3-dashboard.md          # this file
      phase-4-orb.md
  archive/
    v1/
  start.bat                         # rewritten to launch daemon + dashboard

c:/dev/data/skill-connections/
  ...                               # existing stuff
  dashboard/                        # NEW
    auth.json                       # HMAC secret (cross-session injection); legacy PIN fields stripped on read
    notifications.jsonl
    reminders.jsonl
    push-subscriptions.jsonl
    vapid.json
    config.jsonc                    # service status manifest, monitored URLs
  reference/                        # NEW
    docs/<doc-id>/
    images/<img-id>/
    audio/<audio-id>/
    video/<video-id>/
    queue/<upload-id>/
  session-bridge/                   # NEW
    <session-id>.in                 # outbound prompt queue per session
```

---

## 14. Build phases for Phase 3 itself

Phase 3 is large. Sub-phases so each is shippable.

| # | Sub-phase | Scope | Verifies |
|---|---|---|---|
| 3.1 | **Daemon API extensions** | New routes (no UI yet): /dashboard/*, /sessions, /projects/new, /reference upload + process, /search/all, /reminders, /notifications, /services | Curl every endpoint, returns sensible data |
| 3.2 | **Reference corpus pipeline** | Upload → extract → chunk → embed → store, for PDF + image. Audio/video deferred to 3.5 | Upload a real PDF, search returns relevant chunks |
| 3.3 | **Session bridge (09-bridge)** | VS Code extension that receives daemon messages and pastes into terminal. Focus-window action | Send "echo hello" from curl to a running session, see it appear and execute |
| 3.4 | **Dashboard scaffold (08-dashboard)** | Next.js app, Tailwind + shadcn, daemon-client wrapper, layout shell, all pages stubbed with real data wiring | Open in browser, see real data populated everywhere |
| 3.5 | **Audio + video processing** | whisper.cpp + ffmpeg, video frame sampling | Upload a video, transcript appears in search |
| 3.6 | **Stream Deck + session detail** | Polished left rail + per-session steering panel, send prompt works end to end | Tap a session card on phone, type a prompt, watch the host machine's session receive it |
| 3.7 | **Notifications + reminders + push** | In-dashboard banners, web push subscription, reminder CRUD, alert routing | Set a reminder for 1 minute from now, get a push on the phone |
| 3.8 | **System panel + metrics** | CPU/RAM/disk/GPU charts, daemon log tail, daemon controls | Open System tab, see live data |
| 3.9 | **New project flow** | End-to-end "+ New Project" → clone template → scaffold → open VS Code → register | Click button, project appears in list, VS Code opens |
| 3.10 | **Daily brief + whats-new rendering** | Pretty render of `wiki/whats-new.md` plus an LLM-generated daily brief on top | Open dashboard at 9am, brief is fresh and informative |
| 3.11 | **PWA polish + mobile** | Manifest, icons, service worker, splash, install prompt, push lifecycle | Add to Home Screen on iOS and Android, run as installed app |
| 3.12 | **Polish pass** | Animations, transitions, loading states, error states, empty states, accessibility, keyboard shortcuts, command palette | Looks visually stunning, feels real |

3.1 through 3.4 is the MVP. Everything else makes it production-grade.

---

## 15. Open design questions

1. **Session bridge: VS Code extension vs PowerShell + AutoHotkey.** Extension is cleaner but adds a moving part. PowerShell is fragile but no install step. Recommend extension.

2. **Daily brief generator: which LLM call?** Local Qwen 8B or use the cheaper Haiku via API just for this? The brief is once per day, so Haiku would be ~$0.01/day. Could be a hybrid setting.

3. **Document processing queue: how to expose progress?** Per-upload progress events over WS? Or just polling status on the doc record?

4. **Dashboard binding: IP and port.** `0.0.0.0:7474` default. Make configurable.

5. **Mobile push on iOS.** Requires the user to install the PWA via "Add to Home Screen" before push works. Document this clearly.

6. **What if multiple Claude sessions are open in the same project?** Stream Deck shows each individually but the project grid aggregates. Confirm desired behavior.

7. **File upload size cap.** 100MB default. Books and long videos could exceed. Make configurable, warn user when uploading huge files.

8. **Sensitivity tagging at upload time.** v1 has no privacy gating, but capture the tag now so later filters work. Default `none`, options `personal`, `confidential`.

9. **Service status manifest: hand-edited or auto-discovered?** Probably hand-edited (`dashboard/config.jsonc`) with reasonable defaults for known services (daemon, ollama, tailscale, internet).

10. **Window focus when dashboard is on Tailscale (remote).** Disable the focus button, but show a tooltip "this only works when accessing locally."

11. **Authentication for the WebSocket.** Token in subprotocol or in a query param? Both work. Decide.

12. ~~**PIN reset workflow if you forget it.**~~ Resolved: PIN removed entirely 2026-05-15. Trust is host-binding (localhost / Tailscale).

---

## 16. Out of scope for Phase 3

- Multi-user authentication.
- Multi-machine sync (everything on `OTLCDEV`).
- Privacy/demo mode (Phase 4+).
- The orb itself (Phase 4).
- A public-facing version of the dashboard.
- Cross-developer sharing of wiki/reference.
- Cloud backup (manual export only in v1).
- Calendar / external task integrations.
- Email integration.
- Slack / Discord integration.
- Voice output for the dashboard (input via browser STT is in scope; full voice UX is its own thing).

---

## 17. Acknowledgements / dependencies

- Builds on top of the daemon shipped in Phase 1.
- Phase 2 (v1 burndown) cleans up `01-data-layer`, `02-api-server`, `04-session-intelligence`, root `start.bat`, and root `README.md`. Phase 3 adds, Phase 2 removes; can run in parallel.
- Magic MCP (21st.dev) used at dev time for component generation.
- Figma MCP used at dev time for design assets.
- Phase 4 (orb rebind) plugs into the dashboard's Orb panel placeholder.

---

*Michael Collins. Stay on the level.*
