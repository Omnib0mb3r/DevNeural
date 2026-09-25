/**
 * BUG-054, page half: the "Talk to Lex" box on /lex routes a typed
 * message to the live voice socket first and only falls back to the
 * HTTP inject when no socket is open.
 *
 *   (a) sendTextInput returns true -> no ptyInject call, no user row
 *       emitted by the page (the daemon echoes it), box cleared.
 *   (b) sendTextInput returns false -> ptyInject(sessionId, text, true)
 *       exactly as before, and the page emits the user row itself once
 *       the POST succeeds.
 *
 * The bus and the daemon client are mocked; the heavy children of the
 * page (terminal mirror, session list, artifacts, transcript panel,
 * app shell) are stubbed out so the test only stands up the compose
 * box. The socket-side send is pinned in tests/voice-text-input.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/daemon-client")>();
  const { BRAINSTORM_PTY } = await import("./helpers/voice-client-fakes");
  return {
    ...orig,
    listPtys: vi.fn(async () => ({ ok: true, ptys: [BRAINSTORM_PTY] })),
    lexAnchors: vi.fn(async () => ({ ok: true, anchors: [] })),
    listProjectAnchorTiles: vi.fn(async () => ({ ok: true, tiles: [] })),
    ptyInject: vi.fn(async () => ({ ok: true })),
    uploadScreenshot: vi.fn(async () => ({ ok: false, error: "unused" })),
    createLexAnchor: vi.fn(async () => ({ ok: true })),
    endLexAnchor: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock("@/lib/voice-text-input-bus", () => ({
  sendTextInput: vi.fn(() => false),
}));
vi.mock("@/lib/transcript-bus", () => ({
  emitTranscriptTurn: vi.fn(),
  emitTranscriptClear: vi.fn(),
  emitTranscriptStatus: vi.fn(),
  onTranscriptTurn: () => () => undefined,
  onTranscriptStatus: () => () => undefined,
  onTranscriptClear: () => () => undefined,
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/TerminalMirror", () => ({
  TerminalMirror: () => null,
}));
vi.mock("@/components/LexSessionList", () => ({
  LexSessionList: () => null,
}));
vi.mock("@/components/LexArtifactsPanel", () => ({
  LexArtifactsPanel: () => null,
}));
vi.mock("@/components/LexTranscriptHistoryPanel", () => ({
  LexTranscriptHistoryPanel: () => null,
}));

import LexPage from "../app/lex/page";
import { ptyInject } from "@/lib/daemon-client";
import { sendTextInput } from "@/lib/voice-text-input-bus";
import { emitTranscriptTurn } from "@/lib/transcript-bus";
import { BRAINSTORM_PTY } from "./helpers/voice-client-fakes";

const PLACEHOLDER =
  "What's on your mind? (Ctrl+Enter to send, paste a screenshot to attach)";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LexPage />
    </QueryClientProvider>,
  );
}

async function typeIntoBox(text: string): Promise<HTMLTextAreaElement> {
  const box = (await screen.findByPlaceholderText(
    PLACEHOLDER,
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(box).not.toBeDisabled());
  fireEvent.change(box, { target: { value: text } });
  return box;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/lex");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Lex page typed submit (BUG-054)", () => {
  it("sends over the voice socket and skips the HTTP inject and the local user row", async () => {
    vi.mocked(sendTextInput).mockReturnValue(true);
    renderPage();
    const box = await typeIntoBox("hello lex");
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    expect(sendTextInput).toHaveBeenCalledTimes(1);
    expect(sendTextInput).toHaveBeenCalledWith("hello lex");
    expect(ptyInject).not.toHaveBeenCalled();
    expect(emitTranscriptTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("falls back to the HTTP inject and emits the user row when no socket is open", async () => {
    vi.mocked(sendTextInput).mockReturnValue(false);
    renderPage();
    const box = await typeIntoBox("hello lex");
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    expect(sendTextInput).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ptyInject).toHaveBeenCalledTimes(1));
    expect(ptyInject).toHaveBeenCalledWith(
      BRAINSTORM_PTY.sessionId,
      "hello lex",
      true,
    );
    await waitFor(() => expect(emitTranscriptTurn).toHaveBeenCalledTimes(1));
    expect(emitTranscriptTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        text: "hello lex",
        id: expect.stringMatching(/^u-typed-/),
      }),
    );
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("routes Ctrl+Enter through the same socket-first path", async () => {
    vi.mocked(sendTextInput).mockReturnValue(true);
    renderPage();
    const box = await typeIntoBox("ctrl enter");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });

    expect(sendTextInput).toHaveBeenCalledTimes(1);
    expect(sendTextInput).toHaveBeenCalledWith("ctrl enter");
    expect(ptyInject).not.toHaveBeenCalled();
    await waitFor(() => expect(box.value).toBe(""));
  });
});
