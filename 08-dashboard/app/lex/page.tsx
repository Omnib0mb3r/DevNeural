"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { TerminalMirror } from "@/components/TerminalMirror";
import { VoiceClient } from "@/components/VoiceClient";
import { Icon } from "@/components/Icon";
import {
  listPtys,
  spawnLex,
  ptyInject,
  ptyKill,
  uploadScreenshot,
  DaemonError,
  type PtyEntry,
} from "@/lib/daemon-client";

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

  /* Pick the active Lex PTY: any non-exited PTY whose cwd ends in
   * /brainstorm. We scope to that path so a daemon-PTY spawned for
   * some other project (Start Claude buttons) doesn't show up here. */
  const lexPty: PtyEntry | undefined = (ptysQ.data?.ptys ?? []).find(
    (p) => !p.exited && /\/brainstorm\/?$/i.test(p.cwd.replace(/\\/g, "/")),
  );

  const spawnM = useMutation({
    mutationFn: () => spawnLex(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["pty-list"] }),
  });
  const killM = useMutation({
    mutationFn: (id: string) => ptyKill(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["pty-list"] }),
  });

  const [pendingText, setPendingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  /* When the dashboard send-prompt-form fires, route to the PTY
   * inject endpoint instead of the bridge-mediated /sessions/:id/prompt
   * since Lex is daemon-hosted. We send to the ptyId before the
   * session-id binds and to the session-id after; the daemon accepts
   * either. */
  async function injectPrompt(text: string) {
    if (!lexPty || !text.trim()) return;
    setBusy(true);
    try {
      const target = lexPty.sessionId ?? lexPty.ptyId;
      await ptyInject(target, text, true);
      setPendingText("");
    } finally {
      setBusy(false);
    }
  }

  /* Auto-spawn Lex on first visit if no live brainstorm PTY exists.
   * One-shot so a manual kill doesn't immediately respawn. */
  const [autoSpawned, setAutoSpawned] = useState(false);
  useEffect(() => {
    if (autoSpawned) return;
    if (ptysQ.isLoading) return;
    if (lexPty) return;
    setAutoSpawned(true);
    spawnM.mutate();
  }, [autoSpawned, ptysQ.isLoading, lexPty, spawnM]);

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
            {lexPty ? (
              <button
                type="button"
                onClick={() => killM.mutate(lexPty.ptyId)}
                className="text-xs px-3 py-1.5 rounded-pill bg-surface2 hairline hover:bg-surface3 text-txt2"
                title="End this brainstorm session"
              >
                end session
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => spawnM.mutate()}
              disabled={spawnM.isPending || Boolean(lexPty)}
              className="text-xs px-3 py-1.5 rounded-pill bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft hover:bg-brand/15 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Icon name="Plus" size={12} />
              {spawnM.isPending
                ? "starting…"
                : lexPty
                  ? "running"
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

        {!lexPty && !spawnM.isPending && (
          <div className="rounded-panel bg-surface1 hairline p-8 text-center">
            <p className="text-sm text-txt3 mb-3">
              Lex isn&apos;t running. Click <strong>start lex</strong> above
              to spin up a session.
            </p>
          </div>
        )}

        {(lexPty || spawnM.isPending) && (
          <>
            <VoiceClient sessionId={lexPty?.sessionId ?? null} />
            {/* Reuse the existing TerminalMirror — it expects a session
             * id and pulls from the same terminal-stream ring the
             * daemon-PTY pumps into post-binding. Before binding we
             * still render the panel; the mirror starts streaming
             * once the session-id appears. */}
            <TerminalMirror sessionId={lexPty?.sessionId ?? ""} />
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
                  if (busy) return;
                  injectPrompt(pendingText);
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
                      !busy
                    ) {
                      e.preventDefault();
                      injectPrompt(pendingText);
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
                      busy ||
                      !pendingText.trim() ||
                      (!lexPty?.sessionId && !lexPty?.ptyId)
                    }
                    className="px-4 py-1.5 text-xs font-emphasized rounded-pill bg-brand/15 text-brandSoft hairline ring-1 ring-brand/30 hover:bg-brand/25 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy ? "sending…" : "send"}
                  </button>
                </div>
                {uploadError && (
                  <div className="text-xs text-err font-mono">
                    Upload failed: {uploadError}
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

