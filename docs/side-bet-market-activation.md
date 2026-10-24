# Side Bet availability in every market

The SideBet configuration is market specific. A config in BRB does not make the same rule playable in USDC or DAI. `addConfig` creates an offer with zero stake limits; `setConfigStakeLimits` opens it. The vault must be able to cover the payout of a maximum size bet, including existing roulette liabilities. The frontend cannot safely open an offer with zero limits.

## Current evidence and scope

The 2026-10-16 mainnet stablecoin audit (`reports/release/arbitrum-one-stablecoin-markets-2026-10-16.json`) recorded `totalAssets = 0` and `totalShares = 0` for both USDC market 2 and DAI market 3. This is a historical snapshot, not a live balance. Check current onchain liquidity and config limits before acting. The stablecoin banks are deployed and wired, but their deployment alone does not fund them.

The goal is to make every **reviewed, supported** SideBet template playable in each registered market. Compare the active BRB catalogue with USDC and DAI after seeding, and separately review any offer that is outside the `legacy` and `x100` seed catalogues. A matching name in the interface does not establish that the rules, multiplier, or stake limits match.

## Read only preparation

1. Run the deployment audit and record current bank assets, shares, locked roulette liquidity, SideBet liquidity, and config limits for markets 1, 2, and 3. Confirm the roulette worker, compatible SideBet settlement implementation, timeout, and VRF state are healthy.
2. From the contracts repository, run `SEED_CATALOGUE=legacy SEED_MARKET_IDS=2,3 yarn seed:side-bets:arbitrum` as a dry run. Repeat with `SEED_CATALOGUE=x100`. On PowerShell, set these as `$env:SEED_CATALOGUE` and `$env:SEED_MARKET_IDS` before each command. Do not set `SEED_APPLY` for a dry run.
3. Save the output for each offer. The script reports the available liquidity after roulette need, the proposed minimum and maximum stake, and a required deposit estimate when an offer cannot open. Use the largest required amount for each asset, plus operational headroom; funding one low multiplier offer does not guarantee the full catalogue.
4. Review DAI's DAI/BRB conversion route and each market's jackpot funding path before accepting real bets. Verify the operator has the needed SideBet config and limits roles and gas for the planned transactions.

## Fund and activate

1. A funded, authorized owner deposits real USDC into the USDC `BankVault4626` and real DAI into the DAI `BankVault4626`, receiving vault shares. Recheck balances and available liquidity after the deposits. `scripts/seedBankVaultLiquidity.ts` uses test tokens and the Arbitrum Sepolia manifest; it is **not** a mainnet funding command.
2. Repeat both dry runs. Require zero liquidity skips for the intended catalogue and review every proposed max stake. Keep the default 20% safety budget unless a separate risk review approves another value.
3. After review, the authorized signer can run the same seed command for each catalogue with `SEED_APPLY=true` and `SEED_MAINNET_CONFIRM` set to the SideBet proxy address from `deployments/arbitrum-one.json`. The script checks roles and settlement compatibility before any broadcast. It creates missing configs, then opens limits only where liquidity supports them. Keep `SEED_RETIRE_LEGACY` unset unless replacements and migration have been reviewed.
4. Read back every active config by market. Compare rule fields, multiplier, and positive min/max limits with the reviewed catalogue, and verify that the maximum stake is still backed after roulette need. Exercise a bounded acceptance bet and its settlement in each asset before declaring that market available.
5. Check the public Side Bets page with BRB, USDC, and DAI selected. Every intended family should have a valid stake range and an enabled placement path. Monitor vault capacity and config availability as bets reserve liquidity.

Do not mark USDC or DAI available solely from a frontend change or from a successful `addConfig` transaction. Funding and limit activation are separate onchain steps.
