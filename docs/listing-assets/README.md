# Biribi listing and brand resources

Public reference for directory editors, ecosystem reviewers and analytics teams. Reviewed **24 October 2026**. Use [the infrastructure overview](https://biribi.net/infrastructure) to explain the model and [the repository overview](../../README.md) for deployment references and integration caveats.

## Project details

| Field | Value |
| --- | --- |
| Project | Biribi / biribi.net |
| Token | BRB |
| Network | Arbitrum One, chain ID 42161 |
| Categories | Gambling / roulette; risk-bearing bankroll vaults / DeFi |
| Website | https://biribi.net |
| Explanation and evidence | https://biribi.net/infrastructure |
| Whitepaper | https://biribi.net/whitepaper |
| Public deployment discovery | https://biribi.net/.well-known/dapp-manifest.json |
| Official X | https://x.com/biribitoken |
| Professional contact | [info@biribi.net](mailto:info@biribi.net) |

## Reusable descriptions

**Short:** Biribi is an on-chain roulette protocol on Arbitrum One with separate BRB, native USDC and DAI bankroll vaults. 18+. Bets and deposited capital can be lost.

**Extended:** Biribi connects on-chain roulette players with liquidity providers on Arbitrum One. BRB, native USDC and DAI each have a separate bankroll vault. Depositors finance the bank and share its variable results, including losses. Chainlink VRF provides randomness; requests, results and payments have separate transaction evidence. Withdrawals are queued, subject to liquidity and processing conditions, and fees apply. The vaults are ERC-4626-based with partial compatibility, requiring adaptation for synchronous withdrawal integrations. Public source is not an independent audit. No guaranteed yield, capital protection or gambling authorization is asserted. 18+; applicable-law restrictions apply.

## Official logos

- [200 × 200 SVG chip](biribi-logo-200.svg) and [200 × 200 PNG chip](biribi-logo-200.png).
- [400 × 400 PNG chip](biribi-logo-400.png), rendered from the same official SVG on 29 October 2026 for directory requirements. Geometry, #6478ff accent and transparent background preserved.
- [40 × 40 SVG chip](https://biribi.net/marketing/biribi-icon-40.svg) for directories requiring that size.

The supplied chip geometry is the official logo. The accent is **#6478ff**, with dark **#0d0d0f** and foreground **#f0f1f5** used by the site. Preserve the geometry and aspect ratio; use these assets rather than generating a substitute.

## Supply and burn interpretation

[BRB supply disclosure](brb-supply-disclosure.json) contains the initial allocation and an explicitly dated **21 October 2026** snapshot. It is not a live supply API or an aggregator-certified circulating supply. Initial pool allocation is not the current pool balance. Re-read chain state at a common block before publishing current figures; do not infer vesting or a liquidity lock from an initial allocation.

The reference allocation directs **0.5% of positive house profit** toward BRB burn. Conversion, queues and rounding can delay execution; parameters are configurable. An allocated amount is not completed destruction, and a very small completed burn is not evidence of a failed burn mechanism. Do not promise a nonzero BRB burn on every spin or infer a token price effect.

## Editorial limits

Describe roulette and game-loss exposure explicitly. “Staking” here means supplying bankroll liquidity. A vault's accounting value, gross custody, available liquidity and personal return are different measures. Revenue allocation is not personal APY. Do not add unverified prices, TVL, trading volumes, audit badges, partner endorsements, licence claims or approval dates. A received listing application is not a published listing.
