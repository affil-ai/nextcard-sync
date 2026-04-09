import { describe, expect, it, vi } from "vitest";

import { resolveSyncStarter } from "./message-router";
import { providerRegistry } from "../../providers/provider-registry";

describe("resolveSyncStarter", () => {
  it("routes generic providers to the shared generic starter", async () => {
    const generic = vi.fn(async () => {});
    const atmos = vi.fn(async () => {});
    const chase = vi.fn(async () => {});
    const amex = vi.fn(async () => {});
    const capitalone = vi.fn(async () => {});
    const hyatt = vi.fn(async () => {});
    const bilt = vi.fn(async () => {});

    const startSync = resolveSyncStarter("marriott", providerRegistry, {
      generic,
      atmos,
      "chase-v1": chase,
      amex,
      capitalone,
      hyatt,
      bilt,
    });

    await startSync();

    expect(generic).toHaveBeenCalledWith("marriott");
    expect(atmos).not.toHaveBeenCalled();
    expect(chase).not.toHaveBeenCalled();
  });

  it("routes Chase to the v1-specific starter", async () => {
    const chase = vi.fn(async () => {});

    const startSync = resolveSyncStarter("chase", providerRegistry, {
      generic: vi.fn(async () => {}),
      atmos: vi.fn(async () => {}),
      "chase-v1": chase,
      amex: vi.fn(async () => {}),
      capitalone: vi.fn(async () => {}),
      hyatt: vi.fn(async () => {}),
      bilt: vi.fn(async () => {}),
    });

    await startSync();

    expect(chase).toHaveBeenCalledTimes(1);
  });

  it("routes dedicated provider strategies to their specialized handlers", async () => {
    const amex = vi.fn(async () => {});
    const capitalone = vi.fn(async () => {});
    const hyatt = vi.fn(async () => {});
    const bilt = vi.fn(async () => {});

    await resolveSyncStarter("amex", providerRegistry, {
      generic: vi.fn(async () => {}),
      atmos: vi.fn(async () => {}),
      "chase-v1": vi.fn(async () => {}),
      amex,
      capitalone,
      hyatt,
      bilt,
    })();
    await resolveSyncStarter("capitalone", providerRegistry, {
      generic: vi.fn(async () => {}),
      atmos: vi.fn(async () => {}),
      "chase-v1": vi.fn(async () => {}),
      amex: vi.fn(async () => {}),
      capitalone,
      hyatt: vi.fn(async () => {}),
      bilt: vi.fn(async () => {}),
    })();
    await resolveSyncStarter("hyatt", providerRegistry, {
      generic: vi.fn(async () => {}),
      atmos: vi.fn(async () => {}),
      "chase-v1": vi.fn(async () => {}),
      amex: vi.fn(async () => {}),
      capitalone: vi.fn(async () => {}),
      hyatt,
      bilt: vi.fn(async () => {}),
    })();
    await resolveSyncStarter("bilt", providerRegistry, {
      generic: vi.fn(async () => {}),
      atmos: vi.fn(async () => {}),
      "chase-v1": vi.fn(async () => {}),
      amex: vi.fn(async () => {}),
      capitalone: vi.fn(async () => {}),
      hyatt: vi.fn(async () => {}),
      bilt,
    })();

    expect(amex).toHaveBeenCalledTimes(1);
    expect(capitalone).toHaveBeenCalledTimes(1);
    expect(hyatt).toHaveBeenCalledTimes(1);
    expect(bilt).toHaveBeenCalledTimes(1);
  });
});
