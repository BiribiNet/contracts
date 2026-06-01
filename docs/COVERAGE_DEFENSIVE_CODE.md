# Coverage & defensive code report

How to read this doc:

| Label | Meaning |
|-------|---------|
| **Removed** | Invariant proves the branch cannot happen; code deleted |
| **Reachable — test** | Real path; low coverage only because tests were missing or imprecise. **Keep the code**; add or tighten tests |
| **Defense-in-depth** | Reachable under misconfiguration, buggy tooling, or a compromised privileged role. **Keep**; cover with targeted tests where practical |
| **Branch matrix** | Many branches need combinatorial tests, not removal |

**Latest aggregate (instrumented run, after §4 tests):** ~98% statements · **~73% branches** · ~100% lines on most contracts.

Branch coverage is **not** 100% for the whole suite without a large test matrix. That is mostly **missing tests**, not proof that branches are dead.

---

## Summary table (last full run)

| Contract | Stmts | Branch | Lines | Notes |
|----------|-------|--------|-------|-------|
| BRBToken | 100% | 100% | 100% | Done |
| BRBReferal | 100% | 100% | 100% | Done |
| RouletteLib | 100% | 100% | 100% | Done |
| UpkeepManager | 100% | **94.4%** | 100% | §4 constructor matrix |
| SideBet | 98.4% | **75.9%** | 100% | Config / outcome branches |
| UpkeepScheduler | 100% | 78.3% | 98.3% | Line 172 still red in some runs |
| MarketRegistry | 100% | **78.1%** | 100% | Setter reverts |
| BRBJackpotFunder | 100% | 71.7% | 100% | try/catch fee paths |
| JackpotTreasury | 100% | 77.8% | 100% | |
| ProtocolTimelock | 100% | 77.3% | 100% | |
| LPVestingLock | 100% | 88.9% | 100% | |
| BankVault4626 | 97.8% | **68.2%** | 100% | Queue / side-bet arms |
| RouletteEngine | 96.4% | **67.4%** | 100% | Engine + inlined libs |

---

## 1. Removed (actually unreachable)

### `MarketRegistry` — `MarketAlreadyRegistered` ✅ removed

- `next` is always `_marketCount + 1` and only written from `createMarket`.
- The old check on the **next slot id** was unreachable; it did **not** enforce unique `asset`.
- **H-8 fix**: `assetToMarket` mapping + `AssetAlreadyRegistered` revert on duplicate `asset` in `createMarket`.

### `BankVault4626` — ERC-4626 inflation mitigation (C-2)

- Overrides `_decimalsOffset() => 6` (uniform across all market assets). Share `decimals()` becomes `assetDecimals + 6` per OZ; steady-state APY is unchanged.

---

## 2. Reachable — needs precise tests (not dead code)

These were **not** unreachable; they were **under-covered**. Keep the guards; coverage gaps were from test design (wrong caller, truncated calldata, or not hitting the exact revert arm).

### `UpkeepScheduler.performUpkeep` — unknown `workKind` (removed)

**Previously:** `revert InvalidPerformData()` when `performData` decoded to a kind other than `Roulette` or `SideBet`.

**Decision:** **Removed.** Production assumes Chainlink only forwards bytes from `checkUpkeep`. `performUpkeep` branches on raw `uint8` (no enum cast) so unknown kinds no-op instead of panicking. Malformed ABI payloads still revert at decode. Tests: `BranchCoverage.test.ts`, `ContractCoverage95.test.ts`, `BranchCoverage100.test.ts`.

### `RouletteEngine.executeJob` — lock / VRF / unknown kind (removed inner guards)

**Previously:** `_lockGlobalRound` duplicated `_preLockUpkeepCandidate` (`InvalidRound`, `NoBets`); `_triggerVrf` duplicated `findNextJob` (`VrfAlreadyPending`, queue/phase checks); unknown `job.kind` reverted `InvalidJob()`.

**Decision:** **Removed duplicate guards.** `findNextJob` + `checkUpkeep` are the single gate; `executeJob` is `onlyScheduler`. Lock/VRF use early return for idempotent replay (wrong phase, pending VRF, empty queue). Unknown kinds return `false`. `InvalidJob` remains only for admin setter `setPayoutParallelLaneCount(0)`.

### `SideBet.settleBatch` / `_finalizeSettleRow` — invalid rows

**Reachable when:** `SETTLEMENT_ROLE` caller passes rows that do not match on-chain bet state (wrong `payoutAmount`, inactive bet, etc.). The honest scheduler uses `previewSettleBundle`, but the **contract must** reject corrupt rows.

| Scenario | How to hit | Tests |
|----------|------------|-------|
| Win with wrong payout | `won: true`, `payoutAmount != bet.payout` | `SideBet.test.ts` — `ignores invalid settle rows` |
| Loss with nonzero payout | `won: false`, `payoutAmount > 0` | `SideBet.test.ts`, `ContractCoverage95.test.ts` |
| Double settle / wrong role | Re-call `settleBatch` or non-scheduler | `SideBet.test.ts` |

**Decision:** **Keep.** Not unreachable — requires a **privileged** caller test, not only the happy-path scheduler.

### `BankVault4626.releaseBets` — `amount > lockedBetLiquidity` → clamp to 0

**Reachable when:** Engine (or side bet) releases more than currently locked.

| Scenario | How to hit | Tests |
|----------|------------|-------|
| Over-release | `MockEngine.releaseFromVault` with amount ≫ locked | `BankVault4626.test.ts` — `caps release` |

**Decision:** **Keep.** Deliberate tolerance, not dead code.

### Other paths previously lumped as “defensive only”

Same story: **test gap**, not **dead branch**.

- **BRBJackpotFunder** `try/catch` on swap / transfer / burn — use `MockBRBWithFeeHooks`, router revert (`BranchCoverage`, `BRBJackpotFunder.test.ts`)
- **ProtocolTimelock** `WrongMsgValue` — queue with `value > 0`, execute with `msg.value = 0` (`BranchCoverage.test.ts`)
- **JackpotTreasury** `EngineAlreadySet`, length mismatch — (`JackpotTreasury.test.ts`, `BranchCoverage.test.ts`)
- **MarketRegistry** setter reverts, `ZeroImplementation` — (`BranchCoverage.test.ts`, `CoverageGaps.test.ts`)

---

## 3. Defense-in-depth (keep; test when threat model matters)

| Item | Threat model | Test status |
|------|----------------|-------------|
| `executeJob` idempotent replay | Duplicate Automation perform (rare) | Early return in lock/VRF |
| Invalid `SideBet` settle rows | Compromised `SETTLEMENT_ROLE` | Covered via admin `settleBatch` |
| `releaseBets` clamp | Engine batching / rounding | Covered |
| Forwarder gate on scheduler | Unauthorized `performUpkeep` | `UpkeepForwarderGate.test.ts`, `BranchCoverage.test.ts` |

---

## 4. Branch tests added (§4 checklist)

| Area | Tests | Status |
|------|-------|--------|
| **UpkeepManager** | Per-param constructor `ZeroAddress` (5 deploys) | `BranchCoverage.test.ts` §4 |
| **UpkeepScheduler** | SideBet `checkUpkeep` when `MockRoundEngine.findNextJob` returns empty | `BranchCoverage.test.ts` §4 |
| **RouletteEngine** | `isBankLiquidityRestricted` through Locked + Settling until settled | `BranchCoverage.test.ts` §4 |
| **BankVault4626** | `QueueFull`, `OnlySideBet`, queue drain / re-enqueue | `BranchCoverage.test.ts` §4; permit in `BankVault4626.test.ts` |
| **SideBet** | Invalid `addConfig` matrix + `setMultiplierBand` bounds | `BranchCoverage.test.ts` (registry describe) |
| **LPVestingLock** | Constructor + `release` revert arms | `BranchCoverage.test.ts` §4 |
| **MarketRegistry** | Happy-path `createMarket` after beacon + engine | `BranchCoverage.test.ts` §4 |

### Still hard to reach 100% branch (keep code; more tests optional)

| Area | What remains |
|------|----------------|
| **RouletteEngine** | VRF gas-price lane selection, full jackpot batching combinatorics |
| **UpkeepScheduler** | `found && kind==Payout && !payoutLaneHasWork` then SideBet (needs settled payout + pending side bet on same scheduler) |
| **BankVault4626** | `DepositBlockedDuringResolution` with real engine in Settling (partially in `ContractCoverage95`) |

---

## 5. Coverage artifacts (not dead code)

- **`error` declarations** and some **`constant` lines** often show as uncovered statements; no runtime branch.
- **`RouletteEngine` branch %** includes **linked libraries** inlined at call sites — file-level branch will stay below 100% unless libs are tested in isolation.

---

## 6. CI / coverage run notes

- Instrumented runs are **~3× slower**; slow stress tests may need long mocha timeout when `SOLIDITY_COVERAGE=true` (see `hardhat.config.ts`).

```bash
yarn coverage
```

Open `coverage/index.html` → sort by **Branch**. Red lines in §2 are usually “add a precise test,” not “delete code.”

---

## 7. Decision table (quick reference)

| Item | Action |
|------|--------|
| `MarketAlreadyRegistered` | **Removed** (only proven unreachable) |
| `InvalidPerformData` / unknown `performUpkeep` kind | **Removed** — trusted `checkUpkeep` → `performUpkeep` only |
| `executeJob` lock/VRF duplicate checks / unknown kind revert | **Removed** — trusted `checkUpkeep` → `performUpkeep` |
| Invalid `SideBet` `settleBatch` rows | **Keep** — **reachable** via privileged caller; tests exist |
| `releaseBets` over-release clamp | **Keep** — **reachable**; tested |
| Duplicate `asset` in registry (H-8) | **Fixed** — `assetToMarket` + `AssetAlreadyRegistered` |
| 100% branch on all contracts | **Not reached** (~73% aggregate); `RouletteEngine` + libs dominate gap; only `BRBToken` / `RouletteLib` / `BRBReferal` at 100% branch |
