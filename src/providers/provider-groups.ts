import type { ProviderId } from "../lib/types";
import type { ProviderGroup } from "./provider-registry";

export const providerGroups: Array<{ label: ProviderGroup; ids: ProviderId[] }> = [
  { label: "Banks", ids: ["chase", "amex", "capitalone", "bilt", "discover", "citi"] },
  { label: "Airlines", ids: ["aa", "delta", "united", "southwest", "frontier", "atmos"] },
  { label: "Hotels", ids: ["marriott", "ihg", "hyatt", "hilton"] },
];

export const orderedProviderIds = providerGroups.flatMap((group) => group.ids);
