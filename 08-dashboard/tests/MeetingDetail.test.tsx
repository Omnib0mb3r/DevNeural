/**
 * MeetingDetail render tests (meeting-notes fixes 2026-07, tasks 3 + 4).
 *
 * Covers:
 *   1. Transcript renders brainstorm_chunks in order (task 3 / F3),
 *      ported from BrainstormDetail's chunk-rendering block; meetings
 *      and brainstorms share the same table + endpoint.
 *   2. The attendees/topic edit form seeds from the fetched meeting
 *      and submits patchMeeting with the trimmed values, sending null
 *      for a blanked field (task 4 / F4).
 *
 * Daemon-client is mocked so the test does not need a fastify dev
 * server; react-query is wrapped in a fresh QueryClientProvider per
 * test, matching LexSessionList.test.tsx's harness.
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

vi.mock("@/lib/daemon-client", () => ({
  getMeeting: vi.fn(),
  getBrainstormChunksApi: vi.fn(),
  consentAckMeeting: vi.fn().mockResolvedValue({ ok: true }),
  setMeetingKeepAudio: vi.fn().mockResolvedValue({ ok: true }),
  addMeetingActionItem: vi.fn().mockResolvedValue({ ok: true, action_items: [] }),
  updateMeetingActionItem: vi.fn().mockResolvedValue({ ok: true }),
  promoteMeetingToWiki: vi.fn().mockResolvedValue({ ok: true }),
  patchMeeting: vi.fn().mockResolvedValue({ ok: true }),
}));

import { MeetingDetail } from "../components/MeetingDetail";
import {
  getMeeting,
  getBrainstormChunksApi,
  patchMeeting,
} from "@/lib/daemon-client";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const MEETING_ID = "meeting-1";

function baseMeeting() {
  return {
    ok: true as const,
    meeting: {
      id: MEETING_ID,
      claude_session_id: null,
      pty_id: null,
      cwd: "/tmp",
      user_label: "weekly sync",
      derived_label: null,
      mode: "notes",
      status: "ended",
      started_ms: 1_700_000_000_000,
      ended_ms: 1_700_000_060_000,
      turn_count: 2,
      topic_tags_json: "[]",
      artifacts_json: "{}",
      last_summary: null,
      last_summary_ms: null,
      consent_acked: 1,
      consent_acked_at: "2026-07-14T10:00:00.000Z",
      consent_acked_by: "user",
      keep_audio: 0,
      attendees: "alice, bob",
      meeting_topic: "roadmap review",
      kind: "meeting" as const,
    },
    action_items: [],
    audio_purges_at: null,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  (getMeeting as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    baseMeeting(),
  );
  (getBrainstormChunksApi as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    {
      ok: true,
      chunks: [
        {
          id: "c2",
          brainstorm_id: MEETING_ID,
          turn_index: 1,
          role: "lex",
          mode: "notes",
          text: "second turn",
          model_id: "claude",
          no_decay: 1,
          created_at: "2026-07-14T10:00:05.000Z",
        },
        {
          id: "c1",
          brainstorm_id: MEETING_ID,
          turn_index: 0,
          role: "user",
          mode: "notes",
          text: "first turn",
          model_id: "",
          no_decay: 0,
          created_at: "2026-07-14T10:00:00.000Z",
        },
      ],
      total: 2,
    },
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("MeetingDetail - transcript (task 3 / F3)", () => {
  it("renders chunks with newest at the bottom (server returns desc, component reverses to chronological)", async () => {
    renderWithQuery(<MeetingDetail id={MEETING_ID} />);
    await waitFor(() => {
      expect(screen.getByText("first turn")).toBeInTheDocument();
    });
    expect(screen.getByText("second turn")).toBeInTheDocument();
    /* getBrainstormChunksApi is called with order: 'desc'; the
     * component itself reverses to chronological for display. The
     * mock above returns [second, first] (desc); confirm the DOM
     * order is [first, second] (chronological, newest last). */
    const items = screen.getAllByText(/turn$/);
    expect(items[0]).toHaveTextContent("first turn");
    expect(items[1]).toHaveTextContent("second turn");
  });

  it("shows an empty-state line when there are no chunks", async () => {
    (getBrainstormChunksApi as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, chunks: [], total: 0 },
    );
    renderWithQuery(<MeetingDetail id={MEETING_ID} />);
    await waitFor(() => {
      expect(
        screen.getByText(/no transcript chunks for this session/),
      ).toBeInTheDocument();
    });
  });

  it("fetches chunks via the shared /brainstorms/:id/chunks endpoint keyed on the meeting id", async () => {
    renderWithQuery(<MeetingDetail id={MEETING_ID} />);
    await waitFor(() => {
      expect(getBrainstormChunksApi).toHaveBeenCalledWith(
        MEETING_ID,
        500,
        { order: "desc" },
      );
    });
  });
});

describe("MeetingDetail - edit form (task 4 / F4)", () => {
  it("seeds attendees and topic inputs from the fetched meeting", async () => {
    renderWithQuery(<MeetingDetail id={MEETING_ID} />);
    const attendeesInput = await screen.findByPlaceholderText(
      "alice, bob, carol",
    );
    const topicInput = await screen.findByPlaceholderText(
      "what this meeting is about",
    );
    expect(attendeesInput).toHaveValue("alice, bob");
    expect(topicInput).toHaveValue("roadmap review");
  });

  it("submits patchMeeting with the edited, trimmed values", async () => {
    renderWithQuery(<MeetingDetail id={MEETING_ID} />);
    const attendeesInput = await screen.findByPlaceholderText(
      "alice, bob, carol",
    );
    fireEvent.change(attendeesInput, {
      target: { value: "  alice, bob, carol  " },
    });
    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(patchMeeting).toHaveBeenCalledWith(MEETING_ID, {
        attendees: "alice, bob, carol",
        meeting_topic: "roadmap review",
      });
    });
  });

  it("sends null for a field the user blanks out", async () => {
    renderWithQuery(<MeetingDetail id={MEETING_ID} />);
    const topicInput = await screen.findByPlaceholderText(
      "what this meeting is about",
    );
    fireEvent.change(topicInput, { target: { value: "   " } });
    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(patchMeeting).toHaveBeenCalledWith(MEETING_ID, {
        attendees: "alice, bob",
        meeting_topic: null,
      });
    });
  });
});
