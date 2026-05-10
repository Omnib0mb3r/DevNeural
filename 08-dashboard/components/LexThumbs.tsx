"use client";

/**
 * Wave 2 day 5 step 24 (LX-5 / B5). Inline thumbs UI rendered next
 * to a Lex turn. Posts to /lex/feedback so the prompt-tuning loop
 * can aggregate up-rate per system-prompt version.
 */
import { useMutation } from "@tanstack/react-query";
import { lexFeedback } from "@/lib/daemon-client";

export interface LexThumbsProps {
  turn_id: string;
  prompt_version: string;
  brainstorm_id?: string | null;
}

export function LexThumbs({ turn_id, prompt_version, brainstorm_id }: LexThumbsProps) {
  const upM = useMutation({
    mutationFn: () =>
      lexFeedback({ turn_id, prompt_version, vote: "up", brainstorm_id: brainstorm_id ?? null }),
  });
  const downM = useMutation({
    mutationFn: () =>
      lexFeedback({ turn_id, prompt_version, vote: "down", brainstorm_id: brainstorm_id ?? null }),
  });
  const upDone = upM.isSuccess;
  const downDone = downM.isSuccess;
  return (
    <div className="flex items-center gap-1 text-xs">
      <button
        type="button"
        onClick={() => upM.mutate()}
        disabled={upDone || downDone || upM.isPending}
        className={`rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono ${
          upDone ? "text-promoted" : ""
        } disabled:opacity-50`}
        title="this Lex turn was good"
      >
        ▲
      </button>
      <button
        type="button"
        onClick={() => downM.mutate()}
        disabled={upDone || downDone || downM.isPending}
        className={`rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono ${
          downDone ? "text-rose-400" : ""
        } disabled:opacity-50`}
        title="this Lex turn was bad"
      >
        ▼
      </button>
      <span className="font-mono text-[10px] text-txt3">
        v={prompt_version.slice(-8)}
      </span>
    </div>
  );
}
