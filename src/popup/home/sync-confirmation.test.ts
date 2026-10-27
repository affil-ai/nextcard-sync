// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { placeSyncConfirmation } from "./sync-confirmation";

it("keeps the same confirmation and its listeners inside the matching program across rerenders", () => {
  document.body.innerHTML = `<main id="fallback"><section id="confirmation"><button>Confirm</button></section><div id="home"><article data-sync-provider="aa"></article><article data-sync-provider="bilt"></article></div></main>`;
  const confirmation = document.getElementById("confirmation");
  const homeList = document.getElementById("home");
  const fallback = document.getElementById("fallback");
  if (!confirmation || !homeList || !fallback) throw new Error("Missing fixture");
  const confirm = vi.fn();
  confirmation.querySelector("button")?.addEventListener("click", confirm);
  const options = { confirmation, homeList, fallback, provider: "bilt", detailView: null };
  placeSyncConfirmation(options);
  expect(confirmation.parentElement?.dataset.syncProvider).toBe("bilt");
  homeList.innerHTML = `<article data-sync-provider="bilt"></article>`;
  placeSyncConfirmation(options);
  expect(confirmation.isConnected).toBe(true);
  confirmation.querySelector("button")?.click();
  expect(confirm).toHaveBeenCalledOnce();
  placeSyncConfirmation({ ...options, provider: "missing" });
  expect(confirmation.parentElement).toBe(fallback);
  expect(document.querySelectorAll("#confirmation")).toHaveLength(1);
});

it("puts confirmation before the sync action in the active provider detail, then returns it to the card", () => {
  const confirmation = document.createElement("section");
  const homeList = document.createElement("div");
  homeList.innerHTML = `<article data-sync-provider="aa"></article>`;
  const detailView = document.createElement("div");
  detailView.id = "aaView";
  detailView.innerHTML = `<button class="sync-btn">Sync</button>`;
  const options = { confirmation, homeList, detailView, fallback: document.createElement("div"), provider: "aa" };
  placeSyncConfirmation(options);
  expect(confirmation.nextElementSibling?.className).toBe("sync-btn");
  placeSyncConfirmation({ ...options, detailView: null });
  expect(confirmation.parentElement?.dataset.syncProvider).toBe("aa");
});
