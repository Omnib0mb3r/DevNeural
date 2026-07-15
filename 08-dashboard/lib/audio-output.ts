/**
 * Phone Bluetooth output routing.
 *
 * TTS plays through AudioBufferSourceNodes scheduled into
 * ctx.destination (see VoiceClient.tsx schedulePcmChunk). By default
 * that destination is whatever the OS/browser currently treats as the
 * "communication" output, which is not always the paired Bluetooth
 * headset a phone user actually wants: the mic capture path holds
 * getUserMedia open for the whole session with echoCancellation:true,
 * which pins the OS into communication-mode routing and can exclude
 * A2DP (the high-quality Bluetooth audio profile) in favor of the
 * narrowband HFP profile, or route to the earpiece speaker entirely.
 *
 * Two independent levers exist, and this module wraps both:
 *
 *  1. AudioContext.setSinkId(deviceId) -- explicit output-device
 *     selection. Supported on desktop Chrome and Chrome Android 110+.
 *     NOT supported on Safari/iOS or Firefox (Firefox instead offers
 *     a user-facing selectAudioOutput() picker prompt, out of scope
 *     here). supportsSinkSelection() feature-detects this so callers
 *     can degrade gracefully instead of calling into a method that
 *     does not exist.
 *
 *  2. navigator.audioSession.type = "play-and-record" -- the WebKit /
 *     iOS 16.4+ Audio Session API. iOS exposes no device picker or
 *     setSinkId equivalent to web content at all; this is a hint, not
 *     a selection. Setting the session category to the same one a
 *     phone/voice app would use nudges the OS's own routing decision
 *     (which the user still ultimately controls via Control Center /
 *     the system Bluetooth menu) without pretending the page can pick
 *     a device. There is no way to force iOS output routing from a
 *     web page; that is a platform hard limit, not a gap in this file.
 *
 * Every helper here is a pure function or accepts its browser API
 * surface as an injectable parameter (mirroring lib/voice-audio-warm.ts)
 * so the unit tests can drive every branch without a real browser.
 */

export const AUDIO_OUTPUT_STORAGE_KEY = "lex-audio-output-device";

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

export interface ApplyAudioOutputResult {
  ok: boolean;
  error?: string;
}

/**
 * AudioContext.setSinkId is not yet in TypeScript's lib.dom.d.ts.
 * This interface exists purely to type the feature-detect and call
 * site without leaking `any` into callers.
 */
interface AudioContextWithSinkId {
  setSinkId(sinkId: string): Promise<void>;
}

export interface SupportsSinkSelectionOptions {
  /** Injectable for tests; defaults to the global AudioContext. */
  AudioContextCtor?: typeof AudioContext;
}

/** Feature-detect AudioContext.prototype.setSinkId. Does not touch a
 * live context; safe to call before any AudioContext exists. */
export function supportsSinkSelection(
  opts: SupportsSinkSelectionOptions = {},
): boolean {
  const Ctor =
    opts.AudioContextCtor ??
    (typeof window !== "undefined" ? window.AudioContext : undefined);
  if (!Ctor || !Ctor.prototype) return false;
  const proto = Ctor.prototype as unknown as Partial<AudioContextWithSinkId>;
  return typeof proto.setSinkId === "function";
}

export interface ListAudioOutputsOptions {
  /** Injectable for tests; defaults to navigator.mediaDevices. */
  mediaDevices?: Pick<MediaDevices, "enumerateDevices">;
}

/** List available audio-output devices. Labels are only populated by
 * the browser once a media permission has been granted on the origin;
 * voice mode always holds an open getUserMedia grant by the time this
 * is called from the live session, so labels are expected to be
 * present in practice. Returns an empty array (never throws) when
 * enumerateDevices is unavailable or rejects. */
export async function listAudioOutputs(
  opts: ListAudioOutputsOptions = {},
): Promise<AudioOutputDevice[]> {
  const md =
    opts.mediaDevices ??
    (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
  if (!md || typeof md.enumerateDevices !== "function") return [];
  try {
    const devices = await md.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audiooutput")
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Output ${i + 1}`,
      }));
  } catch {
    return [];
  }
}

/** Apply a chosen output device to a live AudioContext via setSinkId.
 * Pass deviceId "" to reset to the platform default sink. Never
 * throws; callers get an ok/error result so they can log the outcome
 * instead of needing a try/catch at every call site. */
export async function applyAudioOutput(
  ctx: AudioContext | null | undefined,
  deviceId: string,
): Promise<ApplyAudioOutputResult> {
  if (!ctx) return { ok: false, error: "no-audio-context" };
  const withSink = ctx as unknown as Partial<AudioContextWithSinkId>;
  if (typeof withSink.setSinkId !== "function") {
    return { ok: false, error: "sink-selection-unsupported" };
  }
  try {
    await withSink.setSinkId(deviceId);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read the persisted output-device choice. Null when unset, when
 * running outside a browser, or when localStorage throws (private
 * browsing / storage disabled). */
export function getPersistedAudioOutputDevice(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist (or clear, with null) the chosen output device. Swallows
 * localStorage failures; the picker still works live for the current
 * tab even if the choice does not survive reload. */
export function setPersistedAudioOutputDevice(deviceId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (deviceId) {
      window.localStorage.setItem(AUDIO_OUTPUT_STORAGE_KEY, deviceId);
    } else {
      window.localStorage.removeItem(AUDIO_OUTPUT_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

/**
 * WebKit / iOS 16.4+ Audio Session API. Not yet in TypeScript's
 * lib.dom.d.ts, so it is declared narrowly here (not `any`) and
 * merged onto the ambient Navigator type so every call site in the
 * dashboard gets a real type instead of a cast.
 */
interface AudioSessionLike {
  type: string;
}

declare global {
  interface Navigator {
    audioSession?: AudioSessionLike;
  }
}

/** Set the iOS Audio Session category to "play-and-record", the same
 * category a phone/voice app uses. This is a hint to the OS's own
 * routing decision, not a device selection: iOS gives web content no
 * API to force output to a specific device. No-ops (does not throw)
 * when navigator.audioSession is unavailable, i.e. every non-WebKit
 * browser and pre-16.4 Safari. Accepts an injectable navigator-like
 * object for tests; defaults to the global navigator. */
export function applyIosAudioSessionHint(
  nav: Navigator | undefined = typeof navigator !== "undefined"
    ? navigator
    : undefined,
): void {
  if (!nav || !("audioSession" in nav) || !nav.audioSession) return;
  try {
    nav.audioSession.type = "play-and-record";
  } catch {
    /* iOS may reject the category depending on session state;
     * non-fatal, playback continues on whatever routing was active */
  }
}
