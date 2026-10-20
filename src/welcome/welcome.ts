import "./welcome.css";
import {
  normalizeOfferOperationSnapshot,
  OFFER_OPERATION_STORAGE_KEY,
} from "../lib/offer-operation";

const openButton = document.getElementById("open-extension");
const panelStatus = document.getElementById("panel-status");
const setup = document.querySelector(".setup");
const title = document.getElementById("step-title");
const description = document.getElementById("step-description");
const detail = document.getElementById("step-detail");
const count = document.getElementById("step-count");
const skipButton = document.getElementById("skip-pin");
const backButton = document.getElementById("previous-step");
const offersLink = document.getElementById("view-offers");
const progress = document.querySelectorAll(".progress li");
const guideStartedAt = Date.now();
const steps = [
  {
    name: "open",
    title: "Open nextcard sync",
    description: "Open the extension beside this page to get started.",
    detail: "",
    action: "Open nextcard sync",
  },
  {
    name: "pin",
    title: "Find and pin nextcard sync",
    description:
      "Open Extensions, then pin nextcard sync for next time.",
    detail: "Choose nextcard sync in the menu to open it anytime.",
    action: "Check pin status",
  },
  {
    name: "sign-in",
    title: "Connect your nextcard account",
    description:
      "Use the account you use on nextcard.com.",
    detail: "We’ll continue once you’re signed in.",
    action: "Sign in to nextcard",
  },
  {
    name: "activate",
    title: "Activate your first offers",
    description:
      "Choose your bank in the sidebar on the right to find your offers.",
    detail: "Select offers, then confirm to activate them.",
    action: "Open nextcard sync",
  },
];
let step = 0;
let pinSkipped = false;
let pinned = false;
let signedIn = false;
let completed = false;
let browserWindowId: number | undefined;
let pinTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let refreshRequested = false;

function renderStep(focus = false) {
  const current = steps[step];
  if (!(openButton instanceof HTMLButtonElement) || !current) return;
  setup?.setAttribute("data-step", completed ? "done" : current.name);
  setup?.classList.toggle("is-pinned", pinned);
  if (title)
    title.textContent = completed
      ? "Your first offers are ready"
      : current.title;
  if (description)
    description.textContent = completed
      ? "Your activated offers were saved to nextcard."
      : current.description;
  if (detail) {
    detail.textContent = completed
      ? "Use an activated offer with its matching card, and check its terms before you spend."
      : current.detail;
    detail.hidden = !detail.textContent;
  }
  if (count)
    count.textContent = completed
      ? "Setup complete"
      : `Step ${step + 1} of ${steps.length}`;
  openButton.textContent = current.action;
  openButton.hidden = completed || step === 1;
  openButton.disabled =
    (step === 0 || step === 3) && browserWindowId === undefined;
  if (skipButton) skipButton.hidden = step !== 1 || completed;
  if (backButton) backButton.hidden = step === 0 || completed;
  if (offersLink) offersLink.hidden = !completed;
  progress.forEach((item, index) => {
    const done =
      (index < step || completed) && !(index === 1 && pinSkipped && !pinned);
    item.classList.toggle("completed", done);
    if (index === step && !completed) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    const number = item.querySelector(".step-number");
    if (number) number.textContent = done ? "✓" : String(index + 1);
    item.setAttribute(
      "aria-label",
      `${steps[index]?.name ?? ""}${done ? ", completed" : index === 1 && pinSkipped ? ", skipped" : ""}`,
    );
  });
  if (pinTimer) clearInterval(pinTimer);
  pinTimer =
    step === 1
      ? setInterval(() => {
          if (!document.hidden) void refreshState();
        }, 1500)
      : undefined;
  if (focus && title instanceof HTMLElement) title.focus();
}

function advance() {
  if (step >= steps.length - 1) return;
  step += 1;
  if (panelStatus) panelStatus.textContent = "";
  renderStep(true);
  void refreshState();
}

async function refreshState() {
  if (refreshing) {
    refreshRequested = true;
    return;
  }
  refreshing = true;
  try {
    const auth: unknown = await chrome.runtime.sendMessage({
      type: "GET_AUTH_STATE",
    });
    signedIn =
      typeof auth === "object" &&
      auth !== null &&
      "token" in auth &&
      typeof auth.token === "string" &&
      auth.token.length > 0;
    try {
      pinned = (await chrome.action.getUserSettings()).isOnToolbar;
    } catch {
      // Pinning is optional, even in browsers that cannot report toolbar state.
    }
    const stored = await chrome.storage.local.get(OFFER_OPERATION_STORAGE_KEY);
    const snapshot = normalizeOfferOperationSnapshot(
      stored[OFFER_OPERATION_STORAGE_KEY],
    );
    completed =
      signedIn &&
      Object.values(snapshot.history).some(
        (operation) =>
          operation?.phase === "completed" &&
          operation.added > 0 &&
          operation.saveStatus === "saved" &&
          Date.parse(operation.startedAt) >= guideStartedAt,
      );
    if (step === 1 && pinned) advance();
    else if (step === 2 && signedIn) advance();
    else if (step === 3 && !signedIn) {
      step = 2;
      completed = false;
      renderStep(true);
    } else renderStep();
  } catch {
    if (panelStatus)
      panelStatus.textContent =
        "Could not check setup progress. You can keep going in the extension.";
  } finally {
    refreshing = false;
    if (refreshRequested) {
      refreshRequested = false;
      void refreshState();
    }
    // An already signed-in user can move straight through the account step.
    if (step === 2 && signedIn) advance();
  }
}

if (openButton instanceof HTMLButtonElement) {
  void chrome.windows
    .getCurrent()
    .then((browserWindow) => {
      browserWindowId = browserWindow.id;
      renderStep();
      void refreshState();
    })
    .catch(() => {
      if (panelStatus)
        panelStatus.textContent =
          "Open nextcard sync from Chrome’s puzzle-piece menu to get started.";
    });

  openButton.addEventListener("click", () => {
    if (step === 2) {
      void chrome.runtime
        .sendMessage({ type: "SIGN_IN_NEXTCARD" })
        .then((response: unknown) => {
          if (
            typeof response !== "object" ||
            response === null ||
            !("ok" in response) ||
            response.ok !== true
          )
            throw new Error("Sign-in unavailable");
          if (panelStatus)
            panelStatus.textContent =
              "Finish signing in on the nextcard tab. We’ll bring you back here to continue.";
        })
        .catch(() => {
          if (panelStatus)
            panelStatus.textContent =
              "Could not start sign-in. Open the extension and select Sign in to nextcard.";
        });
      return;
    }
    if (browserWindowId === undefined) return;
    // Invoke directly in the click handler to retain Chrome's user gesture.
    void chrome.sidePanel
      .open({ windowId: browserWindowId })
      .then(() => {
        if (step === 0) advance();
        else if (panelStatus)
          panelStatus.textContent =
            "nextcard sync is open beside this page. Choose Offers to check and activate your offers.";
      })
      .catch(() => {
        if (panelStatus)
          panelStatus.textContent =
            "Could not open the panel. Click Chrome’s puzzle-piece icon, then nextcard sync.";
      });
  });
}

skipButton?.addEventListener("click", () => {
  pinSkipped = true;
  advance();
});
backButton?.addEventListener("click", () => {
  step = Math.max(0, step - 1);
  if (panelStatus) panelStatus.textContent = "";
  renderStep(true);
});
const onStorageChanged = () => {
  void refreshState();
};
const onFocus = () => {
  void refreshState();
};
const onVisibilityChanged = () => {
  if (!document.hidden) void refreshState();
};
chrome.storage.onChanged.addListener(onStorageChanged);
window.addEventListener("focus", onFocus);
document.addEventListener("visibilitychange", onVisibilityChanged);
window.addEventListener(
  "pagehide",
  () => {
    if (pinTimer) clearInterval(pinTimer);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChanged);
  },
  { once: true },
);
