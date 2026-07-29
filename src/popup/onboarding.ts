import type { ProviderId } from "../lib/types";

const ONBOARDING_STEPS = 4;

export function getOnboardingCompletionAction(
  replaying: boolean,
  signedIn: boolean,
) {
  if (replaying) {
    return {
      label: "Set up Rewards",
      destination: "rewards" as const,
    };
  }
  return {
    label: signedIn ? "Continue to Offers" : "Continue with nextcard",
    destination: "offers" as const,
  };
}

export function createOnboardingController(options: {
  onboardingBtn: HTMLButtonElement;
  onComplete: () => void;
  getFinalLabel?: () => string;
}) {
  let onboardingStep = 0;
  let maxVisitedStep = 0;

  function setOnboardingStep(step: number) {
    onboardingStep = Math.max(0, Math.min(step, ONBOARDING_STEPS - 1));
    maxVisitedStep = Math.max(maxVisitedStep, onboardingStep);

    for (const element of document.querySelectorAll(".onboarding-step")) {
      const panel = element as HTMLElement;
      panel.classList.toggle("active", Number(panel.dataset.step) === onboardingStep);
    }

    for (const dot of document.querySelectorAll(".onboarding-dot")) {
      const panelDot = dot as HTMLElement;
      const idx = Number(panelDot.dataset.dot);
      panelDot.classList.toggle("active", idx === onboardingStep);
      panelDot.classList.toggle("visited", idx <= maxVisitedStep);
    }

    options.onboardingBtn.textContent = onboardingStep === ONBOARDING_STEPS - 1
      ? options.getFinalLabel?.() ?? "Continue with nextcard"
      : "Next";
    options.onboardingBtn.disabled = false;
  }

  options.onboardingBtn.addEventListener("click", () => {
    if (onboardingStep < ONBOARDING_STEPS - 1) {
      setOnboardingStep(onboardingStep + 1);
      return;
    }

    options.onComplete();
  });

  for (const dot of document.querySelectorAll(".onboarding-dot")) {
    dot.addEventListener("click", () => {
      const target = Number((dot as HTMLElement).dataset.dot);
      if (target <= maxVisitedStep) {
        setOnboardingStep(target);
      }
    });
  }

  return {
    reset() {
      maxVisitedStep = 0;
      setOnboardingStep(0);
    },
    setOnboardingStep,
  };
}

export function createConsentController(options: {
  consentModal: HTMLDivElement;
  consentCheckbox: HTMLInputElement;
  consentContinueBtn: HTMLButtonElement;
  consentCancelBtn: HTMLButtonElement;
  consentTitle: HTMLDivElement;
  consentBody: HTMLDivElement;
  onContinue: (providerId: ProviderId) => void;
  onActionContinue?: (action: () => void) => void;
}) {
  let pendingProvider: ProviderId | null = null;
  let pendingAction: (() => void) | null = null;
  let previouslyFocused: HTMLElement | null = null;
  const defaultBody = options.consentBody.innerHTML;

  function focusableElements() {
    return Array.from(options.consentModal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ));
  }

  function openModal() {
    previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    options.consentModal.classList.add("visible");
    options.consentModal.setAttribute("aria-hidden", "false");
    queueMicrotask(() => options.consentCheckbox.focus());
  }

  function closeModal(restoreFocus = true) {
    options.consentModal.classList.remove("visible");
    options.consentModal.setAttribute("aria-hidden", "true");
    options.consentCheckbox.checked = false;
    options.consentContinueBtn.disabled = true;
    if (restoreFocus) previouslyFocused?.focus();
    previouslyFocused = null;
  }

  options.consentCheckbox.addEventListener("change", () => {
    options.consentContinueBtn.disabled = !options.consentCheckbox.checked;
  });

  options.consentContinueBtn.addEventListener("click", () => {
    if (!pendingProvider && !pendingAction) return;
    const providerId = pendingProvider;
    const action = pendingAction;
    pendingProvider = null;
    pendingAction = null;
    closeModal(false);
    if (action) {
      options.onActionContinue?.(action);
      return;
    }
    if (providerId) {
      options.onContinue(providerId);
    }
  });

  options.consentCancelBtn.addEventListener("click", () => {
    pendingProvider = null;
    pendingAction = null;
    closeModal(true);
  });

  options.consentModal.addEventListener("keydown", (event) => {
    if (!options.consentModal.classList.contains("visible")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      options.consentCancelBtn.click();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = focusableElements();
    if (elements.length === 0) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function resetCopy() {
    options.consentTitle.textContent = "Before we continue";
    options.consentBody.innerHTML = defaultBody;
    options.consentContinueBtn.textContent = "Agree & continue";
  }

  return {
    request(providerId: ProviderId) {
      resetCopy();
      pendingProvider = providerId;
      pendingAction = null;
      openModal();
      options.consentCheckbox.checked = false;
      options.consentContinueBtn.disabled = true;
    },
    requestAction(
      action: () => void,
      copy?: { title?: string; body?: string; continueLabel?: string },
    ) {
      pendingProvider = null;
      pendingAction = action;
      resetCopy();
      if (copy?.title) options.consentTitle.textContent = copy.title;
      if (copy?.body) options.consentBody.innerHTML = copy.body;
      if (copy?.continueLabel) options.consentContinueBtn.textContent = copy.continueLabel;
      openModal();
      options.consentCheckbox.checked = false;
      options.consentContinueBtn.disabled = true;
    },
  };
}
