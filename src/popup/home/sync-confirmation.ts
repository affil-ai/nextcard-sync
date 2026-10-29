// Move the existing control, preserving its listeners and profile safeguards.
export function placeSyncConfirmation(options: {
  confirmation: HTMLElement;
  provider: string | null;
  homeList: HTMLElement;
  fallback: HTMLElement;
  detailView: HTMLElement | null;
}) {
  const { confirmation, provider, homeList, fallback, detailView } = options;
  const card = Array.from(homeList.querySelectorAll<HTMLElement>("[data-sync-provider]"))
    .find((element) => element.dataset.syncProvider === provider);
  const detail = provider && detailView?.id === `${provider}View`
    ? detailView
    : null;
  const target = detail ?? card ?? fallback;
  if (confirmation.parentElement === target) return;
  if (detail) {
    const syncAction = detail.querySelector(":scope > .sync-actions, :scope > .sync-btn");
    detail.insertBefore(confirmation, syncAction);
  } else if (card) {
    card.appendChild(confirmation);
  } else {
    fallback.prepend(confirmation);
  }
}
