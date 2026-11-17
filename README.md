<img src="https://raw.githubusercontent.com/BiribiNet/contracts/d2fb7981f6aeafea22c9683d8871badc3fa04c6e/docs/listing-assets/biribi-logo-200.png" alt="Biribi chip logo" width="80" height="80">

# Biribi smart contracts

Biribi is an onchain roulette protocol on **Arbitrum One**. Players share a roulette draw and bet in BRB, native USDC, or DAI. Each asset has a separate bankroll vault. This repository contains the Solidity contracts, tests, and mainnet deployment records.

🎡 [Explore Biribi](https://biribi.net) · 📖 [Game rules](https://biribi.net/biribi-rules) · 🔎 [Onchain evidence](https://biribi.net/infrastructure) · 📄 [Whitepaper](https://biribi.net/whitepaper) · 💬 [Suggest a market](#suggest-a-market)

**18+. Bets and deposited capital can be lost.** Vault returns vary and can be negative. Availability depends on local law.

## Arbitrum One addresses

**Chain ID `42161`** · [Deployment manifest](deployments/arbitrum-one.json) · [ABI snapshot](deployments/arbitrum-one-abi.json)

Contract addresses and market mappings were checked onchain at [block 524998119](https://arbiscan.io/block/524998119) on 17 November 2026. Look up current liquidity, fees, and available bets in the app or onchain.

### Market tokens and vaults

Each vault accepts deposits and pays roulette winnings in its market's token. Use these vault proxy addresses when interacting with the bankroll.

| Market ID | Asset | Token address | Bankroll vault proxy |
| --- | --- | --- | --- |
| 1 | BRB | [`0x58871cf545f8F0dF790443492a80EdC414df4504`](https://arbiscan.io/address/0x58871cf545f8F0dF790443492a80EdC414df4504) | [`0x5F9332b04b2590850c7681850cA445dDF7f64aa9`](https://arbiscan.io/address/0x5F9332b04b2590850c7681850cA445dDF7f64aa9) |
| 2 | USDC (native) | [`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`](https://arbiscan.io/address/0xaf88d065e77c8cC2239327C5EDb3A432268e5831) | [`0x46206B1C1fc631Fd6Fcf2Aa2503f9cb022dA96bA`](https://arbiscan.io/address/0x46206B1C1fc631Fd6Fcf2Aa2503f9cb022dA96bA) |
| 3 | DAI | [`0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1`](https://arbiscan.io/address/0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1) | [`0x137dD55e422b1881Ad1566ce21E2E4F393bB37B2`](https://arbiscan.io/address/0x137dD55e422b1881Ad1566ce21E2E4F393bB37B2) |

### Protocol contracts

| Contract | Address on Arbiscan | Role |
| --- | --- | --- |
| [Roulette engine](contracts/RouletteEngine.sol) | [`0xfC6474D1594952EF5BEB779b97BA69198b4e7625`](https://arbiscan.io/address/0xfC6474D1594952EF5BEB779b97BA69198b4e7625) | Upgradeable proxy for rounds, randomness, and settlement |
| [Market registry](contracts/MarketRegistry.sol) | [`0x2AFd5402FAeB550045aEA5884BCf33409a91679A`](https://arbiscan.io/address/0x2AFd5402FAeB550045aEA5884BCf33409a91679A) | Maps each market ID to its token and vault |
| [Side bets](contracts/SideBet.sol) | [`0x96e34298425c310422bFba424Bd4ed455b597D7f`](https://arbiscan.io/address/0x96e34298425c310422bFba424Bd4ed455b597D7f) | Upgradeable proxy for separate bets on roulette outcomes |
| [Side-bet evaluator](contracts/SideBetChallengeEvaluator.sol) | [`0x36Ac820FC931307bDF61dCc990A7Fe470dB72e74`](https://arbiscan.io/address/0x36Ac820FC931307bDF61dCc990A7Fe470dB72e74) | Applies the rules for side-bet challenges |
| [Jackpot treasury](contracts/JackpotTreasury.sol) | [`0x2A7c5023581F2A5c75D699cF3A7f0c37d7919EaE`](https://arbiscan.io/address/0x2A7c5023581F2A5c75D699cF3A7f0c37d7919EaE) | Holds the BRB jackpot funds |
| [Jackpot funder](contracts/BRBJackpotFunder.sol) | [`0xd0083c4D3056F6D2bb2b98aEB4FEe0DD36C3bDB5`](https://arbiscan.io/address/0xd0083c4D3056F6D2bb2b98aEB4FEe0DD36C3bDB5) | Processes fee allocations and conversions for jackpot funding |
| [Upkeep scheduler](contracts/UpkeepScheduler.sol) | [`0xcf0c459014ffBa7DCc9026f15D5ADE1351092ef2`](https://arbiscan.io/address/0xcf0c459014ffBa7DCc9026f15D5ADE1351092ef2) | Coordinates automated round and settlement tasks |
| [Execution authority](contracts/CreExecutionAuthority.sol) | [`0xc5C5A4b77652BA88853a1C3Ad4C6b04891ddd601`](https://arbiscan.io/address/0xc5C5A4b77652BA88853a1C3Ad4C6b04891ddd601) | Controls which executors can submit upkeep |
| Vault beacon | [`0x7b23cCdDB62B982245c50BdAAF1D13B3d12D632b`](https://arbiscan.io/address/0x7b23cCdDB62B982245c50BdAAF1D13B3d12D632b) | Points to the implementation shared by all three vault proxies |
| [Referral contract](contracts/BRBReferal.sol) | [`0x6d19c9d21CE7b2670fC5f142f27d9819DD888544`](https://arbiscan.io/address/0x6d19c9d21CE7b2670fC5f142f27d9819DD888544) | Handles referral records and accounting |
| [Tip jar](contracts/TipJar.sol) | [`0xa65aD745721B0F1382653328b837EF75f79b99ce`](https://arbiscan.io/address/0xa65aD745721B0F1382653328b837EF75f79b99ce) | Processes optional tips |

## Suggest a market

Anyone can suggest a token for a new Biribi roulette market. [Check existing issues](https://github.com/BiribiNet/contracts/issues) to see if someone has already suggested it, then comment there or [open a new issue](https://github.com/BiribiNet/contracts/issues/new) titled `Market suggestion for TOKEN`. You can also send your suggestion through [Biribi support](https://biribi.net/support).

- Include the token name, symbol, and Arbitrum One contract address.
- Explain why players would want to use it at the table.
- If you have them, share links to existing liquidity, ideas for funding the initial bankroll, and details of any token transfer fees or restrictions.

Registering a market onchain requires the `MARKET_FACTORY_ROLE` on the [Market Registry](contracts/MarketRegistry.sol).

## Verify a draw or payout

1. **Find the request.** The roulette engine's `VrfRequested` event links a round ID to a request ID.
2. **Check the result.** The [Chainlink VRF coordinator](https://arbiscan.io/address/0x3C0Ca683b403E37668AE3DC4FB62F4B29B6f7a3e) verifies the cryptographic proof onchain. The engine records the winning number in a `VRFResult` event for the round.
3. **Confirm the payment.** In the settlement transaction, look for the market token's `Transfer` event from the vault to the winning wallet. For a jackpot payment, look for a BRB transfer from the jackpot treasury.

See [Chainlink VRF documentation](https://docs.chain.link/vrf) for how proofs are generated and verified.

## Provide bankroll liquidity

Depositors receive shares in their chosen market's [bankroll vault](contracts/BankVault4626.sol) and are exposed to that vault's profits and losses. Withdrawals enter a queue, incur fees, and depend on available liquidity and settlement processing.

The vaults use ERC-4626 share accounting with partial ERC-4626 compatibility. Both `withdraw` and `redeem` enqueue a request. Integrations should track the request through processing and confirm the resulting token transfer.

## Build and integrate

Start with `MarketRegistry.getMarket(marketId)` to discover the vault and token for a market. Use the proxy addresses above for the engine, side bets, and vaults. The engine's `JACKPOT_FUNDER()` getter returns its current funder. Before integrating, check the ABI snapshot's source revision against the active proxy or beacon implementation and read the current roles and configuration onchain.

The local Hardhat suite uses Node.js 22 and Corepack.

```sh
git clone https://github.com/BiribiNet/contracts.git
cd contracts
corepack enable
yarn install --immutable
yarn hardhat compile
REPORT_GAS=false yarn hardhat test
```

| Resource | What it covers |
| --- | --- |
| [Solidity source](contracts/) and [tests](test/) | Contract behavior and regression coverage |
| [Deployment guide](DEPLOY.md) and [deployment records](deployments/) | Network setup, release history, and verification records |
| [Distribution design](docs/distribution-v2.md) | Fee allocation, conversions, and jackpot funding |
| [Listing and brand resources](https://github.com/BiribiNet/contracts/tree/d2fb7981f6aeafea22c9683d8871badc3fa04c6e/docs/listing-assets) | Official artwork and listing information |

## Security and contact

Privileged roles can upgrade contracts and change protocol parameters. Explorer source verification checks that published source matches deployed bytecode. See the [historical security review](AUDIT.md) for its scope and findings.

For security reports and integration questions, contact [info@biribi.net](mailto:info@biribi.net). For help using the app, visit [Biribi support](https://biribi.net/support).

## License

[MIT](LICENSE)
