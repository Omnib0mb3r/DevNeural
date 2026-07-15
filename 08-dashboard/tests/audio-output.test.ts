/**
 * Unit tests for lib/audio-output.ts (phone Bluetooth output routing).
 *
 * Every helper is pure or accepts its browser API surface as an
 * injectable parameter, so these tests drive every branch (feature
 * detect present/absent, enumerate success/failure, setSinkId
 * success/failure, persistence round-trip, the iOS audio-session
 * hint) without a real browser. The voice_settings_bus block at the
 * bottom pins that "audio_output_device" was added to the
 * VoiceSettingKey union additively: if the type were missing this
 * file would fail to compile, which is the "type-checks" coverage
 * called for alongside the runtime round-trip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_OUTPUT_STORAGE_KEY,
  applyAudioOutput,
  applyIosAudioSessionHint,
  getPersistedAudioOutputDevice,
  listAudioOutputs,
  setPersistedAudioOutputDevice,
  supportsSinkSelection,
} from "../lib/audio-output";
import {
  emitVoiceSettingUpdate,
  onVoiceSettingUpdate,
  type VoiceSettingUpdate,
} from "../lib/voice-settings-bus";

describe("supportsSinkSelection", () => {
  it("returns true when AudioContext.prototype.setSinkId exists", () => {
    class FakeCtxWithSink {
      setSinkId(): Promise<void> {
        return Promise.resolve();
      }
    }
    expect(
      supportsSinkSelection({
        AudioContextCtor: FakeCtxWithSink as unknown as typeof AudioContext,
      }),
    ).toBe(true);
  });

  it("returns false when setSinkId is absent from the prototype", () => {
    class FakeCtxNoSink {}
    expect(
      supportsSinkSelection({
        AudioContextCtor: FakeCtxNoSink as unknown as typeof AudioContext,
      }),
    ).toBe(false);
  });

  it("returns false when no constructor is available at all", () => {
    /* jsdom does not implement the Web Audio API, so window.AudioContext
     * is undefined and the default fallback exercises this path too. */
    expect(supportsSinkSelection({ AudioContextCtor: undefined })).toBe(
      false,
    );
  });
});

describe("listAudioOutputs", () => {
  it("filters to audiooutput devices and maps deviceId + label", async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" },
        { deviceId: "spk-1", kind: "audiooutput", label: "Speakers" },
        { deviceId: "spk-2", kind: "audiooutput", label: "" },
      ] as MediaDeviceInfo[]),
    };
    const result = await listAudioOutputs({ mediaDevices });
    expect(result).toEqual([
      { deviceId: "spk-1", label: "Speakers" },
      { deviceId: "spk-2", label: "Output 2" },
    ]);
  });

  it("returns an empty array when enumerateDevices rejects", async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    };
    expect(await listAudioOutputs({ mediaDevices })).toEqual([]);
  });

  it("returns an empty array when mediaDevices is unavailable", async () => {
    expect(await listAudioOutputs({ mediaDevices: undefined })).toEqual([]);
  });
});

describe("applyAudioOutput", () => {
  it("fails with no-audio-context when ctx is null or undefined", async () => {
    expect(await applyAudioOutput(null, "device-1")).toEqual({
      ok: false,
      error: "no-audio-context",
    });
    expect(await applyAudioOutput(undefined, "device-1")).toEqual({
      ok: false,
      error: "no-audio-context",
    });
  });

  it("fails with sink-selection-unsupported when setSinkId is not a function", async () => {
    const ctx = {} as unknown as AudioContext;
    expect(await applyAudioOutput(ctx, "device-1")).toEqual({
      ok: false,
      error: "sink-selection-unsupported",
    });
  });

  it("resolves ok:true and forwards the deviceId when setSinkId succeeds", async () => {
    const setSinkId = vi.fn(async () => undefined);
    const ctx = { setSinkId } as unknown as AudioContext;
    const result = await applyAudioOutput(ctx, "device-1");
    expect(result).toEqual({ ok: true });
    expect(setSinkId).toHaveBeenCalledWith("device-1");
  });

  it("catches a rejecting setSinkId and returns the Error message", async () => {
    const ctx = {
      setSinkId: vi.fn(async () => {
        throw new Error("NotFoundError: requested device unavailable");
      }),
    } as unknown as AudioContext;
    const result = await applyAudioOutput(ctx, "device-1");
    expect(result).toEqual({
      ok: false,
      error: "NotFoundError: requested device unavailable",
    });
  });

  it("stringifies a non-Error rejection reason", async () => {
    const ctx = {
      setSinkId: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw-string-reason";
      }),
    } as unknown as AudioContext;
    const result = await applyAudioOutput(ctx, "device-1");
    expect(result).toEqual({ ok: false, error: "raw-string-reason" });
  });
});

describe("persisted audio output device", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing has been persisted", () => {
    expect(getPersistedAudioOutputDevice()).toBeNull();
  });

  it("round-trips a stored deviceId through localStorage", () => {
    setPersistedAudioOutputDevice("device-42");
    expect(getPersistedAudioOutputDevice()).toBe("device-42");
    expect(window.localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY)).toBe(
      "device-42",
    );
  });

  it("clears the stored value when passed null", () => {
    setPersistedAudioOutputDevice("device-42");
    setPersistedAudioOutputDevice(null);
    expect(getPersistedAudioOutputDevice()).toBeNull();
    expect(window.localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY)).toBeNull();
  });
});

describe("applyIosAudioSessionHint", () => {
  it("no-ops without throwing when navigator.audioSession is absent", () => {
    const fakeNav = {} as Navigator;
    expect(() => applyIosAudioSessionHint(fakeNav)).not.toThrow();
  });

  it("no-ops without throwing when navigator itself is undefined", () => {
    expect(() => applyIosAudioSessionHint(undefined)).not.toThrow();
  });

  it("sets audioSession.type to play-and-record when present", () => {
    const fakeNav = {
      audioSession: { type: "auto" },
    } as unknown as Navigator;
    applyIosAudioSessionHint(fakeNav);
    expect(fakeNav.audioSession!.type).toBe("play-and-record");
  });

  it("swallows an exception thrown by the audioSession.type setter", () => {
    const audioSessionObj = { type: "auto" };
    Object.defineProperty(audioSessionObj, "type", {
      get: () => "auto",
      set: () => {
        throw new Error("iOS rejected the session category");
      },
    });
    const fakeNav = {
      audioSession: audioSessionObj,
    } as unknown as Navigator;
    expect(() => applyIosAudioSessionHint(fakeNav)).not.toThrow();
  });
});

describe("voice-settings-bus audio_output_device key", () => {
  it("round-trips the new key through emit/on (additive union type-check)", () => {
    const received: VoiceSettingUpdate[] = [];
    const unsubscribe = onVoiceSettingUpdate((u) => {
      received.push(u);
    });
    emitVoiceSettingUpdate({ key: "audio_output_device", value: "device-9" });
    unsubscribe();
    expect(received).toEqual([
      { key: "audio_output_device", value: "device-9" },
    ]);
  });
});
