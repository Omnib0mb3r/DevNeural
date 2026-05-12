/**
 * Permanent dashboard tour. Mirrors Section C of
 * docs/PLAN-2026-05-12-evening.md. Each scenario is currently
 * test.skip'd with reason 'selectors-pending'; the MCP Playwright
 * run that Lex drives is the canonical execution path tonight. As
 * each surface's selectors stabilise, flip the .skip on its block
 * and run via `npm run e2e`.
 */
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PENDING = "selectors-pending";

test.skip("C2 dashboard boots, top bar renders", async ({ page }) => {
  // pending: ${PENDING}
  await page.goto("/");
  await expect(page.getByTestId("top-bar")).toBeVisible();
});

test.skip("C3 panic button keybind fires + audits", async ({ page }) => {
  // pending: ${PENDING}
  await page.goto("/");
  await page.keyboard.press("Control+Alt+.");
  await page.goto("/system");
  await expect(page.getByText(/Panic audit/i)).toBeVisible();
});

test.skip("C4 Past Sessions collapse + persistence", async ({ page }) => {
  // pending: ${PENDING}
  await page.goto("/lex");
  await page.getByRole("button", { name: /collapse/i }).click();
  await page.reload();
  await expect(
    page.getByTestId("lex-past-sessions-strip"),
  ).toBeVisible();
});

test.skip("C5 TerminalMirror collapse", async ({ page }) => {
  // pending: ${PENDING}
  await page.goto("/lex");
});

test.skip("C6 brainstorm transcript history + thinking placeholder", async ({
  page,
}) => {
  // pending: ${PENDING}
  await page.goto("/lex");
  await expect(
    page.getByTestId("lex-transcript-history"),
  ).toBeVisible();
});

test.skip("C7 supervision_mode toggle cycles + persists", async ({
  page,
}) => {
  // pending: ${PENDING}
  await page.goto("/projects");
  await page.getByTestId("supervision-mode-event").first().click();
  await page.reload();
  await expect(
    page.getByTestId("supervision-mode-event").first(),
  ).toHaveAttribute("aria-pressed", "true");
});

test.skip("C8 Stream Deck label count matches DB", async ({ page }) => {
  // pending: ${PENDING}
  await page.goto("/sessions");
});
