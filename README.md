<img width="1920" height="926" alt="Screenshot 2026-04-16 at 6 19 57 PM" src="https://github.com/user-attachments/assets/c4104cfe-e222-440e-b93f-ce2b63675a88" />


# nextcard sync

nextcard sync connects your loyalty accounts and credit cards to your [nextcard](https://nextcard.com) wallet — giving you a single view of all your points, miles, elite status, and benefit credits.

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

## Development

```
pnpm install
pnpm dev        # watch mode (builds to dist-dev/)
pnpm build      # production build (builds to dist/)
```

## Development details

Each provider has a content script that runs on the provider's website. When you start a sync, the extension opens the provider's site, waits for you to log in, then reads your account data from the page. No credentials are ever accessed or stored — the extension only reads data that's already visible after you sign in.

Scraped data is validated against Zod schemas and pushed to the nextcard API.

## License

MIT
