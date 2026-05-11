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
  /* VoiceClient is mounted once at the application root so the WS,
   * mic stream, and AudioContext survive in-app navigation. /lex
   * portals the panel UI into its own mount target; every other
   * route gets a floating mini-badge from the same component so the
   * user can stop / mute without losing their place. */
  return (
    <QueryClientProvider client={client}>
      {children}
      <VoiceClient />
    </QueryClientProvider>
  );
}
