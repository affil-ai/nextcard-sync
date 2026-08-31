import "./popup.css";
import "./app";
import { initializeCardLinkedOffers } from "./card-linked-offers";

document.documentElement.classList.toggle("safari-extension", __SAFARI__);
void initializeCardLinkedOffers();
