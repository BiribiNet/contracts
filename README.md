<img src="docs/listing-assets/biribi-logo-200.svg" alt="Biribi official chip logo" width="80" height="80">

# Biribi — on-chain roulette on Arbitrum

Biribi connects roulette players with separate BRB, native USDC and DAI bankroll vaults on **Arbitrum One (chain ID 42161)**. This repository contains the public smart contract source and deployment records.

[Website](https://biribi.net) · [How it works and public evidence](https://biribi.net/infrastructure) · [Whitepaper](https://biribi.net/whitepaper) · [Official X](https://x.com/biribitoken) · [Contact](mailto:info@biribi.net)

**18+. Bets and deposited capital can be lost. Vault returns are variable and may be negative.** Availability is subject to applicable law; neither this repository nor an ecosystem listing establishes gambling authorization.

## Players, liquidity providers and evidence

- **Players** place roulette bets through smart contracts. A Chainlink VRF request, the random result and a payment are separate events: a winning number alone does not prove that a wallet was paid.
- **Liquidity providers**, called stakers in the app, supply the game's bankroll. Each asset has its own vault and share accounting. This is game liquidity provision, with exposure to the bank's profits and losses.
- **Reviewers** can inspect [the infrastructure page](https://biribi.net/infrastructure), [public deployment manifest](https://biribi.net/.well-known/dapp-manifest.json) and explorer records without connecting a wallet. The [French overview](https://biribi.net/fr/infrastructure) explains the same model.

Withdrawals are queued, depend on available liquidity and settlement/processing conditions, and incur fees. `BankVault4626` is ERC-4626-based, with **partial compatibility**: `withdraw` and `redeem` enqueue requests rather than transferring assets synchronously. Generic synchronous ERC-4626 integrations need adaptation. A withdrawal request or a share-accounting value is not proof of payment or immediately available cash.

Privileged roles, upgrade paths and configurable parameters are part of the trust model. Public source and explorer source verification are **not an independent audit**, a solvency guarantee or capital protection.

## Arbitrum One reference addresses

These addresses were cross-checked on **24 October 2026** against [the repository deployment record](deployments/arbitrum-one.json) and [the site's discovery manifest](https://biribi.net/.well-known/dapp-manifest.json). They identify deployment entries, not current liquidity, enabled betting offers or verified present-day implementations. Check current chain state before integrating or transacting.

| Component | Arbitrum One address |
| --- | --- |
| BRB token | [0x58871cf545f8f0df790443492a80edc414df4504](https://arbiscan.io/address/0x58871cf545f8f0df790443492a80edc414df4504) |
| Roulette engine | [0xfc6474d1594952ef5beb779b97ba69198b4e7625](https://arbiscan.io/address/0xfc6474d1594952ef5beb779b97ba69198b4e7625) |
| Market registry | [0x2afd5402faeb550045aea5884bcf33409a91679a](https://arbiscan.io/address/0x2afd5402faeb550045aea5884bcf33409a91679a) |
| BRB bankroll vault | [0x5F9332b04b2590850c7681850cA445dDF7f64aa9](https://arbiscan.io/address/0x5F9332b04b2590850c7681850cA445dDF7f64aa9) |
| Native USDC bankroll vault | [0x46206B1C1fc631Fd6Fcf2Aa2503f9cb022dA96bA](https://arbiscan.io/address/0x46206B1C1fc631Fd6Fcf2Aa2503f9cb022dA96bA) |
| DAI bankroll vault | [0x137dD55e422b1881Ad1566ce21E2E4F393bB37B2](https://arbiscan.io/address/0x137dD55e422b1881Ad1566ce21E2E4F393bB37B2) |

Repository source may include changes not deployed on this network. Match the deployed implementation, ABI, roles and parameters to a specific revision; do not infer a live upgrade from a merge. The deployment files also retain dated historical observations.

## Source and integration starting points

| Resource | Purpose |
| --- | --- |
| [RouletteEngine.sol](contracts/RouletteEngine.sol) | Round lifecycle, randomness and settlement |
| [BankVault4626.sol](contracts/BankVault4626.sol) | Per-market bankroll, shares and withdrawal queue |
| [MarketRegistry.sol](contracts/MarketRegistry.sol) | Market and vault discovery |
| [SideBet.sol](contracts/SideBet.sol) | Side-bet module; inspect current configuration and liquidity separately |
| [Distribution v2](docs/distribution-v2.md) | Funding, conversion queues and reconciliation design; deployment must be checked separately |
| [Listing and brand resources](docs/listing-assets/README.md) | Reusable factual copy, official logos and supply disclosure |
| [Deployment and release records](deployments/) | Network manifests and dated evidence |

For analytics or listing questions, contact **[info@biribi.net](mailto:info@biribi.net)**. An analytics listing does not establish transaction compatibility, endorsement or an audit.

## License

The code in this repository is available under the [MIT License](LICENSE).
