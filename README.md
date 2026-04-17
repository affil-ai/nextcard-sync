<img width="1920" height="926" alt="Screenshot 2026-04-16 at 6 19 57 PM" src="https://github.com/user-attachments/assets/c4104cfe-e222-440e-b93f-ce2b63675a88" />


# nextcard sync

Chrome extension that syncs your loyalty program balances, elite status, and credit card benefits to your [nextcard](https://nextcard.com) wallet.

## Supported providers

**Hotels** — Marriott Bonvoy, World of Hyatt, Hilton Honors, IHG One Rewards

**Airlines** — American Airlines, Delta SkyMiles, United MileagePlus, Southwest Rapid Rewards, Alaska Mileage Plan, Frontier Miles

**Banks** — Chase, American Express, Capital One, Citi, Discover, Bilt Rewards

## Tools

The extension also includes one-click offer enrollment for Chase, Amex, and Citi — it finds all available merchant offers across your cards and adds them automatically.

## Install

Download the latest `.zip` from [Releases](https://github.com/affil-ai/nextcard-sync/releases), unzip it, then load it in Chrome via `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select the unzipped folder.

## Development

```
pnpm install
pnpm dev        # watch mode (builds to dist-dev/)
pnpm build      # production build (builds to dist/)
```

## How it works

Each provider has a content script that runs on the provider's website. When you start a sync, the extension opens the provider's site, waits for you to log in, then reads your account data from the page. No credentials are ever accessed or stored — the extension only reads data that's already visible after you sign in.

Scraped data is validated against Zod schemas and pushed to the nextcard API.

## License

MIT
