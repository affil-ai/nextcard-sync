import "./popup.css";
import { mountDoorDashProvider } from "./doordash";
mountDoorDashProvider();
import { updateBofaOffersSetup, requestBofaOfferCheck, areOtherOfferToolsBusy } from "./app";

import { initializePinReminder } from "./pin-reminder";
initializePinReminder();

import { mountBofaOffers } from "./bofa-offers";
mountBofaOffers({ onStateChange: updateBofaOffersSetup, requestCheck: requestBofaOfferCheck, otherToolsBusy: areOtherOfferToolsBusy });
