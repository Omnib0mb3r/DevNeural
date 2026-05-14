/**
 * DevNeural Hub service worker.
 *
 * Phase 3.4.6 scaffold: install + activate + minimal fetch passthrough.
 * Phase 3.7 lands the push handler + VAPID subscription flow.
 *
 * SW_VERSION is rewritten by scripts/postbuild-sw-version.mjs after every
 * `next build` so the sw.js byte stream changes and the browser picks up
 * the new bundle without a manual unregister. Source value below is a
 * sentinel; the post-build pass replaces it with an ISO timestamp.
 */

const SW_VERSION = "__BUILD_VERSION__";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Push handler. Two event-type taxonomies today:
//   - "reminder" (default, scheduled reminders): standard icon, normal
//     urgency, body reads the due-date snippet.
//   - "attention" (real-time Lex attention-needed): attention icon,
//     high urgency, "requireInteraction" flag set so the system
//     notification stays visible until the user acknowledges. Used by
//     the lex-attention pipeline for question-ending turns + worker
//     stall escalations.
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "DevNeural", body: event.data.text() };
  }
  const eventType = payload.event_type === "attention" ? "attention" : "reminder";
  const isAttention = eventType === "attention";
  const title = payload.title || (isAttention ? "Lex needs you" : "DevNeural");
  const data = {
    url: payload.url || "/",
    id: payload.id,
    event_type: eventType,
    ts: Date.now(),
    /* Free-form payload metadata: brainstorm_id, turn_id, snippet,
     * anchor_id, kind. The notificationclick handler reads these to
     * build a deep link into the dashboard. */
    ...(payload.data || {}),
  };
  const opts = {
    body: payload.body || "",
    icon: isAttention ? "/icons/attention-192.png" : "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data,
    tag: payload.tag || payload.id || (isAttention ? "lex-attention" : "default"),
    /* Attention notifications must not auto-dismiss before the user
     * sees them; phone OSes treat requireInteraction=true as a
     * persistent banner that stays until tap. */
    requireInteraction: isAttention,
    /* High vibrate pattern on attention only. Reminders keep the OS
     * default so the user can keep them subdued. */
    vibrate: isAttention ? [220, 80, 220, 80, 320] : undefined,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

/* Build the deep-link target for an attention notification. When the
 * push carried a brainstorm_id + turn_id the click opens the
 * brainstorm view scrolled to that turn; with only brainstorm_id
 * (stall path) we open the brainstorm root; otherwise fall back to
 * the URL the payload supplied so the legacy reminder path keeps
 * working. */
function attentionDeepLink(data) {
  if (data?.event_type !== "attention") {
    return data?.url || "/";
  }
  const brainstormId = data.brainstorm_id;
  const turnId = data.turn_id;
  if (brainstormId && turnId) {
    return `/brainstorms/${encodeURIComponent(brainstormId)}#turn-${encodeURIComponent(turnId)}`;
  }
  if (brainstormId) {
    return `/brainstorms/${encodeURIComponent(brainstormId)}`;
  }
  return data.url || "/lex";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = attentionDeepLink(event.notification.data);
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      const existing = wins.find((w) => w.url.includes(target));
      if (existing) {
        /* Navigate the existing tab to the deep link so a click that
         * lands on a tab already showing the dashboard scrolls to the
         * matching turn instead of just re-focusing the tab. */
        if ("navigate" in existing && existing.url !== target) {
          return existing.navigate(target).then(() => existing.focus());
        }
        return existing.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
