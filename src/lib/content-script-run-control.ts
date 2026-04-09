import { hideOverlay } from "./overlay";
import type { AbortSyncRunMessage, ProviderId } from "./types";

export class ContentScriptRunCancelledError extends Error {
  provider: ProviderId;
  attemptId: string;

  constructor(provider: ProviderId, attemptId: string) {
    super(`Content script run cancelled for ${provider}`);
    this.name = "ContentScriptRunCancelledError";
    this.provider = provider;
    this.attemptId = attemptId;
  }
}

export function createContentScriptRunControl(provider: ProviderId) {
  let activeAttemptId: string | null = null;
  const cancelledAttemptIds = new Set<string>();

  function isAbortMessage(message: unknown): message is AbortSyncRunMessage {
    if (!message || typeof message !== "object") return false;
    if (!("type" in message) || !("provider" in message) || !("attemptId" in message)) return false;
    return message.type === "ABORT_SYNC_RUN" && message.provider === provider && typeof message.attemptId === "string";
  }

  function beginAttempt(attemptId: string) {
    // New attempts replace stale ones so pages do not keep acting on old syncs.
    activeAttemptId = attemptId;
    cancelledAttemptIds.delete(attemptId);
  }

  function isAttemptActive(attemptId: string) {
    return activeAttemptId === attemptId && !cancelledAttemptIds.has(attemptId);
  }

  function throwIfCancelled(attemptId: string) {
    if (!isAttemptActive(attemptId)) {
      throw new ContentScriptRunCancelledError(provider, attemptId);
    }
  }

  async function sleep(ms: number, attemptId: string) {
    throwIfCancelled(attemptId);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    throwIfCancelled(attemptId);
  }

  async function sendMessage<T extends Record<string, unknown>>(attemptId: string, message: T) {
    throwIfCancelled(attemptId);
    await chrome.runtime.sendMessage({ ...message, provider, attemptId });
  }

  function handleAbort(message: unknown) {
    if (!isAbortMessage(message)) return false;

    cancelledAttemptIds.add(message.attemptId);
    if (activeAttemptId === message.attemptId) {
      activeAttemptId = null;
      hideOverlay("cancelled");
    }
    return true;
  }

  return {
    beginAttempt,
    handleAbort,
    isAttemptActive,
    throwIfCancelled,
    sleep,
    sendMessage,
  };
}
