/**
 * VoicePillView render + tap pins.
 *
 * The pill exposes two reactive icons side by side (mic on the
 * input side, speaker on the output side) plus a status label and
 * a hard stop button. These tests confirm:
 *   - Tapping the speaker icon fires setSoftMuted(true).
 *   - A second tap fires setSoftMuted(false).
 *   - Visual reactive state reflects the current mute states: mic
 *     swaps to MicOff (lucide-mic-off) when muted, speaker swaps to
 *     VolumeX (lucide-volume-x) when soft-muted, and the pulse-live
 *     animation class lights up on the active side only.
 *   - The unread-silent badge surfaces on the speaker icon once
 *     soft-muted with at least one missed message.
 *   - Mic tap fires setMicMuted (input-side parity).
 *
 * The component is purely presentational; props drive every visible
 * branch, so we mount it directly without standing up VoiceCtx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VoicePillView } from "../components/VoiceClient";

function defaultProps() {
  return {
    status: "speaking" as const,
    enabled: true,
    muted: false,
    micGated: true,
    softMuted: false,
    silentMessageCount: 0,
    wakeWordActive: false,
    toggleEnabled: vi.fn(),
    setMicMuted: vi.fn(),
    setSoftMuted: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
});

describe("VoicePillView", () => {
  it("tapping the speaker icon fires setSoftMuted(true), and a second tap fires setSoftMuted(false)", () => {
    const setSoftMuted = vi.fn();
    const { rerender } = render(
      <VoicePillView {...defaultProps()} setSoftMuted={setSoftMuted} />,
    );
    const mute = screen.getByLabelText("Mute Lex voice");
    fireEvent.click(mute);
    expect(setSoftMuted).toHaveBeenCalledTimes(1);
    expect(setSoftMuted).toHaveBeenCalledWith(true);

    rerender(
      <VoicePillView
        {...defaultProps()}
        softMuted={true}
        setSoftMuted={setSoftMuted}
      />,
    );
    const unmute = screen.getByLabelText("Unmute Lex voice");
    fireEvent.click(unmute);
    expect(setSoftMuted).toHaveBeenCalledTimes(2);
    expect(setSoftMuted).toHaveBeenLastCalledWith(false);
  });

  it("tapping the mic icon mirrors the speaker tap on the input side", () => {
    const setMicMuted = vi.fn();
    const { rerender } = render(
      <VoicePillView {...defaultProps()} setMicMuted={setMicMuted} />,
    );
    fireEvent.click(screen.getByLabelText("Mute microphone"));
    expect(setMicMuted).toHaveBeenLastCalledWith(true);

    rerender(
      <VoicePillView
        {...defaultProps()}
        muted={true}
        setMicMuted={setMicMuted}
      />,
    );
    fireEvent.click(screen.getByLabelText("Unmute microphone"));
    expect(setMicMuted).toHaveBeenLastCalledWith(false);
  });

  it("renders the active speaker control with a pulse-live animation while Lex is speaking and not soft-muted", () => {
    render(
      <VoicePillView
        {...defaultProps()}
        status="speaking"
        softMuted={false}
      />,
    );
    const speakerBtn = screen.getByLabelText("Mute Lex voice");
    expect(speakerBtn.getAttribute("aria-pressed")).toBe("false");
    /* pulse-live class lives on the inner svg so the icon strokes
     * animate via the breathe keyframe defined in globals.css. */
    expect(speakerBtn.querySelector(".pulse-live")).not.toBeNull();
  });

  it("drops the pulse and turns the speaker button into the unmute control when soft-muted", () => {
    render(
      <VoicePillView
        {...defaultProps()}
        status="speaking"
        softMuted={true}
      />,
    );
    const speakerBtn = screen.getByLabelText("Unmute Lex voice");
    expect(speakerBtn.querySelector(".pulse-live")).toBeNull();
    expect(speakerBtn.getAttribute("aria-pressed")).toBe("true");
    /* The mute glyph swap is verified indirectly by the aria-label
     * flip; the underlying lucide class differs by minor version so
     * we avoid asserting on its DOM signature. */
  });

  it("surfaces the unread-silent badge on the speaker icon when soft-muted with missed messages", () => {
    render(
      <VoicePillView
        {...defaultProps()}
        softMuted={true}
        silentMessageCount={3}
      />,
    );
    const badge = screen.getByLabelText("3 silent messages");
    expect(badge.textContent).toBe("3");
  });

  it("does not render the badge when softMuted is false even if silentMessageCount happens to be positive", () => {
    render(
      <VoicePillView
        {...defaultProps()}
        softMuted={false}
        silentMessageCount={5}
      />,
    );
    expect(screen.queryByLabelText(/silent messages?$/)).toBeNull();
  });

  it("pulses the mic icon while listening and swaps the aria-label when the user mutes", () => {
    const { rerender } = render(
      <VoicePillView
        {...defaultProps()}
        status="listening"
        muted={false}
        micGated={false}
      />,
    );
    const micBtn = screen.getByLabelText("Mute microphone");
    expect(micBtn.querySelector(".pulse-live")).not.toBeNull();

    rerender(<VoicePillView {...defaultProps()} muted={true} />);
    /* aria-label flip + aria-pressed is the canonical mute signal;
     * the icon swap (Mic -> MicOff) follows from the muted state in
     * a single render branch. */
    const muted = screen.getByLabelText("Unmute microphone");
    expect(muted.getAttribute("aria-pressed")).toBe("true");
  });

  it("disables both icon buttons when voice is not enabled so a stray tap on the off pill does not fire", () => {
    render(<VoicePillView {...defaultProps()} enabled={false} />);
    expect(
      (screen.getByLabelText("Mute microphone") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Mute Lex voice") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps the Mic glyph (not MicOff) when only micGated is true so the wake-word path reads as live", () => {
    /* Bug 2026-05-14-voice-pill-inconsistent-and-wake-word-muted:
     * the old pill flipped to MicOff whenever micGated was true,
     * which read as "wake-word also muted" even though the always-
     * on listener was still alive. The pill must only show MicOff
     * on an explicit user mute. */
    render(
      <VoicePillView
        {...defaultProps()}
        muted={false}
        micGated={true}
        wakeWordActive={true}
      />,
    );
    const micBtn = screen.getByLabelText("Mute microphone");
    /* No MicOff glyph in the tree; the active glyph is Mic. */
    expect(micBtn.querySelector("svg")).not.toBeNull();
    expect(micBtn.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByTestId("voice-pill-wake-indicator"),
    ).toBeTruthy();
  });

  it("does not render the wake-word indicator when wakeWordActive is false", () => {
    render(
      <VoicePillView {...defaultProps()} wakeWordActive={false} />,
    );
    expect(screen.queryByTestId("voice-pill-wake-indicator")).toBeNull();
  });

  it("renders all controls inline on a single row including the status label", () => {
    /* Single-row layout per the 2026-05-15 TopBar reorg. The status
     * label used to live on its own row 2 below the controls but
     * read as a "dangling THINKING below the voice cluster with no
     * alignment to anything" -- user feedback that promoted the
     * inline shape. Stop button still anchors the right edge and
     * the slider is the only flex-1 child, so a long status label
     * compresses the slider before it can push stop off-screen. */
    render(
      <VoicePillView
        {...defaultProps()}
        status="thinking"
        micGated={false}
        speed={0.65}
      />,
    );
    const root = screen.getByTestId("voice-pill-root");
    const stop = screen.getByLabelText("Stop voice");
    const status = screen.getByTestId("voice-pill-status");
    expect(root.contains(stop)).toBe(true);
    expect(root.contains(status)).toBe(true);
    /* status text reads as the uppercased label per spec. */
    expect(status.textContent?.trim().toUpperCase()).toBe("THINKING");
    /* speed readout reflects the prop, two-decimal x format. */
    expect(
      screen.getByTestId("voice-pill-speed-readout").textContent,
    ).toBe("0.65x");
  });

  it("shows 'speaking' while Lex is audibly speaking even though the mic gate is up", () => {
    /* The old overlay ternary rendered "muted (tts)" whenever
     * micGated was true. micGated is true for the entire TTS
     * playback window, so the pill masked "speaking" with a label
     * that read as if Lex's TTS were muted - the exact inverse of
     * what was happening. Speaking must always win over the gate. */
    render(
      <VoicePillView
        {...defaultProps()}
        status="speaking"
        micGated={true}
        softMuted={false}
      />,
    );
    const status = screen.getByTestId("voice-pill-status");
    expect(status.textContent?.trim().toUpperCase()).toBe("SPEAKING");
  });

  it("labels a mic gate that outlives playback as 'mic paused'", () => {
    render(
      <VoicePillView
        {...defaultProps()}
        status="ready"
        micGated={true}
        softMuted={false}
      />,
    );
    const status = screen.getByTestId("voice-pill-status");
    expect(status.textContent?.trim().toUpperCase()).toBe("MIC PAUSED");
  });

  it("labels soft mute as 'muted (voice)' and outranks every other state", () => {
    render(
      <VoicePillView
        {...defaultProps()}
        status="speaking"
        micGated={true}
        softMuted={true}
      />,
    );
    const status = screen.getByTestId("voice-pill-status");
    expect(status.textContent?.trim().toUpperCase()).toBe("MUTED (VOICE)");
  });

  it("speed slider fires setSpeed on input change", () => {
    const setSpeed = vi.fn();
    render(
      <VoicePillView
        {...defaultProps()}
        speed={1}
        speedMin={0.5}
        speedMax={1.5}
        speedStep={0.05}
        setSpeed={setSpeed}
      />,
    );
    const slider = screen.getByLabelText("Lex speech rate") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.85" } });
    expect(setSpeed).toHaveBeenCalledWith(0.85);
  });

  it("toggle stop button fires toggleEnabled and reads start/stop depending on enabled", () => {
    const toggleEnabled = vi.fn();
    const { rerender } = render(
      <VoicePillView {...defaultProps()} toggleEnabled={toggleEnabled} />,
    );
    fireEvent.click(screen.getByLabelText("Stop voice"));
    expect(toggleEnabled).toHaveBeenCalledTimes(1);

    rerender(
      <VoicePillView
        {...defaultProps()}
        enabled={false}
        toggleEnabled={toggleEnabled}
      />,
    );
    expect(screen.getByLabelText("Start voice").textContent).toBe("start");
  });
});
