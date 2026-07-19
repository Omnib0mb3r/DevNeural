"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { TerminalMirror } from "@/components/TerminalMirror";
import { Icon } from "@/components/Icon";
import {
  listPtys,
  ptyInject,
  uploadScreenshot,
  lexAnchors,
  listProjectAnchorTiles,
  createLexAnchor,
  endLexAnchor,
  DaemonError,
  type PtyEntry,
} from "@/lib/daemon-client";
import { LexSessionList } from "@/components/LexSessionList";
import { LexArtifactsPanel } from "@/components/LexArtifactsPanel";
import { LexTranscriptHistoryPanel } from "@/components/LexTranscriptHistoryPanel";
import { emitTranscriptTurn } from "@/lib/transcript-bus";
import {
  emitVoiceAnchorSwitch,
  onVoiceAnchorSwitch,
} from "@/lib/voice-anchor-bus";

/**
 * Brainstorming with Lex.
 *
 * Lex runs as a daemon-managed PTY at <dataRoot>/brainstorm/. The
 * daemon spawns `claude --append-system-prompt <lex prompt>` so this
 * is just a Claude Code session with a different personality. Every
 * Claude Code tool (Read, Write, Bash, WebFetch, WebSearch, Edit) is
 * available; Lex's system prompt teaches him the daemon API surface
 * so he can search the wiki, list projects, queue prompts to worker
 * sessions, and act on what you brainstorm together.
 *
 * Voice (mic + TTS + barge-in) lands in a follow-up slice. This page
 * is the text surface today; the voice client mounts here when ready.
 */
/* Selection source of truth: the ?brainstorm=<anchor id> URL param.
 * The global VoiceClient's hello already prefers this param, so the
 * text surface, terminal mirror, and voice all follow the SAME
 * selection. Navigation (full reload) on switch forces the voice WS
 * to re-hello against the newly selected anchor. */
function selectedAnchorIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("brainstorm");
}

export default function LexPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const ptysQ = useQuery({
    queryKey: ["pty-list"],
    queryFn: listPtys,
    refetchInterval: 3_000,
  });
  /* SESSIONS-VIEW defect 2: selection is reactive now (not just
   * mount-captured), because switching is a soft router.push, not a full
   * reload. The switch bus updates it so the text surface + terminal
   * mirror follow the switch without a page reload, in lockstep with the
   * global VoiceClient re-pinning its bind on the live socket. */
  const [selectedAnchorId, setSelectedAnchorId] = useState<string | null>(
    selectedAnchorIdFromUrl,
  );
  useEffect(() => onVoiceAnchorSwitch(setSelectedAnchorId), []);

  /* Soft-nav to a brainstorm (or deselect with null): update the URL for
   * deep-linking + the local selection + signal voice - no full reload,
   * so the live voice never blips. */
  function navigateToAnchor(id: string | null): void {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("brainstorm", id);
      else url.searchParams.delete("brainstorm");
      router.push(url.pathname + url.search);
    }
    setSelectedAnchorId(id);
    emitVoiceAnchorSwitch(id);
  }

  /* Resolve the active anchor list up front: lexPty resolution needs
   * it to honor the user's selection. /lex/anchors carries each
   * anchor's current_pty_id. */
  const activeAnchorsQ = useQuery({
    queryKey: ["lex-anchors", "live"],
    queryFn: () => lexAnchors({ status: "live", limit: 20 }),
    refetchInterval: 5_000,
  });
  const liveAnchors = activeAnchorsQ.data?.anchors ?? [];

  /* Pick the active Lex PTY.
   *
   * Bug 2026-07-08 (switch does nothing): the old rule was "newest-
   * started live brainstorm PTY", written when switch-to killed the
   * previous PTY. With several anchors live at once, that rule
   * welded the page to whichever session started last and made
   * "switch to" a silent no-op. The selection (?brainstorm=) now
   * wins whenever the selected anchor has a live PTY; newest-started
   * remains only as the fallback for un-parameterised visits. */
  const brainstormPtys = (ptysQ.data?.ptys ?? []).filter(
    (p) => !p.exited && /\/brainstorm\/?$/i.test(p.cwd.replace(/\\/g, "/")),
  );
  const selectedAnchor = selectedAnchorId
    ? liveAnchors.find((a) => a.id === selectedAnchorId) ?? null
    : null;
  const selectedPty = selectedAnchor?.current_pty_id
    ? brainstormPtys.find((p) => p.ptyId === selectedAnchor.current_pty_id)
    : undefined;
  /* With an explicit selection, NEVER fall back to another anchor's
   * PTY: the voice client targets the URL anchor, so a silent
   * fallback would split voice and text across two different
   * sessions (review finding 2026-07-08). A selection without a
   * live PTY renders the offline empty state until the anchors
   * query catches up or the user opens the row. Newest-started
   * remains the fallback only for un-parameterised visits. */
  const lexPty: PtyEntry | undefined = selectedAnchorId
    ? selectedPty ?? undefined
    : [...brainstormPtys].sort((a, b) => b.startedAt - a.startedAt)[0];
  /* Suppress the offline flash while the anchors query is still
   * resolving a fresh selection (first render after a switch). */
  const selectionPending = Boolean(selectedAnchorId) && activeAnchorsQ.isLoading;

  /* Spawn / end now go through the new /lex/anchors API.
   * createLexAnchor mints a fresh anchor + spawns its first CC
   * session; endLexAnchor kills the live PTY and flips the anchor
   * to dormant. Awaiting the pty-list refetch in onSettled keeps
   * each mutation's isPending true until the page's lexPty
   * resolution has caught up — without the await the voice panel
   * mount target briefly disappears across the handoff. */
  const newAnchorM = useMutation({
    mutationFn: () => createLexAnchor({}),
    onSuccess: (data) => {
      /* Route the page (and the voice client) at the fresh anchor so
       * "new session" actually shows the new session even when an
       * older PTY is still live. */
      if (data?.ok && data.anchor_id) {
        navigateToAnchor(data.anchor_id);
      }
    },
    onSettled: async () => {
      await qc.refetchQueries({ queryKey: ["pty-list"] });
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
    },
  });
  const endAnchorM = useMutation({
    mutationFn: (id: string) => endLexAnchor(id),
    onSuccess: (_data, id) => {
      /* A stale ?brainstorm= pointing at an ended anchor would make
       * the voice hello fail with brainstorm-ended on the next
       * reload; drop the param when ending the selected anchor. */
      if (selectedAnchorId && selectedAnchorId === id) {
        navigateToAnchor(null);
      }
    },
    onSettled: async () => {
      await qc.refetchQueries({ queryKey: ["pty-list"] });
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
    },
  });

  const [pendingText, setPendingText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* Inject mutation. Mirrors SendPromptForm on /sessions: route through
   * useMutation so a failed POST surfaces as a visible error toast
   * instead of vanishing silently. The previous plain async + try/
   * finally hid every failure (401, daemon down, ok:false response):
   * the button blinked "sending..." and reverted with no feedback,
   * which read as "the send button does nothing". */
  const injectM = useMutation({
    mutationFn: (text: string) => {
      if (!lexPty) throw new Error("no Lex PTY bound yet");
      const target = lexPty.sessionId ?? lexPty.ptyId;
      return ptyInject(target, text, true);
    },
    onSuccess: (data, text) => {
      if (data?.ok === false) {
        setSendError(data.error ?? "inject refused");
        return;
      }
      /* Mirror the voice STT path. VoiceClient pushes every recognised
       * utterance into the transcript bus so LexTranscriptHistoryPanel
       * surfaces it; the typed-textarea submit went straight to the
       * PTY and never emitted, so the panel only ever showed voice
       * turns. Reaching the same bus here closes the gap. The turn
       * id is local-only — the daemon doesn't ack a stable id for
       * typed injects yet, so prefix with "u-typed-" so the panel
       * can distinguish the source if it ever needs to. */
      const id = `u-typed-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      emitTranscriptTurn({ id, role: "user", text });
      setPendingText("");
      setSendError(null);
    },
    onError: (err) => {
      const e = err as DaemonError;
      const payload = e.payload as { error?: string } | undefined;
      setSendError(payload?.error ?? e.message ?? "send failed");
    },
  });

  function spliceIntoTextarea(p: string) {
    const ta = textareaRef.current;
    const pos = ta?.selectionStart ?? pendingText.length;
    const end = ta?.selectionEnd ?? pos;
    const before = pendingText.slice(0, pos);
    const after = pendingText.slice(end);
    const insert =
      (before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "") + p + " ";
    setPendingText(before + insert + after);
  }

  async function uploadAndSplice(blob: Blob) {
    setUploading(true);
    setUploadError(null);
    try {
      const mime = blob.type || "image/png";
      const ext = (mime.split("/")[1] ?? "png").split("+")[0];
      const result = await uploadScreenshot(blob, `paste-${Date.now()}.${ext}`);
      if (!result.ok || !result.path) {
        setUploadError(result.error ?? "upload failed");
        return;
      }
      spliceIntoTextarea(result.path);
    } catch (err) {
      const e = err as DaemonError;
      const payload = e.payload as { error?: string } | undefined;
      setUploadError(payload?.error ?? e.message);
    } finally {
      setUploading(false);
    }
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (imageItem) {
      const blob = imageItem.getAsFile();
      if (blob) {
        e.preventDefault();
        await uploadAndSplice(blob);
        return;
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.read) {
      try {
        const ci = await navigator.clipboard.read();
        for (const item of ci) {
          const imgType = item.types.find((t) => t.startsWith("image/"));
          if (!imgType) continue;
          const blob = await item.getType(imgType);
          e.preventDefault();
          await uploadAndSplice(blob);
          return;
        }
      } catch {
        /* fall through to default text paste */
      }
    }
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    void uploadAndSplice(f);
    e.target.value = "";
  }

  /* Active anchor keyed off the resolved lexPty (which already
   * honors the ?brainstorm= selection) so the artifacts panel and
   * past-sessions row highlight stay in sync with what the mirror
   * and inject actually target. */
  const activeAnchorId =
    liveAnchors.find((a) => a.current_pty_id === lexPty?.ptyId)?.id ?? null;

  /* Worker terminal mirror (2026-07-18 operator ask): show the mirror
   * of the worker this Lex is supervising, right next to Lex's own
   * terminal. We already TRACK that binding - the active anchor's
   * supervises_project_anchor_id points at the supervised project
   * anchor, whose live tile carries current_session_id. This only READS
   * that binding to pick a session id for a second read-only mirror; it
   * changes no anchor/supervision logic. Null (no supervised worker, or
   * it is not live) simply renders no worker mirror. */
  const activeAnchor = liveAnchors.find((a) => a.id === activeAnchorId) ?? null;
  const supervisedProjectAnchorId =
    activeAnchor?.supervises_project_anchor_id ?? null;
  const tilesQ = useQuery({
    queryKey: ["project-anchor-tiles", "all"],
    queryFn: () => listProjectAnchorTiles({ status: "all" }),
    refetchInterval: 10_000,
    enabled: Boolean(supervisedProjectAnchorId),
  });
  const supervisedTile =
    (supervisedProjectAnchorId
      ? tilesQ.data?.tiles?.find(
          (t) => t.anchor_id === supervisedProjectAnchorId,
        )
      : null) ?? null;
  const workerSessionId = supervisedTile?.current_session_id ?? null;
  /* WIRE (2026-07-19): the project label each mirror shows, resolved
   * here off the authoritative anchor->project binding rather than the
   * mirror's own /sessions lookup (which is empty for the Lex/anchor
   * session and stale for a worker uuid that rotated on /clear). The Lex
   * terminal is the brainstorm's own session, so it shows the brainstorm
   * name; the worker terminal shows the supervised project's slug. */
  const workerProjectSlug =
    supervisedTile?.project_slug ?? supervisedTile?.title ?? null;
  const lexProjectLabel =
    activeAnchor?.title ??
    activeAnchor?.derived_title ??
    supervisedTile?.project_slug ??
    null;

  /* No auto-spawn. Landing on /lex with no live brainstorm PTY
   * renders the empty state ("Lex isn't running. Click start lex")
   * below. The user explicitly starts a session by clicking
   * "start lex" / "new brainstorm" or switching to a past row.
   * Previous auto-spawn races created an unwanted session every
   * time the page mounted, polluted past-sessions with one-turn
   * orphans, and made "switch to" feel broken because a fresh
   * spawn was already in flight. */

  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Icon name="Sparkles" className="text-brandSoft" size={22} />
            <h1 className="font-display text-2xl font-emphasized">
              Lex
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {lexPty && activeAnchorId ? (
              <button
                type="button"
                onClick={() => endAnchorM.mutate(activeAnchorId)}
                disabled={endAnchorM.isPending || newAnchorM.isPending}
                className="text-xs px-3 py-1.5 rounded-pill bg-surface2 hairline hover:bg-surface3 text-txt2 disabled:opacity-40 disabled:cursor-not-allowed"
                title="End this Lex conversation"
              >
                {endAnchorM.isPending ? "ending…" : "end session"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => newAnchorM.mutate()}
              disabled={newAnchorM.isPending || endAnchorM.isPending}
              className="text-xs px-3 py-1.5 rounded-pill bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft hover:bg-brand/15 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              title={lexPty ? "Start a fresh Lex conversation (the current one stays open)" : "Start a Lex conversation"}
            >
              <Icon name="Plus" size={12} />
              {newAnchorM.isPending
                ? "starting…"
                : lexPty
                  ? "new session"
                  : "start lex"}
            </button>
          </div>
        </div>

        <p className="text-sm text-txt3 max-w-3xl">
          Lex is your local AI partner. Talk through ideas, plan projects, take notes, or hand off work. He can read your wiki, send tasks to running workers, and set reminders.
        </p>

        <LexSessionList
          activeAnchorId={activeAnchorId}
          activePtyId={lexPty?.ptyId ?? null}
        />

        {!lexPty && !newAnchorM.isPending && !selectionPending && (
          <div className="rounded-panel bg-surface1 hairline p-8 text-center">
            <p className="text-sm text-txt3 mb-3">
              {selectedAnchorId
                ? "This brainstorm has no live session. Open it from the list below, or start a new one."
                : (
                  <>
                    Lex is offline. Click <strong>start lex</strong> above to begin a conversation.
                  </>
                )}
            </p>
          </div>
        )}

        {(lexPty || newAnchorM.isPending) && (
          <>
            {/* Voice panel mount target. The actual VoiceClient
             * component is mounted once at the application root in
             * app/providers.tsx so its WS / mic / AudioContext
             * survive in-app navigation; on /lex it portals the
             * full panel UI into this div, and on every other
             * route a floating mini-badge takes over. */}
            <div id="voice-panel-mount" />
            {/* Layout order is: transcripts → Talk-to-Lex form →
             * TerminalMirror. The conversational surface (history +
             * compose box) stays together at the top so reading and
             * responding don't require scrolling past the raw
             * terminal stream. The mirror sits below for the cases
             * where the user wants to inspect tool calls directly. */}
            <LexTranscriptHistoryPanel />
            <div className="rounded-panel bg-surface1 hairline">
              <div className="px-5 py-3 border-b border-border1 flex items-center gap-2">
                <Icon name="MessageSquare" className="text-brandSoft" size={16} />
                <h2 className="font-display text-sm font-emphasized">
                  Talk to Lex
                </h2>
                <span className="text-nano text-txt3 ml-2">
                  {lexPty?.sessionId
                    ? `session ${lexPty.sessionId.slice(0, 12)}`
                    : "spinning up…"}
                </span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (injectM.isPending) return;
                  if (!pendingText.trim()) return;
                  injectM.mutate(pendingText);
                }}
                className="p-4 space-y-3"
              >
                <textarea
                  ref={textareaRef}
                  value={pendingText}
                  onChange={(e) => setPendingText(e.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (
                      (e.metaKey || e.ctrlKey) &&
                      e.key === "Enter" &&
                      !injectM.isPending &&
                      pendingText.trim()
                    ) {
                      e.preventDefault();
                      injectM.mutate(pendingText);
                    }
                  }}
                  placeholder="What's on your mind? (Ctrl+Enter to send, paste a screenshot to attach)"
                  rows={3}
                  className="w-full px-3 py-2 rounded-input bg-surface2 hairline text-txt1 outline-none focus:ring-1 focus:ring-brand/60 text-sm font-mono resize-y placeholder:text-txt3"
                  disabled={!lexPty?.sessionId && !lexPty?.ptyId}
                />
                {uploading && (
                  <div className="text-nano text-txt3 font-mono">uploading screenshot…</div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-nano text-txt3">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="h-9 w-9 rounded-input hairline grid place-items-center text-txt2 hover:text-txt1 disabled:opacity-40"
                      aria-label="Attach screenshot"
                      title="Attach a screenshot from camera roll or files"
                    >
                      <Icon name="Paperclip" size={16} />
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={onFilePicked}
                      className="hidden"
                      aria-hidden="true"
                    />
                    <span className="font-mono">
                      {lexPty?.sessionId
                        ? "ready"
                        : lexPty
                          ? "waiting for first turn to bind session id…"
                          : "no session"}
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={
                      injectM.isPending ||
                      !pendingText.trim() ||
                      (!lexPty?.sessionId && !lexPty?.ptyId)
                    }
                    className="px-4 py-1.5 text-xs font-emphasized rounded-pill bg-brand/15 text-brandSoft hairline ring-1 ring-brand/30 hover:bg-brand/25 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {injectM.isPending ? "sending…" : "send"}
                  </button>
                </div>
                {uploadError && (
                  <div className="text-xs text-err font-mono">
                    Upload failed: {uploadError}
                  </div>
                )}
                {sendError && (
                  <div className="text-xs text-err font-mono">
                    Send failed: {sendError}
                  </div>
                )}
              </form>
            </div>
            {/* TerminalMirror lives below the compose box so the
             * conversational pair (history + form) reads top-down
             * without the raw terminal stream interrupting it. The
             * mirror still pulls from the same terminal-stream ring;
             * before the daemon binds a session id, the panel is
             * empty and starts streaming once binding completes. */}
            <TerminalMirror
              sessionId={lexPty?.sessionId ?? ""}
              title="Lex terminal"
              projectSlug={lexProjectLabel}
            />
            {/* Worker terminal mirror: the session this Lex supervises
             * (read-only, resolved from the tracked supervises binding).
             * Renders only when a live supervised worker session exists. */}
            {workerSessionId && (
              <TerminalMirror
                sessionId={workerSessionId}
                title="Worker terminal"
                projectSlug={workerProjectSlug}
              />
            )}
            <LexArtifactsPanel
              brainstormId={activeAnchorId}
              active={Boolean(lexPty)}
            />
          </>
        )}

        {/* Future-mounted: voice client (mic capture, VAD, TTS playback) */}
      </div>
    </AppShell>
  );
}

