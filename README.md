<img width="1920" height="926" alt="Screenshot 2026-04-16 at 6 19 57 PM" src="https://github.com/user-attachments/assets/c4104cfe-e222-440e-b93f-ce2b63675a88" />


# nextcard sync

nextcard sync helps you find and add eligible card offers, get reminders while you shop, and connect loyalty accounts to your [nextcard](https://nextcard.com) wallet.

## Card offers

Check supported Chase, American Express, and Citi cards for eligible offers, review the card-specific results, and explicitly choose which offers to add. Capital One shopping offers can be found and saved for tracking. Your current card-linked offers appear in the extension with their eligible card. When you visit a matching merchant site, the extension shows a reminder for active offers. The extension never stores issuer passwords or verification codes.

## Supported providers

**Hotels** — Marriott Bonvoy, World of Hyatt, Hilton Honors, IHG One Rewards

**Airlines** — American Airlines AAdvantage, Delta SkyMiles, United MileagePlus, Southwest Rapid Rewards, Alaska Atmos, Frontier Miles

**Credit cards** — Chase, American Express, Capital One, Citi, Discover, Bilt Rewards

## What it syncs

- Points and miles balances
- Elite status and tier progress
- Credit card benefit usage (dining credits, airline credits, etc.)
- Member name and number

## How it works

1. Sign in to nextcard from the extension
2. Tap "Sync" on any provider
3. Log in to your account when the tab opens
4. Your data appears in the extension and syncs to your nextcard wallet

## Privacy & security

- We never see or store your login credentials
- Data is read from the page only after you sign in
- All data is transmitted securely to your nextcard account
- No background tracking — syncs only when you initiate

## Tools

The extension also includes offer enrollment and offer discovery tools for supported credit card providers — it finds available merchant offers across your cards and helps you add or track them automatically.

## Install

Download the latest `.zip` from [Releases](https://github.com/affil-ai/nextcard-sync/releases), unzip it, then load it in Chrome via `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select the unzipped folder.

Safari requires a containing app. The same Safari build is packaged into macOS and iOS app targets. Users enable the extension in Safari after installing the containing app.

## Development

```
pnpm install
pnpm dev        # watch mode (builds to dist-dev/)
pnpm build      # production build (builds to dist/)
pnpm build:safari    # Safari web extension resources (builds to dist-safari/)
pnpm package:safari  # macOS + iOS Xcode project (builds to .safari-build/)
```

`pnpm package:safari` requires macOS and Xcode. It creates these schemes:

- `nextcard (macOS)` contains the extension for Mac Safari.
- `nextcard (iOS)` contains the extension for iPhone and iPad Safari.

Open `.safari-build/nextcard/nextcard.xcodeproj` to run either scheme. The generated project is disposable. Change the shared web extension in `src/`, then regenerate it. Do not edit generated files in `.safari-build/`.

For a release, set the Affil Apple Developer team and final App Store bundle identifiers in Xcode. The generated iOS extension target can also be embedded in the main nextcard iOS app instead of using the generated iOS containing app.

### Safari compatibility

Chrome and Safari use the same popup HTML, CSS, TypeScript, backend API, offer storage, issuer content scripts, and merchant reminder. Chrome opens the UI in its side panel. Safari opens that same UI from its toolbar button because Safari does not implement Chrome's side panel API. The Safari build also creates a classic, self-contained background worker and removes manifest keys that Safari does not support.

## Development details

Each provider has a content script that runs on the provider's website. When you start a sync, the extension opens the provider's site, waits for you to log in, then reads your account data from the page. No credentials are ever accessed or stored — the extension only reads data that's already visible after you sign in.

Scraped data is validated against Zod schemas and pushed to the nextcard API.

## License

MIT
