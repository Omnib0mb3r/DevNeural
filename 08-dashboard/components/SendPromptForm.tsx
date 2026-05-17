"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  queuePrompt,
  focusSession,
  bridgeStatus,
  uploadScreenshot,
  DaemonError,
} from "@/lib/daemon-client";
import { Icon } from "./Icon";

interface Props {
  sessionId: string;
}

export function SendPromptForm({ sessionId }: Props) {
  const [text, setText] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Poll bridge liveness so the user sees the form go red and the send
  // button disable when no VS Code window is running the bridge. Saves
  // them from typing a prompt that would fail anyway.
  const bridge = useQuery({
    queryKey: ["bridge-status"],
    queryFn: bridgeStatus,
    refetchInterval: 5_000,
  });

  const sendM = useMutation({
    mutationFn: (t: string) => queuePrompt(sessionId, t),
    onSuccess: (data, vars) => {
      if (data.ok) {
        setRecent((r) => [vars, ...r].slice(0, 3));
        setText("");
        setFailMsg(null);
      } else {
        setFailMsg(data.error ?? "queue refused");
      }
    },
    onError: (err) => {
      const e = err as DaemonError;
      const payload = e.payload as { error?: string } | undefined;
      setFailMsg(payload?.error ?? e.message);
    },
  });

  const focusM = useMutation({
    mutationFn: () => focusSession(sessionId),
  });

  /* Splice an absolute path into the textarea at the cursor.
   * Used by both the paste handler and the file-picker fallback. */
  function spliceIntoTextarea(p: string) {
    const ta = document.getElementById("prompt-input") as HTMLTextAreaElement | null;
    const pos = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? pos;
    const before = text.slice(0, pos);
    const after = text.slice(end);
    const insert =
      (before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "") + p + " ";
    setText(before + insert + after);
  }

  async function uploadAndSplice(blob: Blob) {
    setUploading(true);
    setFailMsg(null);
    try {
      const mime = blob.type || "image/png";
      const ext = (mime.split("/")[1] ?? "png").split("+")[0];
      const result = await uploadScreenshot(blob, `paste-${Date.now()}.${ext}`);
      if (!result.ok || !result.path) {
        setFailMsg(result.error ?? "upload failed");
        return;
      }
      spliceIntoTextarea(result.path);
    } catch (err) {
      const e = err as DaemonError;
      const payload = e.payload as { error?: string } | undefined;
      setFailMsg(payload?.error ?? e.message);
    } finally {
      setUploading(false);
    }
  }

  /* Paste-image handler.
   *
   * Desktop browsers populate clipboardData.items on Ctrl/Cmd+V. iOS
   * Safari often delivers a long-press paste with an empty items array
   * for screenshots; we fall back to the Async Clipboard API
   * (navigator.clipboard.read) which iOS does support on HTTPS with a
   * user gesture. If that also returns nothing, the user can use the
   * paperclip button to pick the file from the photo library. */
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
    // iOS fallback. navigator.clipboard.read returns ClipboardItem[]
    // with mime types we can sniff. Requires HTTPS + user gesture.
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
        // Permission denied or no image. Fall through to default paste.
      }
    }
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    void uploadAndSplice(f);
    // Reset so picking the same file twice still fires onChange.
    e.target.value = "";
  }

  return (
    <div className="rounded-panel bg-surface1 hairline">
      <div className="px-5 py-3 border-b border-border1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="Send" className="text-brandSoft" size={16} />
          <h2 className="font-display text-sm font-emphasized">Steer this session</h2>
          <span
            className={`text-nano font-mono ml-2 ${
              bridge.data?.alive ? "text-promoted" : "text-err"
            }`}
            title={
              bridge.data?.alive
                ? `bridge alive (last seen ${Math.round((bridge.data.age_ms ?? 0) / 1000)}s ago)`
                : "bridge offline. Reload your VS Code DevNeural window."
            }
          >
            {bridge.isLoading
              ? "bridge ?"
              : bridge.data?.alive
                ? "bridge live"
                : "bridge offline"}
          </span>
        </div>
        <button
          onClick={() => focusM.mutate()}
          disabled={focusM.isPending}
          className="text-xs font-mono text-txt3 hover:text-txt1 flex items-center gap-1"
        >
          <Icon name="Focus" size={14} />{" "}
          {focusM.isPending ? "focusing..." : "focus window"}
        </button>
      </div>
      <form
        className="p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) sendM.mutate(text.trim());
        }}
      >
        <label htmlFor="prompt-input" className="sr-only">
          Prompt text
        </label>
        <textarea
          id="prompt-input"
          name="prompt-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          placeholder="Type a prompt to send to this session… (paste a screenshot to attach)"
          rows={3}
          className="w-full px-3 py-2 rounded-input bg-surface2 hairline text-txt1 outline-none focus:ring-1 focus:ring-brand/60 text-sm font-mono resize-y placeholder:text-txt3"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) {
              e.preventDefault();
              sendM.mutate(text.trim());
            }
          }}
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
            <span><kbd className="font-mono">Ctrl+Enter</kbd> to send</span>
          </div>
          <button
            type="submit"
            disabled={!text.trim() || sendM.isPending || bridge.data?.alive === false}
            className="h-9 px-4 rounded-input bg-brand hover:bg-brand/90 text-base text-sm font-emphasized disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sendM.isPending ? "queuing..." : "send"}
          </button>
        </div>
        {failMsg && (
          <div className="text-xs text-err font-mono">
            Failed to queue: {failMsg}
          </div>
        )}
      </form>

      {recent.length > 0 && (
        <div className="border-t border-border2 px-5 py-3">
          <div className="text-nano text-txt3 mb-1.5">Recently sent</div>
          <ul className="space-y-1">
            {recent.map((r, i) => (
              <li key={i} className="text-xs font-mono text-txt2 truncate">
                ↳ {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
