import type { LoginState, ProviderId } from "./types";

interface LoginStateMonitorOptions {
  provider: ProviderId;
  detectLoginState: () => LoginState;
  onStateChange?: (newState: LoginState, oldState: LoginState) => void;
  intervalMs?: number;
}

interface LoginStateMonitor {
  start(): void;
  stop(): void;
  getState(): LoginState;
  check(): void;
}

const MFA_URL_PATTERNS = [
  "otp", "mfa", "2fa", "verify", "challenge", "confirm-identity",
  "confirmidentity", "one-time", "security-code", "two-factor",
  "send-code", "enter-code", "caas/challenge", "send-otp",
];

const MFA_INPUT_KEYWORDS = [
  "otp", "one-time", "onetime", "verification", "verify",
  "security-code", "securitycode", "mfa", "2fa", "passcode",
];

function isMfaPage(): boolean {
  const url = window.location.href.toLowerCase();
  if (MFA_URL_PATTERNS.some((p) => url.includes(p))) return true;

  const inputs = document.querySelectorAll("input");
  for (const input of inputs) {
    if ((input as HTMLElement).offsetParent === null) continue;
    const attrs = `${input.type} ${input.name} ${input.id} ${input.placeholder} ${input.autocomplete} ${input.className} ${input.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (MFA_INPUT_KEYWORDS.some((kw) => attrs.includes(kw))) return true;
  }

  // Detect multi-box OTP pattern: 4-8 visible single-character numeric inputs
  const numericInputs = Array.from(inputs).filter((input) => {
    if ((input as HTMLElement).offsetParent === null) return false;
    return input.inputMode === "numeric" || input.type === "tel" || input.pattern === "[0-9]*" || input.pattern === "\\d*";
  });
  if (numericInputs.length >= 4 && numericInputs.length <= 8) {
    const allSingleChar = numericInputs.every((i) => i.maxLength === 1 || i.maxLength === -1);
    if (allSingleChar) return true;
  }

  return false;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

export function createLoginStateMonitor(
  options: LoginStateMonitorOptions,
): LoginStateMonitor {
  const { provider, detectLoginState, onStateChange, intervalMs = 3000 } = options;
  let lastState: LoginState = "unknown";
  let observer: MutationObserver | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  function check() {
    let newState = detectLoginState();

    // Layer MFA detection on top: if the provider says logged_out or unknown
    // but we see MFA indicators, report mfa_challenge instead
    if (newState !== "logged_in" && isMfaPage()) {
      newState = "mfa_challenge";
    }

    if (newState !== lastState) {
      const oldState = lastState;
      lastState = newState;
      chrome.runtime.sendMessage({
        type: "LOGIN_STATE",
        provider,
        state: newState,
      }).catch(() => {});
      onStateChange?.(newState, oldState);
    }
  }

  function start() {
    if (started) return;
    started = true;

    // Initial check
    lastState = detectLoginState();
    if (lastState !== "logged_in" && isMfaPage()) {
      lastState = "mfa_challenge";
    }
    chrome.runtime.sendMessage({
      type: "LOGIN_STATE",
      provider,
      state: lastState,
    }).catch(() => {});
    onStateChange?.(lastState, "unknown");

    const debouncedCheck = debounce(check, 300);

    observer = new MutationObserver(debouncedCheck);
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "data-is-signed-in", "aria-expanded", "hidden", "style"],
      });
    } else {
      const bodyObserver = new MutationObserver(() => {
        if (document.body) {
          bodyObserver.disconnect();
          observer!.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "data-is-signed-in", "aria-expanded", "hidden", "style"],
          });
        }
      });
      bodyObserver.observe(document.documentElement, { childList: true });
    }

    fallbackTimer = setInterval(check, intervalMs);

    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
  }

  function stop() {
    started = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    window.removeEventListener("popstate", check);
    window.removeEventListener("hashchange", check);
  }

  function getState(): LoginState {
    return lastState;
  }

  return { start, stop, getState, check };
}
