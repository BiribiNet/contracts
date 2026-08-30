# Contracts security audit — status

Original audit: `biribinet/contracts @ markets` (`045b14c9`), static review only.
This document has since been **re-verified line by line against `master`** and rewritten
to record current status rather than the state at audit time.

Every status below was checked against the code on `master`. Where a finding is marked
resolved, the entry names what resolves it. Where a finding turned out to be wrong, or to
describe code that no longer exists, it says so — a stale audit is bad, one that is
confidently wrong is worse, and several entries here were quietly leading readers to
"fix" things that had already been deleted.

**Status legend**

| | Meaning |
|---|---|
| **OPEN** | Still reachable on `master`. Needs a decision. |
| **RESOLVED** | Fixed. The entry names the fix. |
| **OBSOLETE** | The code it describes no longer exists. Nothing to do. |
| **NEVER VALID** | The finding was incorrect when written. |

> ⚠️ **Coverage gap — read this first.** This audit predates two major subsystems and
> assesses **neither**: `contracts/SideBet.sol` (UUPS-upgradeable, holds `SETTLEMENT_ROLE`,
> locks vault liquidity through `lockSideBetStake`, collects protocol fees) and the whole
> Chainlink CRE stack (`AutomationReceiver`, `ReceiverTemplate`, `CreExecutionAuthority`,
> `cre/workflows/`). Roughly a third of the current attack surface is simply absent from
> this document. Defects have been found and fixed in both since — see
> *Fixed after the audit* — but they were found ad hoc, not by a review pass.

---

## Open findings

### C-4b — No pause anywhere in the protocol
**Severity: Critical.** There is no `pause()`, no `whenNotPaused`, no kill switch: a repo-wide
grep for `Pausable|function pause|whenNotPaused|paused()` returns nothing. `recordBet`
(`RouletteEngine.sol:329`) has no phase-independent stop, so a live exploit cannot be halted.

Both workarounds the original finding proposed are now **hard-reverted**, which narrows the
options rather than widening them:
- `UpkeepScheduler.sol:99` — `if (newScanLimit == 0) revert InvalidScanLimit();`
- `UpkeepScheduler.sol:93` — `if (newAuthority == address(0)) revert ZeroAddress();`

Remaining levers: `CreExecutionAuthority.setExecutorApproved(receiver, false)`
(`CreExecutionAuthority.sol:28`) halts *settlement* but not bet intake, and
`BankVault4626.setMinBet(huge)` (`:198`) is a soft per-market intake fence. Neither is an
engine-wide stop. Now that the engine is UUPS (see C-4a), a pause is a normal upgrade.

### H-4 — `MarketRegistry.setVaultBeacon` has no timelock
**Severity: High.** `MarketRegistry.sol:54`, `MARKET_FACTORY_ROLE`, no delay, and it
retroactively upgrades **every** vault (`:116`, `new BeaconProxy(beacon, initData)`). It gained
sanity checks only (`:55-58`: non-zero, has code, `implementation()` responds).

`ProtocolTimelock` exists (`contracts/ProtocolTimelock.sol`) and is tested, but **it is not
deployed or wired by anything** — `grep -rn "ProtocolTimelock" scripts/ ignition/` returns
nothing, and `scripts/deployProtocolArbitrum.ts:192` gives beacon ownership to `protocolAdmin`
directly. The original H-12 ("`DELAY = 24 hours` is too short") is folded in here: lengthening a
delay nothing routes through changes nothing. **Wire the timelock first, then pick a delay.**

*The `setEngine` half of the original finding is obsolete — `MarketRegistry.ENGINE` is
`immutable` (`:19`) and no setter exists.*

### H-6 — Permanent admin-key blast radius
**Severity: High.** Every privileged role still holds unilateral, undelayed power, and the
surface has **grown** since the audit: `DEFAULT_ADMIN_ROLE` now authorizes UUPS upgrades of the
engine (`RouletteEngine.sol:240`), `ENGINE_FEE_ROLE` re-points the jackpot funder and treasury
(`:302`, `:311`), and `EXECUTOR_ADMIN_ROLE` controls who may drive `performUpkeep`. Also
`BANK_ADMIN_ROLE` (`BankVault4626.sol:174`, `:198`), `FUNDER_ADMIN_ROLE`
(`BRBJackpotFunder.sol:129-169`), `MARKET_FACTORY_ROLE`, `SCHEDULER_ADMIN_ROLE`.

A concrete instance: `setSlippageBps` / `setColdSlippageBps` only reject `bps >= BPS_DENOM`
(`BRBJackpotFunder.sol:143`, `:149`), so an admin can set 9999 bps and restore an effectively
zero swap floor — undoing C-1 without an upgrade.

`DEPLOY.md` requires a production multisig for `PROTOCOL_ADMIN`, which is partial mitigation.
There is still no timelock in any privileged path and no documented role-transfer process.

### H-7 — `tx.gasprice`-based VRF key-hash selection
**Severity: High → Medium.** `RouletteEngine.sol:745-747` still picks the VRF lane from
`tx.gasprice`. Reachability is now much narrower than when written: `_triggerVrf` is private,
reached only from `executeJob` (`:672-674`) which is `onlyScheduler` (`:182-185`), behind an
approved CRE executor. The actor choosing the lane is the CRE DON, not an arbitrary caller. It
remains a settlement-delay vector under a misconfigured or adversarial DON, with no on-chain
recourse. Downgraded on reachability, not on mechanism.

### H-9 — `placeBet` is not fee-on-transfer-safe
**Severity: High → Medium (misconfiguration hazard, not attacker-triggerable).**
`BankVault4626.sol:226-233` locks and records the **nominal** amount, then transfers:

```solidity
$.lockedBetLiquidity += amount;                                   // nominal
$.ENGINE.recordBet($.marketId, msg.sender, amount, betData, referral);
IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);  // may deliver less
```

Neither mitigation exists: no received-delta measurement, and no FoT probe in
`MarketRegistry.createMarket` (`:67-97`). **It requires an admin to whitelist a
fee-on-transfer asset** — `createMarket` is `MARKET_FACTORY_ROLE`-gated (`:69`). The sharp
consequence is not slow insolvency but a stall: payout rows are computed from nominal stakes, so
`payoutBatch` (`:242`) runs the vault short and reverts, freezing the market in `Settling`,
which in turn blocks deposits and withdrawals for it (`isBankLiquidityRestricted`,
`RouletteEngine.sol:254-260`).

### M-8 — Bet solvency check is per-market only
**Severity: Medium.** `RouletteEngine.sol:371-374` is still scoped to one `marketId`/one vault
and still ignores the jackpot treasury. It was materially strengthened since the audit — it now
measures genuinely free liquidity rather than a raw balance:

```solidity
uint256 freeLiquidity = ISideBetVault(cfg.bank).availableForSideBet() + mr.totals.totalAmount + amount;
if (freeLiquidity < _bufferedMarketMaxLiability($, roundId, marketId)) revert InsufficientBankForMaxPayout();
```

`availableForSideBet()` nets out `lockedBetLiquidity`, so roulette and side bets can no longer
commit the same tokens; the mirror guard is `BankVault4626.lockSideBetStake` (`:182-196`). Test:
`test/SideBetLiabilityCollision.test.ts`.

The original entry's second half — an empty jackpot pool yields zero payouts, harmlessly — is
still accurate and now explicitly defended (`JackpotTreasury.sol:56` caps each row by the live
pool; `RouletteEngine.sol:974-975` bounds a chunk by the round's snapshotted remainder).

### M-9 — No upper bound on markets per round
**Severity: Medium → Low, and the "griefing" framing was wrong.** `RouletteEngine.sol:714-719`
still has no cap, and both `_findPayoutJobForLane` (`:472`) and `_allPayoutShardsComplete`
(`:852`) walk every market/lane. But **an attacker cannot inflate this**: markets are created
only by `MARKET_FACTORY_ROLE` (`MarketRegistry.sol:69`) and one asset may register at most once
(H-8). The ceiling is the number of admin-created markets. This is gas scaling on the CRE scan
path — an operational concern, not a griefing vector. Profile: `test/GasScaling.test.ts`.

### C-1 residuals — the TWAP floor is effective, with two caveats
The floor itself is **resolved** (see below). Two residuals are worth keeping open:
- **Cold path on a virgin pair.** `pairObservations[pair].timestamp == 0` until the first
  *successful* swap seeds it (`BRBJackpotFunder.sol:204-206`, `:318-323`). Until then the floor
  is `spot * 0.97`, so a sandwicher who pushes spot down before the very first swap sets
  `amountOutMin` from their own price. Bounded by the funder's balance for that round, and
  self-healing after one swap.
- **Linear TWAP quoting.** `UniswapV2TwapLib.sol:70` has no depth term, so for a large `swapIn`
  the floor overshoots achievable output and the swap reverts into the skip path. Fail-safe —
  funds stay sweepable — not a loss.

### Low / Info still open

| ID | Finding | Note |
|---|---|---|
| **L-1** | `BRBToken` mints full supply to one address (`BRBToken.sol:10-13`) | Distribution plan still undocumented |
| **L-2** | `maxWithdraw` misreports | **Broader than written**: `maxRedeem` *is* capped (`BankVault4626.sol:448-452`), `maxWithdraw` is not overridden at all — and since `withdraw`/`redeem` now enqueue rather than pay (`:263-281`), it misleads integrators unconditionally |
| **L-3** | Missing NatSpec | Low signal now; consider a solhint gate instead |
| **L-5** | Coverage/gas scripts gated on optional `vars` (`hardhat.config.ts:77-87`) | `README.md` is a single line |
| **L-6** | `payoutForAmount` returns 0 for unknown bet type (`RoulettePayoutMulLib.sol:31`) | Latent only — `RouletteEngine.sol:423-424` range-checks first |
| **L-8** | `BetRecorded.localRound` == round id (`RouletteEngine.sol:163-169`, `:363`) | Event signature also changed since the audit |

---

## Resolved

| ID | Finding | What resolves it |
|---|---|---|
| **C-1** | Sandwich attack on jackpot funding (zero slippage) | TWAP floor: `BRBJackpotFunder.sol:185-194`, `_quoteOut`/`_amountOutMin` `:240-282`, 30-min window `:62`. The decisive choice is `:276-278` — the floor uses the TWAP only when it is **above** spot, since that is exactly the sandwich case. An earlier `min(twap, spot)` version tracked the manipulated price and protected nothing. Anchor ages properly via `pendingPairObservations` (`:317-334`), so the branch is reachable at normal round cadence. `try/catch` + `FundFromMarketSkipped` (`:194-200`) and `sweepToken` (`:161`) complete it. See *C-1 residuals* above. |
| **C-2** | ERC-4626 first-deposit inflation | `_decimalsOffset() => 6` (`BankVault4626.sol:456-458`) plus a deposit floor: `DepositTooSmall` when `assets <= flatWithdrawFee` (`:429`, `:437`), initialised to one whole token unit (`:163`) |
| **C-3** | Upgradeable storage without a gap | **ERC-7201 namespaced storage**, which makes gaps unnecessary — `BankVault4626.sol:45-68`, `RouletteEngine.sol:60-62`, `SideBet.sol:38-56`. The contracts declare zero sequential state variables. ⚠️ The original recommendation (`uint256[50] private __gap;`) is now *wrong advice*: appending a gap to a namespaced layout does nothing |
| **C-4a** | `RouletteEngine` not upgradeable | UUPS: `RouletteEngine.sol:29`, `_authorizeUpgrade` `:240`, `_disableInitializers()` `:206`. `Ownable` replaced by four scoped roles. *Pausability remains open — see C-4b* |
| **H-1** | Whitepaper / code fee-split mismatch | `INFRA_BPS = 200` in `libraries/MarketFeeLib.sol:11`; with `swapAssetTotalBps = 300` that leaves 95% for stakers. *Still a `constant`, so changing it needs an upgrade* |
| **H-3** | `forwarderAuthority == address(0)` opened `performUpkeep` | Explicit revert `UpkeepScheduler.sol:79-87`, and zero is no longer settable `:92-96`. Test: `test/UpkeepForwarderGate.test.ts` |
| **H-5** | Funder/treasury `setEngine` one-shot | Both now reject a zero engine at construction and have **no setter**: `BRBJackpotFunder.sol:97-102` (`immutable` `:29`), `JackpotTreasury.sol:29` (`immutable` `:16`). Migration happens from the engine side instead (`RouletteEngine.sol:302`, `:311`) |
| **H-8** | Same asset registerable twice | `_assetToMarket` + `AssetAlreadyRegistered`: `MarketRegistry.sol:16`, `:25`, `:73`, `:128` |
| **H-11** | `minBet == 0` default | Three gates: `BankVault4626.sol:150` (initialize), `MarketRegistry.sol:72` (createMarket), `BankVault4626.sol:199` (setter) |
| **M-4** | Legacy / dead code | `UpkeepCodecLib.sol` deleted; `PayoutMathLib` is now live production code (`JackpotTreasury.sol:8`, `:56`); the duplicate `findNextJob` overload is gone and its lane fields are load-bearing (`RouletteEngine.sol:455-490`) |
| **M-11** | Queue holes grow forever | Premise gone with M-7; the array is freed once drained (`BankVault4626.sol:367-370`) and occupancy is capped at enqueue (`:377`, default 100 / max 1000) |

---

## Obsolete — the code no longer exists

**Do not re-fix these.** Each was verified absent from `master`.

| ID | Why it is obsolete |
|---|---|
| **H-2**, **M-3** | The entire per-market BRB-ratio subsystem is gone. `brbPerAssetUnitRatio`, `setBrbPerAssetUnitRatio`, `JACKPOT_RATIO_SCALE`, `JackpotAssetRatioNotSet`, `_appendJackpotStraightStakesForMarket` — zero hits repo-wide. The jackpot is BRB-denominated and paid from the treasury's balance (`JackpotTreasury.sol:36-38`), split by stake proportion. There is no ratio to leave unset, so no round to brick |
| **M-7**, **M-11 (premise)** | `BankVault4626.cancelWithdrawal` **does not exist and never appears on `master`** — zero hits across `contracts/`, `test/`, `scripts/`, `ignition/`. Cancellation was removed wholesale; `_userQueueIndex` now has exactly two consistent touch points (`:394` write, `:341-342` delete) |
| **M-10** | `contracts/UpkeepManager.sol` was **deleted** in the CRE migration. No LINK token, registrar or `approve` call remains. ⚠️ `INVENTORY.md:16,125,171,182` and `docs/COVERAGE_DEFENSIVE_CODE.md:25,116` still list it with a production address — they contradict this document and should be corrected |
| **M-5** | The premise **inverted**. Parallel lanes were removed at audit time; they are now the primary architecture — `DEFAULT_PAYOUT_LANE_COUNT = 10` (`RouletteEngine.sol:52`), per-lane sharding (`:461-490`), and `DEPLOY.md` provisions 10 CRE lane workflows. `PayoutParallelLanes.test.ts` and `MultiMarketCrowdParallelLanes.test.ts` are current, not stale |
| **H-10** | Not a contracts-repo finding — the subgraph is a sibling repository. Its quoted ABIs are also stale. **However, the same class of defect does exist here**: `goldsky/roulette-events-abi.json` declares `ComputedPayouts` and `JackpotResultEvent`, which **no contract on `master` emits**, and `goldsky/roulette-events-pipeline.yaml` still carries `YOUR_CONTRACT_ADDRESS` placeholders and references the deleted `RouletteClean` proxy |

## Never valid

| ID | Why |
|---|---|
| **L-4** | "`LPVestingLock` recoverable only via beneficiary" is wrong. `LPVestingLock.sol:29-30` grants `DEFAULT_ADMIN_ROLE` to `admin` **and** `BENEFICIARY_ROLE` to `beneficiary`; with OZ `AccessControl` the admin can `grantRole(BENEFICIARY_ROLE, …)` at any time. Funds are permanently locked only if *both* keys are lost. The file is byte-identical to the audit commit, so this was wrong when written. Reword as "two-key dependency — document the admin recovery path" |
| **L-7** | The finding is arguable but its justification cites `maxPlayersPerSideBet`, which **exists nowhere in the repo** |
| **M-1** | Downgrade to Info: `randomWords.length` is unchecked (`RouletteEngine.sol:767`, `:773`) but the request asks for exactly 2 (`:751`) and the callback is coordinator-gated (`VRFConsumerBaseV2.sol:135-139`). Out-of-bounds panics rather than corrupting state |
| **M-2** | Downgrade to Info. The library still has no internal guard (`JackpotBatchLib.sol:34-35`), but the reachable route is closed: zero-amount bet legs are rejected at record time (`RouletteEngine.sol:422`, `ZeroBetAmount`; test `test/ZeroBetLegRejection.test.ts`) and both call sites guard defensively (`:917-921`, `:636`). Keep only as "the library should assert for itself under future refactors" |
| **M-6** | Downgrade to Info. `payoutBatch` still transfers unconditionally (`BankVault4626.sol:246-253`), but a zero row now requires a malformed CRE report: honest rows derive from non-zero stakes and validated bet types (`RoulettePayoutSweepLib.sol:439-440`), and side-bet payouts enforce `multiplierBps > BPS_DENOMINATOR` at init (`SideBet.sol:87`) |

---

## Fixed after the audit — findings this document never covered

These were found and fixed outside the original review. Listed so the next reader knows the
code has moved, and so the gaps in the audit's coverage are explicit rather than implied.

| Area | Fix |
|---|---|
| Zero-amount bet legs | `RouletteEngine.sol:422` `ZeroBetAmount` — also closes M-2's reachable route |
| Side bet placed after the draw was public | `SideBet.sol:258-261` `RoundOutcomeAlreadyKnown` |
| CRE report replay double-paying side bets | `SideBet.settleBatch` now derives vault effects from rows actually finalised; plus `UpkeepScheduler.sol:203-207` `InvalidSideBetCursor`, `RouletteEngine.sol:831` `StalePayoutChunk`, `:952-975` `StaleJackpotChunk` |
| Side-bet payout write-index corruption | Two-pass build in `SideBet._accumulatePreviewVaultScratch` |
| Side bets stranded by the settle cursor | `previewSettleBundle` low-water mark, plus `settleTimeout` / `EXPIRED` refund (`SideBet.sol:29`, `:177-187`, `:643-648`) |
| Permissionless CRE receiver path | `ReceiverTemplate.setForwarderAddress(0)` reverts; zero-guards on workflow id/author; metadata length bound restored |
| Withdrawal-queue sybil DoS | `BankVault4626.sol:388` `if (balanceOf(owner) == 0) revert ZeroAmount();` |
| LP funds stuck in an inactive market | `drainWithdrawalQueue` (`BankVault4626.sol:296-323`) |
| That hatch draining mid-round | `:319` refuses while `ENGINE.marketRouletteLiquidityNeed(marketId) != 0` |
| Side-bet reserves counted as free collateral | `RouletteEngine.sol:371-374` + `lockSideBetStake` (`BankVault4626.sol:182-196`) |
| Unbounded payout from a CRE report | `_assertPayoutWithinLiability` / `PayoutExceedsMarketLiability` (`RouletteEngine.sol:989-1012`). ⚠️ This **bounds** the blast radius to what a round could legitimately owe; within that ceiling a bad report can still misdirect a payout. On-chain row recompute was considered and rejected — it means re-walking the bet buckets on every payout chunk, forever, against a threat model that already assumes a compromised CRE DON |
| `setPayoutLaneCount` bricking a round mid-settlement | `PayoutLaneCountLockedWhileSettling` (`RouletteEngine.sol:274-286`) |

---

## Verification

`yarn compile && yarn test` — **298 passing / 1 pending / 0 failing** at the time of this
rewrite. `yarn coverage` for line coverage. Both were runnable in this pass, unlike the
original static-only review.
