"use client";

import * as React from "react";

interface VoiceErrorPillProps {
  message: string;
  onRetry: () => void;
}

/**
 * Voice mic-init error pill.
 *
 * The previous inline version applied Tailwind's `truncate` class to
 * the message span, which collapses a multi-line error like
 *
 *   mic init failed: no available backend found.
 *     ERR: [wasm] RangeError: ...
 *     [cpu] Error: previous call to 'initWasm()' failed.
 *
 * to "mic init failed: no available backend found. ERR: [wasm] Rang..."
 * The user cannot tell whether the suffix is RangeError, RangeError:
 * Out of memory, or something else. The real failure has to be
 * visible so the operator can diagnose without opening DevTools.
 *
 * This component wraps the full message with `whitespace-pre-wrap` +
 * `break-words` so newlines and very long unbroken strings render in
 * full. The retry button stays inline on the right.
 */
export function VoiceErrorPill({
  message,
  onRetry,
}: VoiceErrorPillProps): React.ReactElement {
  return (
    <div className="text-err flex-1 min-w-0 flex items-start gap-2">
      <span
        data-testid="voice-error-message"
        className="flex-1 min-w-0 whitespace-pre-wrap break-words"
      >
        {message}
      </span>
      <button
        type="button"
        data-testid="voice-error-retry"
        onClick={onRetry}
        className="text-nano px-2 py-1 rounded-pill bg-surface2 hairline ring-1 ring-border1 text-txt2 hover:bg-surface3 shrink-0"
        title="Reload the page to drop any leftover WASM memory and retry mic init."
      >
        retry
      </button>
    </div>
  );
}
