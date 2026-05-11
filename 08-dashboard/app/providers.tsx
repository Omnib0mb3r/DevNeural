"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { VoiceClient } from "@/components/VoiceClient";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  /* VoiceClient wraps the whole tree so its state context is
   * available to UI islands (TopBar mic pill, future badges). The
   * engine itself runs once at the root so the WS, mic stream, and
   * AudioContext survive in-app navigation. /lex portals the full
   * panel into its own mount target; the TopBar pill consumes the
   * same VoiceCtx for a compact status + mute + stop on every
   * route. */
  return (
    <QueryClientProvider client={client}>
      <VoiceClient>{children}</VoiceClient>
    </QueryClientProvider>
  );
}
