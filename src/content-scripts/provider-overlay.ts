import { z } from "zod";
import { isMfaPage } from "../lib/login-state-monitor";
import { showOverlay, removeOverlay, updateOverlayProgress } from "../lib/overlay";

const operationSchema = z.object({
  provider: z.string(),
  kind: z.enum(["rewards", "offers", "bofa"]),
  operationId: z.string(),
  status: z.enum(["account_check", "waiting_for_login", "mfa_challenge", "extracting"]),
  progressMessage: z.string().nullish(),
});
let showing = false;
let pending = false;

// The worker binds the banner to this tab and run, never just an issuer name.
// Polling also covers existing tabs and login redirects whose scraper loads late.
async function refresh() {
  if (pending) return;
  pending = true;
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "GET_PAGE_OVERLAY_STATUS" });
    const result = operationSchema.safeParse(response);
    if (!result.success) {
      if (showing) removeOverlay();
      showing = false;
      return;
    }
    const { provider, kind, operationId, status, progressMessage } = result.data;
    const identity = { provider, kind, operationId };
    const pageStatus = status === "waiting_for_login" && isMfaPage() ? "mfa_challenge" : status;
    showOverlay(pageStatus, provider, {
      statusMessage: { type: "GET_PAGE_OVERLAY_STATUS", ...identity },
      cancelMessage: { type: "CANCEL_PAGE_OVERLAY_OPERATION", ...identity },
    });
    if (pageStatus === "extracting" && progressMessage) updateOverlayProgress(progressMessage);
    showing = true;
  } catch {
    // A transient worker disconnect should not erase a useful sign-in prompt.
  } finally {
    pending = false;
  }
}
void refresh();
const timer = setInterval(() => { void refresh(); }, 1_000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
