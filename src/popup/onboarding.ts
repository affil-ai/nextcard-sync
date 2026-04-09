import type { ProviderId } from "../lib/types";

const ONBOARDING_STEPS = 3;

export function createOnboardingController(options: {
  onboardingBtn: HTMLButtonElement;
  onComplete: () => void;
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
      ? "Get Started"
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
  onContinue: (providerId: ProviderId) => void;
}) {
  let pendingProvider: ProviderId | null = null;

  options.consentCheckbox.addEventListener("change", () => {
    options.consentContinueBtn.disabled = !options.consentCheckbox.checked;
  });

  options.consentContinueBtn.addEventListener("click", () => {
    if (!pendingProvider) return;
    const providerId = pendingProvider;
    pendingProvider = null;
    options.consentModal.classList.remove("visible");
    options.consentCheckbox.checked = false;
    options.consentContinueBtn.disabled = true;
    options.onContinue(providerId);
  });

  return {
    request(providerId: ProviderId) {
      pendingProvider = providerId;
      options.consentModal.classList.add("visible");
      options.consentCheckbox.checked = false;
      options.consentContinueBtn.disabled = true;
    },
  };
}
