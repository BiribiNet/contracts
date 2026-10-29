# DAI via USDC funding fix, local draft, 29 October 2026

Status: implemented and tested locally, including a disposable Arbitrum One fork. No live contracts, roles, addresses, balances, keeper configuration or indexers were changed. This folder is a reviewable draft, not a deployment journal.

## Intended behavior

Keep the project's existing USDC/BRB pool. Use the already existing external DAI/USDC pool to reach it. Do not create a DAI/BRB pool.

| Market asset | Path in the replacement |
| --- | --- |
| BRB | Distribute BRB directly, without calling a router |
| USDC | USDC -> BRB |
| DAI | DAI -> USDC -> BRB |

The deployed funder has no configurable path and cannot be upgraded in place. `contracts/RoutedBRBJackpotFunder.sol` is a separate version of the existing funder. The original source and its compiled runtime template are byte-for-byte unchanged, as recorded in `build-check.json`. Existing deployment scripts still deploy the original contract until a separate reviewed rollout is prepared.

The engine already exposes `setJackpotFunder(address)`. SideBet obtains the active funder from the engine at fee collection time. An engine or SideBet implementation upgrade is not needed for this fix.

## Contract changes

- The constructor adds fixed `routedAsset` (DAI) and `bridgeAsset` (USDC) addresses after the original six arguments. Zero, repeated and BRB route tokens are rejected. Operators can inspect the path with `fundingPath(asset)`. No caller supplies a path and there is no route setter.
- Direct USDC and BRB behavior is retained. Other assets retain a direct asset/BRB path; this draft does not add arbitrary routing for future markets.
- The worker bounds input against the configured fraction of **both** pools' input reserves. It converts the second pool's USDC cap back into a conservative DAI cap using the inverse constant-product formula. A small DAI/USDC pool or USDC/BRB pool therefore limits the whole trade.
- Price protection composes the existing executable TWAP/spot floor through both pools. It uses actual 18-decimal DAI and 6-decimal USDC units and never assumes stablecoin parity. The slippage allowance is applied once to the final BRB amount, not once per pool. If either pool activates its warm TWAP floor, the route uses `slippageBps`; otherwise it uses `coldSlippageBps`.
- `updateObservation(DAI)` observes both pools. The USDC/BRB oracle anchor is shared with direct USDC swaps, and the original anchor-rotation logic is retained.
- Missing or empty pools, a zero quote, a router failure or a failed isolated attempt leave credited input in the original market queue. Approvals are cleared after swaps. Queue attribution, accounting events, treasury/burn debts, cooldowns and the five-failure stop retain the original semantics.
- The isolated execution allowance rises from 500,000 to 850,000 gas. A first two-pool swap initializes more oracle storage and cannot reliably fit the old allowance. The Cloudflare keeper already supplies 1,500,000 gas per `processFunding` transaction. The standalone `runFundingKeeper.ts` now reads the deployed `ATTEMPT_GAS` for batch sizing and allows 400,000 gas for two-pool observation updates. Its write authorization gates are unchanged.

Normal bounded execution fails closed when any route pool is missing. The new funder also removes the old legacy router-only quote fallback when the factory pair cannot be found. Neither route used by the current markets needs that fallback.

## Validation

`test/RoutedBRBJackpotFunder.test.ts` contains 18 targeted tests. The combined regression run completed with **71 passing tests**, covering the original funder and queue, TWAP library, engine round settlement and SideBet economics as well as the replacement. The dedicated TypeScript check passes.

The targeted cases include real local Uniswap V2 swaps, both limiting-pool cases, missing and empty pools, manipulation of either hop after oracle warm-up, different token decimals and a changed DAI/USDC price, exact treasury/burn accounting, a mixed BRB/USDC/DAI batch, isolated market queues, dust retry exhaustion, admin reset, pending BRB debts and shared oracle rotation. A full DAI roulette round still pays 0.02 DAI infrastructure fees, queues 0.03 DAI and leaves 0.95 DAI of the 1 DAI house profit in the vault. A second integration case places a DAI side bet before switching funders, then confirms its loss settles into the replacement with the same fees rather than the cached old funder.

`fork-rehearsal.json` records a local fork at Arbitrum block **519439325** using:

- DAI/USDC: `0x8edd9aEABdf2e63f76f4c4B7F36AEFa14D3cC6BC`
- USDC/BRB: `0x848A51FaD11746bca839DF587C3Cde450bDfb853`
- DAI/BRB: no pool

On that fork, 0.03 DAI produced **2.972516837070182065 BRB**. The quote matched the actual output, treasury payment and burn. Cold DAI processing consumed 675,419 gas; warm DAI processing consumed 373,176 gas. USDC swaps and direct BRB distribution also passed. Engine implementation storage, round state and all three bank token balances stayed unchanged after switching the funder pointer locally. Runtime size is 17,625 bytes, below EIP-170's 24,576-byte limit.

The fork uses the standalone key-free Hardhat configuration, local test accounts and local impersonation only. Its public RPC gateway rejects transaction submission; the attempted submission in the report is an intentional rejection test. Addresses and transaction hashes labelled local in the report do not identify live deployments or live transactions.

Reproduce from the contract repository:

```sh
REPORT_GAS=false node node_modules/hardhat/internal/cli/cli.js test test/RoutedBRBJackpotFunder.test.ts test/BRBJackpotFunder.test.ts test/FundingQueue.test.ts test/UniswapV2TwapLib.test.ts test/E2EUpkeepFlow.test.ts test/SideBetEconomics.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.routed-funder.json
node node_modules/hardhat/internal/cli/cli.js run --no-compile --config hardhat.fork-only.config.ts scripts/rehearseRoutedFunderFork.ts
```

The fork command pins a fresh public block by default; `ARBITRUM_FORK_BLOCK` can select a block where the public RPC still serves historical state. The first attempt against an older sequencer snapshot was unavailable; the successful run used a fresh snapshot with public-node fallback. This was an RPC availability issue, not a contract test failure.

## Old queued DAI is a separate unresolved deployment decision

The old funder at `0xa55e108b9ae4f50b2d63ea94a3d2c48add969e4e` still owns **0.03 DAI** credited to market 3. The fork confirmed the balance and queue remain unchanged. Its `sweepToken` subtracts queued assets, so the administrator cannot move those tokens to a replacement. Its router and direct path are immutable. A new contract cannot introduce a withdrawal method into the old contract.

Do not claim these tokens were migrated, import unbacked credit into the replacement, or credit the old 0.03 DAI again from a balance that does not exist. The replacement fixes future DAI funding. The old queue must remain explicitly recorded and backed on the old address until a separately reviewed recovery solution exists. Under the current direct-only code, processing that queue would require usable direct DAI/BRB liquidity; this draft creates no such pool. An independently funded make-up contribution would not recover the original tokens and is not included or authorized by this draft.

This residual must be acknowledged in the final cutover plan before deployment. The older `scripts/rolloutReviewedPrs.ts` is unsuitable: it performs an unrelated engine upgrade and assumes retained token balances can be swept. Do not reuse it for this change.

## Proposed cutover, not executed

1. Review this contract delta and the old queue decision. Refresh the live state and all market ledgers before preparing transactions. Flush any normally processable old BRB/USDC queues, reconcile all pending treasury/burn debts and retain an explicit record of any old residuals.
2. Deploy the replacement with the current engine, BRB token, router, jackpot treasury, SideBet and intended admin, plus native DAI and native USDC. Copy the **live** fee, split, slippage, TWAP-window and maximum-reserve settings; do not assume deployment defaults still match. Preserve intended role holders and verify source/runtime and every immutable.
3. Call `updateObservation(DAI)` on the replacement and allow the configured oracle window to mature before enabling new funding. Check both actual pool reserves, caps and quotes again. The local fork demonstrates functionality for its snapshot, not guaranteed future liquidity or prices.
4. Prepare the keeper bundle and all consumers for the new address. Keep the old funder's historical event coverage and add the new address at its deployment block to the subgraph/Goldsky event source and frontend deployment metadata. The old history must not disappear when counters begin at zero on the replacement. The keeper should track old residuals separately, without trying the stopped DAI queue indefinitely.
5. Quiesce keeper submissions and reconcile its persisted pending transaction before changing addresses. Use `ENGINE_FEE_ROLE` to call only `setJackpotFunder(newAddress)` on the existing engine. No engine proxy upgrade or vault operation is part of this change. Switch the keeper configuration in the same controlled cutover, then resume it.
6. Verify engine and SideBet fee collection targets the replacement, all existing round/payout/withdrawal behavior remains intact, new queue entries drain, router allowances clear and real BRB output reconciles with treasury and burn transfers. Verify the infrastructure recipient still receives its separate fee and the old 0.03 DAI remains accounted for at the old address.
7. Record the deployment and cutover blocks and hashes. If rollback is needed, stop the new keeper, reconcile its pending transaction and restore the old pointer/configuration. Preserve every queue on both contracts; rolling the pointer back does not move funds and also restores the old DAI routing limitation. Never sweep balances against a stale ledger snapshot.

No live rollout transaction builder, signer invocation, deployment or publication has been added to this draft.
