import type { ProviderId } from "../lib/types";
import type { ProviderGroup } from "./provider-registry";

export const providerGroups: Array<{ label: ProviderGroup; ids: ProviderId[] }> = [
  { label: "Hotels", ids: ["marriott", "ihg", "hyatt", "hilton"] },
  { label: "Airlines", ids: ["aa", "delta", "united", "southwest", "frontier", "atmos"] },
  { label: "Banks", ids: ["chase", "amex", "capitalone", "bilt"] },
];

export const orderedProviderIds = providerGroups.flatMap((group) => group.ids);
