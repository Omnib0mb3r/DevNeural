/**
 * BUG-054, socket half: a typed message from the Lex page goes out on
 * the live voice WebSocket as one `text-input` frame, and the daemon's
 * answer frames render without an error pill or a spurious row.
 *
 * The real VoiceClient is mounted with a fake WebSocket. The page's
 * `sendTextInput` (lib/voice-text-input-bus) must:
 *   - return false while the socket is still CONNECTING (no frame);
 *   - return true once the socket is OPEN and send exactly one
 *     {t:'text-input', text} frame;
 *   - return false again after voice is torn down.
 * The daemon's echo ({t:'transcript', source:'text-input'}) must render
 * as one user row, and its {t:'injected'} / {t:'tts-skipped'} acks
 * must produce neither a row nor an error pill.
 *
 * The page-side routing (socket first, HTTP fallback) is pinned in
 * tests/lex-page-typed-submit.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/daemon-client")>();
  const { BRAINSTORM_PTY } = await import("./helpers/voice-client-fakes");
  return {
    ...orig,
    listPtys: vi.fn(async () => ({ ok: true, ptys: [BRAINSTORM_PTY] })),
    lexAnchors: vi.fn(async () => ({ ok: true, anchors: [] })),
  };
});
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
import { sendTextInput } from "../lib/voice-text-input-bus";
import { emitTranscriptTurn } from "@/lib/transcript-bus";
import {
  FakeWebSocket,
  VOICE_ENABLED_STORAGE_KEY,
  installPanelMount,
  installVoiceGlobals,
} from "./helpers/voice-client-fakes";

function renderEngine() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <VoiceClient />
    </QueryClientProvider>,
  );
}

async function mountWithSocket(): Promise<FakeWebSocket> {
  renderEngine();
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  return FakeWebSocket.instances[0]!;
}

/* The full voice panel (where the error pill renders) portals into the
 * /lex mount div; install it so "no error pill" is a real assertion. */
let panelMount: HTMLElement | null = null;

beforeEach(() => {
  installVoiceGlobals();
  FakeWebSocket.reset();
  panelMount = installPanelMount();
  window.sessionStorage.setItem(VOICE_ENABLED_STORAGE_KEY, "1");
});

afterEach(() => {
  cleanup();
  panelMount?.remove();
  panelMount = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  FakeWebSocket.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("typed text over the voice socket (BUG-054)", () => {
  it("positive control: a real error frame does render the error pill", async () => {
    const ws = await mountWithSocket();
    act(() => ws.open());
    act(() => ws.receive({ t: "error", code: "inject", message: "boom" }));
    expect(screen.getByTestId("voice-error-message").textContent).toBe("boom");
  });

  it("returns false and sends nothing while the socket is still connecting", async () => {
    const ws = await mountWithSocket();
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(sendTextInput("hello lex")).toBe(false);
    expect(ws.framesOf("text-input")).toHaveLength(0);
  });

  it("sends exactly one text-input frame on the open socket and returns true", async () => {
    const ws = await mountWithSocket();
    act(() => ws.open());
    expect(ws.framesOf("hello")).toHaveLength(1);

    expect(sendTextInput("hello lex")).toBe(true);
    const frames = ws.framesOf("text-input");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ t: "text-input", text: "hello lex" });
  });

  it("renders the daemon echo as one user row and swallows the injected / tts-skipped acks", async () => {
    const ws = await mountWithSocket();
    act(() => ws.open());
    expect(sendTextInput("hello lex")).toBe(true);

    act(() =>
      ws.receive({ t: "transcript", text: "hello lex", ms: 0, source: "text-input" }),
    );
    expect(emitTranscriptTurn).toHaveBeenCalledTimes(1);
    expect(emitTranscriptTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "user",
        text: "hello lex",
        id: expect.stringMatching(/^u-typed-/),
      }),
    );

    act(() => ws.receive({ t: "injected", source: "text-input" }));
    act(() => ws.receive({ t: "tts-skipped", reason: "text-input" }));
    expect(emitTranscriptTurn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("voice-error-message")).toBeNull();

    act(() =>
      ws.receive({
        t: "assistant-text",
        text: "hi there",
        turn_id: "turn-1",
        prompt_version: "v1",
      }),
    );
    expect(emitTranscriptTurn).toHaveBeenCalledTimes(2);
    expect(emitTranscriptTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "assistant", text: "hi there" }),
    );
    expect(screen.queryByTestId("voice-error-message")).toBeNull();
  });

  it("returns false again once voice is torn down", async () => {
    const ws = await mountWithSocket();
    act(() => ws.open());
    expect(sendTextInput("first")).toBe(true);
    cleanup();
    expect(sendTextInput("second")).toBe(false);
    expect(ws.framesOf("text-input")).toHaveLength(1);
  });
});
