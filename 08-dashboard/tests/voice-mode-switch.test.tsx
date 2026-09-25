/**
 * BUG-053: a voice mode switch (conversation / notes / push-to-talk)
 * is a live change on the open socket, not a teardown.
 *
 * The real VoiceClient is mounted with a fake WebSocket, fake media
 * devices / AudioContext and a mocked silero VAD. Pinned:
 *   (a) a mode change keeps the same WebSocket instance (no close, no
 *       new socket, no second hello), sends exactly one set-mode frame
 *       on it, and is not locked behind the brain-ready gate (it works
 *       while the status is still "warming"); only the capture path
 *       is rebuilt (old VAD destroyed, new one created).
 *   (b) a mode change while hard-muted hands the new capture path a
 *       stream whose tracks are disabled, the same state setMicMuted
 *       leaves a live stream in; unmute re-enables the new tracks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => {
  const vads: Array<{
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setOptions: ReturnType<typeof vi.fn>;
  }> = [];
  const micVadNew = vi.fn(async () => {
    const v = {
      start: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
      setOptions: vi.fn(),
    };
    vads.push(v);
    return v;
  });
  return { vads, micVadNew };
});

vi.mock("@/lib/daemon-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/daemon-client")>();
  const { BRAINSTORM_PTY } = await import("./helpers/voice-client-fakes");
  return {
    ...orig,
    listPtys: vi.fn(async () => ({ ok: true, ptys: [BRAINSTORM_PTY] })),
    lexAnchors: vi.fn(async () => ({ ok: true, anchors: [] })),
  };
});
vi.mock("@/lib/voice-ort-config", () => ({
  getVadModule: vi.fn(async () => ({ MicVAD: { new: h.micVadNew } })),
  resetVadModuleCache: vi.fn(),
}));
vi.mock("@/lib/transcript-bus", () => ({
  emitTranscriptTurn: vi.fn(),
  emitTranscriptClear: vi.fn(),
  emitTranscriptStatus: vi.fn(),
  onTranscriptTurn: () => () => undefined,
  onTranscriptStatus: () => () => undefined,
  onTranscriptClear: () => () => undefined,
}));
vi.mock("@/lib/voice-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-log")>()),
  logVoice: vi.fn(),
}));
vi.mock("@/lib/voice-watchdog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-watchdog")>()),
  postVoiceHealth: vi.fn(async () => undefined),
}));

import { VoiceClient } from "../components/VoiceClient";
import {
  BRAINSTORM_PTY,
  FakeWebSocket,
  VOICE_ENABLED_STORAGE_KEY,
  installFakeMediaDevices,
  installPanelMount,
  installVoiceGlobals,
  removeFakeMediaDevices,
  type FakeMediaDevices,
} from "./helpers/voice-client-fakes";

let media: FakeMediaDevices;
let panelMount: HTMLElement | null = null;

function renderEngine() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  /* Seed the PTY / anchor queries so the Lex PTY is resolved on the
   * first render. Otherwise the socket opens before listPtys lands and
   * the (correct, pre-existing) rebind effect re-hellos once the PTY
   * resolves, which would blur the "no hello on a mode change" pin. */
  qc.setQueryData(["pty-list"], { ok: true, ptys: [BRAINSTORM_PTY] });
  qc.setQueryData(["lex-anchors", "live"], { ok: true, anchors: [] });
  return render(
    <QueryClientProvider client={qc}>
      <VoiceClient />
    </QueryClientProvider>,
  );
}

/* Mount, open the socket, ack the hello, and wait for the conversation
 * mode capture path (one getUserMedia + one MicVAD.new) to be up. */
async function mountAcked(): Promise<FakeWebSocket> {
  renderEngine();
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const ws = FakeWebSocket.instances[0]!;
  act(() => ws.open());
  expect(ws.framesOf("hello")).toHaveLength(1);
  act(() => ws.receive({ t: "hello-ack", voice_rate: 22050 }));
  await waitFor(() => expect(h.micVadNew).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(1));
  return ws;
}

function modeButton(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

beforeEach(() => {
  installVoiceGlobals();
  media = installFakeMediaDevices();
  FakeWebSocket.reset();
  h.vads.length = 0;
  h.micVadNew.mockClear();
  panelMount = installPanelMount();
  window.sessionStorage.setItem(VOICE_ENABLED_STORAGE_KEY, "1");
});

afterEach(() => {
  cleanup();
  panelMount?.remove();
  panelMount = null;
  removeFakeMediaDevices();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  FakeWebSocket.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("voice mode switch (BUG-053)", () => {
  it("keeps the socket, sends one set-mode frame, and rebuilds only the capture path", async () => {
    const ws = await mountAcked();
    /* No voice-brain frame yet: status is "warming". The old code
     * locked the mode buttons here; the switch must go through. */
    expect(screen.getByText("warming")).toBeTruthy();
    expect(modeButton("push-to-talk").disabled).toBe(false);
    const hellosBefore = ws.framesOf("hello").length;
    expect(hellosBefore).toBe(1);

    fireEvent.click(modeButton("push-to-talk"));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.closeCalls).toBe(0);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(ws.framesOf("hello")).toHaveLength(hellosBefore);
    /* The meeting toggle rides the frame now that no hello follows a
     * switch; outside notes mode it is always "brainstorm". */
    expect(ws.framesOf("set-mode")).toEqual([
      { t: "set-mode", mode: "push-to-talk", kind: "brainstorm" },
    ]);
    expect(screen.queryByText("connecting")).toBeNull();

    /* Old VAD destroyed, push-to-talk capture opened its own stream. */
    expect(h.vads[0]!.destroy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(2));
    expect(h.micVadNew).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "hold to talk" })).toBeTruthy();

    /* Brain readiness still lands on the same socket afterwards. */
    act(() => ws.receive({ t: "voice-brain", ready: true }));
    expect(screen.getByText("ready")).toBeTruthy();

    /* And back: a fresh VAD on the same socket, one more set-mode. */
    fireEvent.click(modeButton("conversation"));
    await waitFor(() => expect(h.micVadNew).toHaveBeenCalledTimes(2));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.closeCalls).toBe(0);
    expect(ws.framesOf("hello")).toHaveLength(hellosBefore);
    expect(ws.framesOf("set-mode").map((f) => f.mode)).toEqual([
      "push-to-talk",
      "conversation",
    ]);
    expect(screen.getByText("ready")).toBeTruthy();
  });

  it("a mode change while muted leaves the new capture tracks disabled", async () => {
    await mountAcked();
    const first = media.streams[0]!;
    expect(first.tracks.every((t) => t.enabled)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "mute" }));
    expect(first.tracks.every((t) => !t.enabled)).toBe(true);

    /* notes mode also runs the VAD over the parallel-capture rig, so it
     * opens a fresh getUserMedia stream. */
    fireEvent.click(modeButton("notes only"));
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.micVadNew).toHaveBeenCalledTimes(2));
    const second = media.streams[1]!;
    expect(second).not.toBe(first);
    expect(second.tracks.length).toBeGreaterThan(0);
    expect(second.tracks.every((t) => !t.enabled)).toBe(true);
    /* The old stream was stopped by the capture teardown. */
    expect(first.tracks.every((t) => (t.stop as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);

    /* Unmute now re-enables the tracks of the NEW stream. */
    fireEvent.click(screen.getByRole("button", { name: "muted" }));
    expect(second.tracks.every((t) => t.enabled)).toBe(true);
  });
});
