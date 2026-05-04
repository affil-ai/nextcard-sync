import type {
  AtmosProviderData,
  MarriottProviderData,
  AAProviderData,
  DeltaProviderData,
  UnitedProviderData,
  IHGProviderData,
  HyattProviderData,
  AmexProviderData,
  CapitalOneProviderData,
  HiltonProviderData,
  FrontierProviderData,
  BiltProviderData,
  SouthwestProviderData,
  ChaseProviderData,
  DiscoverProviderData,
  CitiProviderData,
} from "../contracts/loyalty-provider-data";

// ── Provider system ──────────────────────────────────────────

export type ProviderId = "marriott" | "atmos" | "chase" | "aa" | "delta" | "united" | "southwest" | "ihg" | "hyatt" | "amex" | "capitalone" | "hilton" | "frontier" | "bilt" | "discover" | "citi";

export type SyncStatus = "idle" | "detecting_login" | "waiting_for_login" | "extracting" | "done" | "cancelled" | "error";

export type LoginState = "logged_in" | "logged_out" | "mfa_challenge" | "unknown";

export interface ProviderSyncState<T = unknown> {
  status: SyncStatus;
  data: T | null;
  error: string | null;
  lastSyncedAt: string | null;
  progressMessage: string | null;
}

// ── Provider data types ─────────────────────────────────────

export type MarriottLoyaltyData = MarriottProviderData;

export type AtmosLoyaltyData = AtmosProviderData;

export type MarriottCertificate = MarriottLoyaltyData["certificates"][number];

export type AtmosRewardCard = AtmosLoyaltyData["rewards"][number];

export type AtmosDiscount = AtmosLoyaltyData["discounts"][number];

// ── Airline types ──────────────────────────────────────────

export type AALoyaltyData = AAProviderData;

export type DeltaLoyaltyData = DeltaProviderData;

export type UnitedLoyaltyData = UnitedProviderData;

export type SouthwestLoyaltyData = SouthwestProviderData;

export type IHGLoyaltyData = IHGProviderData;

export type HyattLoyaltyData = HyattProviderData;

export type AmexLoyaltyData = AmexProviderData;

export type CapitalOneLoyaltyData = CapitalOneProviderData;

export type HiltonLoyaltyData = HiltonProviderData;

export type FrontierLoyaltyData = FrontierProviderData;

export type BiltLoyaltyData = BiltProviderData;

export type DiscoverLoyaltyData = DiscoverProviderData;

export type CitiLoyaltyData = CitiProviderData;

// ── Chase types ────────────────────────────────────────────

export type ChaseURData = ChaseProviderData;

export type ChaseBenefit = ChaseURData["benefits"][number];

// ── NextCard auth ──────────────────────────────────────────

export interface NextCardAuth {
  token: string;
  name: string | null;
  email: string | null;
  signedInAt: string;
}

export interface ProviderDataMap {
  marriott: MarriottLoyaltyData;
  atmos: AtmosLoyaltyData;
  chase: ChaseURData;
  aa: AALoyaltyData;
  delta: DeltaLoyaltyData;
  united: UnitedLoyaltyData;
  southwest: SouthwestLoyaltyData;
  ihg: IHGLoyaltyData;
  hyatt: HyattLoyaltyData;
  amex: AmexLoyaltyData;
  capitalone: CapitalOneLoyaltyData;
  hilton: HiltonLoyaltyData;
  frontier: FrontierLoyaltyData;
  bilt: BiltLoyaltyData;
  discover: DiscoverLoyaltyData;
  citi: CitiLoyaltyData;
}

export type ProviderStateMap = {
  [Provider in ProviderId]: ProviderSyncState<ProviderDataMap[Provider]>;
};

// ── Messages ────────────────────────────────────────────────

interface ProviderMessageBase {
  provider: ProviderId;
  attemptId: string;
}

export type AbortSyncRunMessage = ProviderMessageBase & {
  type: "ABORT_SYNC_RUN";
};

export type ExtensionMessage =
  | { type: "REQUEST_SYNC"; provider: ProviderId }
  | { type: "CANCEL_SYNC"; provider: ProviderId }
  | { type: "CLEAR_DATA"; provider: ProviderId }
  | { type: "GET_STATUS"; provider?: ProviderId }
  | { type: "GET_ALL_STATUS" }
  | (ProviderMessageBase & { type: "START_EXTRACTION"; cardIndex?: number })
  | (ProviderMessageBase & { type: "EXTRACTION_DONE"; data: MarriottLoyaltyData | AtmosLoyaltyData | ChaseURData | AALoyaltyData | DeltaLoyaltyData | UnitedLoyaltyData | SouthwestLoyaltyData | IHGLoyaltyData | HyattLoyaltyData | AmexLoyaltyData | CapitalOneLoyaltyData | HiltonLoyaltyData | FrontierLoyaltyData | BiltLoyaltyData | DiscoverLoyaltyData | CitiLoyaltyData })
  | (ProviderMessageBase & { type: "LOGIN_STATE"; state: LoginState })
  | (ProviderMessageBase & { type: "STATUS_UPDATE"; status: SyncStatus; data: unknown; error: string | null })
  | (ProviderMessageBase & { type: "ATMOS_OVERVIEW_DONE"; data: Partial<AtmosLoyaltyData> })
  | (ProviderMessageBase & { type: "ATMOS_REWARDS_DONE"; rewards: AtmosLoyaltyData["rewards"] })
  | (ProviderMessageBase & { type: "ATMOS_DISCOUNTS_DONE"; discounts: AtmosLoyaltyData["discounts"] })
  | (ProviderMessageBase & { type: "CHASE_DASHBOARD_DONE"; data: ChaseURData })
  | (ProviderMessageBase & { type: "CHASE_BENEFITS_DONE"; benefits: ChaseBenefit[] })
  | (ProviderMessageBase & { type: "CAPITALONE_REWARDS_DONE"; cardName: string | null; miles: number | null })
  | (ProviderMessageBase & { type: "CAPITALONE_BENEFITS_DONE"; benefits: CapitalOneLoyaltyData["benefits"] })
  | (ProviderMessageBase & { type: "AMEX_CARD_DONE"; data: AmexLoyaltyData })
  | (ProviderMessageBase & { type: "AMEX_ALL_DONE" })
  | (ProviderMessageBase & { type: "AWARDS_SCRAPED"; awards: unknown[] })
  | (ProviderMessageBase & { type: "SCRAPE_AWARDS" })
  | (ProviderMessageBase & { type: "BILT_PROGRESS_DONE"; progress: Record<string, unknown> })
  | (ProviderMessageBase & { type: "SCRAPE_PROGRESS" })
  | AbortSyncRunMessage
  | { type: "SIGN_IN_NEXTCARD" }
  | { type: "SIGN_OUT_NEXTCARD" }
  | { type: "GET_AUTH_STATE" }
  | { type: "PUSH_TO_NEXTCARD"; provider: ProviderId };
