"use client";

/**
 * Wave 2 day 2 step 11 (BF-11 / A4) audio player.
 *
 * Wraps the native <audio> element with the contract spec section 11
 * step 11 demands: iOS gesture rules honoured (no autoplay, the user
 * must tap Play first), default playback rate 0.9 (user preference),
 * cue-aware Skip-to-turn shortcuts when cues.json is loaded.
 *
 * The element points at /brainstorms/:id/audio which serves the WAV
 * with Range support so seeks work on iOS Safari (without Range, the
 * scrubber locks). cache-control:no-store on the daemon side keeps
 * the SW from caching audio per spec 5.7.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioCue } from "@/lib/daemon-client";

export interface AudioPlayerProps {
  src: string;
  cues?: AudioCue[];
  /** Default playback rate; spec calls for 0.9. */
  defaultRate?: number;
}

export function AudioPlayer({
  src,
  cues,
  defaultRate = 0.9,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [rate, setRate] = useState(defaultRate);
  const [activeCue, setActiveCue] = useState(-1);

  /* Apply the configured rate every time the element mounts or the
   * src changes; the native default is 1.0 and would otherwise
   * silently override our preference between sessions. */
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, src]);

  const cueList = useMemo(() => cues ?? [], [cues]);

  function jumpToCue(idx: number) {
    if (!audioRef.current) return;
    const cue = cueList[idx];
    if (!cue) return;
    audioRef.current.currentTime = cue.start_ms / 1000;
    /* iOS gesture rule: play() inside an event handler is allowed; we
     * call it explicitly so jump-to-cue both seeks and starts
     * playing, mirroring transcript-clicker behaviour. */
    audioRef.current.play().catch(() => {
      /* user-paused or device denied; not a hard error */
    });
  }

  function onTimeUpdate(e: React.SyntheticEvent<HTMLAudioElement>) {
    const t = e.currentTarget.currentTime * 1000;
    if (cueList.length === 0) return;
    let next = -1;
    for (let i = cueList.length - 1; i >= 0; i--) {
      const c = cueList[i];
      if (c && t >= c.start_ms) {
        next = i;
        break;
      }
    }
    if (next !== activeCue) setActiveCue(next);
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-border1 bg-surface1 p-3">
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={src}
        onTimeUpdate={onTimeUpdate}
        className="w-full"
      />
      <div className="flex items-center gap-2 text-xs text-txt3">
        <label htmlFor="audio-rate" className="font-mono">
          rate
        </label>
        <select
          id="audio-rate"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          className="rounded border border-border1 bg-surface2 px-1 py-0.5 font-mono text-xs"
        >
          <option value={0.75}>0.75x</option>
          <option value={0.9}>0.9x</option>
          <option value={1}>1x</option>
          <option value={1.25}>1.25x</option>
          <option value={1.5}>1.5x</option>
          <option value={2}>2x</option>
        </select>
        {cueList.length > 0 ? (
          <span className="ml-auto font-mono">
            {cueList.length} turn{cueList.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {cueList.length > 0 ? (
        <ol className="max-h-48 overflow-y-auto rounded border border-border1 bg-surface2 p-2 text-xs">
          {cueList.map((c, i) => {
            const sec = Math.floor(c.start_ms / 1000);
            const m = Math.floor(sec / 60);
            const s = String(sec % 60).padStart(2, "0");
            const isActive = i === activeCue;
            return (
              <li key={c.turn_index}>
                <button
                  type="button"
                  onClick={() => jumpToCue(i)}
                  className={`w-full text-left font-mono ${
                    isActive ? "text-brandSoft" : "text-txt2"
                  }`}
                >
                  {`#${i + 1}  ${m}:${s}`}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-xs text-txt3">cues.json not found; use the scrubber</p>
      )}
    </div>
  );
}
