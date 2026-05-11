"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { TerminalMirror } from "@/components/TerminalMirror";
import { Icon } from "@/components/Icon";
import {
  listPtys,
  ptyInject,
  uploadScreenshot,
  lexAnchors,
  createLexAnchor,
  endLexAnchor,
  DaemonError,
  type PtyEntry,
} from "@/lib/daemon-client";
import { LexSessionList } from "@/components/LexSessionList";
import { LexArtifactsPanel } from "@/components/LexArtifactsPanel";

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
export default function LexPage() {
  const qc = useQueryClient();
  const ptysQ = useQuery({
    queryKey: ["pty-list"],
    queryFn: listPtys,
    refetchInterval: 3_000,
  });

  /* Pick the active Lex PTY: the most-recently-started non-exited PTY
   * whose cwd ends in /brainstorm. We scope to that path so a daemon-
   * PTY spawned for some other project (Start Claude buttons) doesn't
   * show up here. The startedAt sort matters during a switch-to: while
   * the old PTY is still finishing taskkill /F /T teardown (a few
   * seconds on Windows) both ptys briefly satisfy the filter; picking
   * the newest one ensures the terminal mirror, voice client, and
   * inject all re-target the new session immediately. */
  const lexPty: PtyEntry | undefined = (ptysQ.data?.ptys ?? [])
    .filter(
      (p) => !p.exited && /\/brainstorm\/?$/i.test(p.cwd.replace(/\\/g, "/")),
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];

  /* Spawn / end now go through the new /lex/anchors API.
   * createLexAnchor mints a fresh anchor + spawns its first CC
   * session; endLexAnchor kills the live PTY and flips the anchor
   * to dormant. Awaiting the pty-list refetch in onSettled keeps
   * each mutation's isPending true until the page's lexPty
   * resolution has caught up — without the await the voice panel
   * mount target briefly disappears across the handoff. */
  const newAnchorM = useMutation({
    mutationFn: () => createLexAnchor({}),
    onSettled: async () => {
      await qc.refetchQueries({ queryKey: ["pty-list"] });
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
    },
  });
  const endAnchorM = useMutation({
    mutationFn: (id: string) => endLexAnchor(id),
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
    onSuccess: (data) => {
      if (data?.ok === false) {
        setSendError(data.error ?? "inject refused");
        return;
      }
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

  /* Resolve the active anchor keyed off the live PTY so the
   * artifacts panel and the past-sessions row highlight stay in
   * sync. /lex/anchors carries each anchor's current_pty_id, so a
   * simple find on the live ptyId returns the right anchor. */
  const activeAnchorsQ = useQuery({
    queryKey: ["lex-anchors", "live"],
    queryFn: () => lexAnchors({ status: "live", limit: 20 }),
    refetchInterval: 5_000,
  });
  const activeAnchorId =
    (activeAnchorsQ.data?.anchors ?? []).find(
      (a) => a.current_pty_id === lexPty?.ptyId,
    )?.id ?? null;

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
              Brainstorm with Lex
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {lexPty && activeAnchorId ? (
              <button
                type="button"
                onClick={() => endAnchorM.mutate(activeAnchorId)}
                disabled={endAnchorM.isPending || newAnchorM.isPending}
                className="text-xs px-3 py-1.5 rounded-pill bg-surface2 hairline hover:bg-surface3 text-txt2 disabled:opacity-40 disabled:cursor-not-allowed"
                title="End this brainstorm session"
              >
                {endAnchorM.isPending ? "ending…" : "end session"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => newAnchorM.mutate()}
              disabled={newAnchorM.isPending || endAnchorM.isPending}
              className="text-xs px-3 py-1.5 rounded-pill bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft hover:bg-brand/15 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              title={lexPty ? "Spawn a fresh Lex anchor (the current one stays alive)" : "Spawn Lex"}
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
          Lex is your supervisory AI for DevNeural. He runs locally on
          OTLCDEV with full access to the wiki, sessions, projects, and
          web. Brainstorm out loud, frame projects, take notes, ask him
          to act. He can scaffold projects, queue prompts to running
          worker sessions, and create reminders.
        </p>

        <LexSessionList
          activeAnchorId={activeAnchorId}
          activePtyId={lexPty?.ptyId ?? null}
        />

        {!lexPty && !newAnchorM.isPending && (
          <div className="rounded-panel bg-surface1 hairline p-8 text-center">
            <p className="text-sm text-txt3 mb-3">
              Lex isn&apos;t running. Click <strong>start lex</strong> above
              to spin up a session.
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
            {/* Reuse the existing TerminalMirror — it expects a session
             * id and pulls from the same terminal-stream ring the
             * daemon-PTY pumps into post-binding. Before binding we
             * still render the panel; the mirror starts streaming
             * once the session-id appears. */}
            <TerminalMirror sessionId={lexPty?.sessionId ?? ""} />
            <LexArtifactsPanel
              brainstormId={activeAnchorId}
              active={Boolean(lexPty)}
            />
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
                  placeholder="What's on your mind? (⌘+Enter to send, paste a screenshot to attach)"
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
          </>
        )}

        {/* Future-mounted: voice client (mic capture, VAD, TTS playback) */}
      </div>
    </AppShell>
  );
}

