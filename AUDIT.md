# Contracts AUDIT — `markets` branch

Audit of the multi-asset refactor on `biribinet/contracts @ markets`
(`045b14c9`). Static review only — `yarn compile` / `yarn test` / `yarn
coverage` need a local environment with the right `hardhat vars` (`BRB_KEY`,
`ETHERSCAN_API_KEY`, etc.) and **were NOT executed in this audit pass**.
Re-run them locally before any deployment and confirm the existing test
suite is green against the addresses in `INVENTORY.md`.

Conventions:
- **Severity**: Critical, High, Medium, Low, Info.
- **Location**: `path/to/file.sol:LINE_OR_REGION`.
- All Critical / High findings are documented but **not silently patched** in
  this commit, per prompt 1's instructions.

---

## Critical

### C-1 — Sandwich attack on jackpot funding (zero slippage)
- **Where**: `contracts/BRBJackpotFunder.sol` — `fundFromMarket`, the
  `router.swapExactTokensForTokens(swapIn, 0, path, address(this), block.timestamp + 600)` call.
- **Issue**: `amountOutMin = 0` (no slippage protection) is used for every
  asset→BRB swap on every round settlement. An MEV bot can sandwich the
  Automation upkeep tx and extract close to all of the swapped value.
  Comment "Reserved for future policy; swaps use `amountOutMin = 0` so
  upkeep is not bricked by pool moves" acknowledges the design but the
  trade-off is severe — for stable-paired BRB pools on Arbitrum, the
  attacker drain can approach 100% of `swapIn` when liquidity is thin.
- **Impact**: Jackpot and burn buckets receive near-zero BRB each round;
  fees effectively redirected to MEV searchers.
- **Recommendation**:
  1. Compute `amountOutMin` from a TWAP oracle (Uniswap V2 cumulative
     price, e.g. 30 min window) with bounded slippage (e.g. 200–500 bps).
  2. Wrap the router call in `try / catch` so a stale / out-of-range price
     skips the swap (existing `FundFromMarketSkipped` event) without
     reverting upkeep.
  3. Optionally, batch swaps (accumulate `swapIn` in `PendingSwapBuffer`
     and flush off-peak) to amortize fixed slippage costs.

### C-2 — ERC-4626 first-deposit inflation attack
- **Where**: `contracts/BankVault4626.sol` — `initialize` and the inherited
  `ERC4626Upgradeable` defaults.
- **Issue**: `BankVault4626` does **not** override `_decimalsOffset()` nor
  mint dead shares to `address(0)` in `initialize`. OZ v5 defaults
  `_decimalsOffset() = 0`. The classic first-depositor inflation attack
  applies on every freshly-created market vault: the attacker mints 1 wei
  share, donates `N` asset tokens directly, then subsequent depositors get
  zero shares due to integer division.
- **Impact**: Any new market created by `MarketRegistry.createMarket` is
  exploitable until its first "honest" deposit. Funds can be stolen from
  late depositors.
- **Recommendation**: Override `_decimalsOffset() => returns (uint8 6)`
  (or higher), **or** seed each newly-created vault during
  `MarketRegistry.createMarket` with a small `_mint(deadAddress, 1e6)` of
  shares (via a privileged `initialize`-time seed call that pulls a tiny
  amount of `asset` from the factory deployer).

### C-3 — Upgradeable storage without reserved gap
- **Where**: `contracts/BankVault4626.sol` — entire storage layout.
- **Issue**: `BankVault4626` is intended to be upgradeable via
  `UpgradeableBeacon` (cf. `MarketRegistry.setVaultBeacon`). It inherits
  `ERC4626Upgradeable + AccessControlUpgradeable +
  ReentrancyGuardTransient`, then declares its own storage
  (`marketId`, `ENGINE`, `lockedBetLiquidity`, `minBet`, `_withdrawalQueue`,
  etc.) but **no `uint256[__N] private __gap;`** is reserved. Future
  upgrades that add state variables to base contracts (or to this one)
  will collide.
- **Impact**: A future upgrade can silently corrupt the storage of every
  existing market vault, leading to lost shares, stuck withdrawal queues,
  or worse.
- **Recommendation**: Add a `uint256[50] private __gap;` at the end of the
  contract storage now (before any upgrade). Re-deploy the implementation
  via `UpgradeableBeacon.upgradeTo`, gated by `ProtocolTimelock`.

### C-4 — `RouletteEngine` is not upgradeable and not pausable
- **Where**: `contracts/RouletteEngine.sol` — top of contract, no
  `Pausable`, no UUPS.
- **Issue**: The engine is `Ownable + VRFConsumerBaseV2` (constructor-only).
  Address `0x60cd…ad1c` is the production engine and any bug, exploit, or
  desync requires a redeploy + re-registration of every market + bank /
  treasury / funder re-wiring. There is no `pause()` for emergencies and
  no admin "stop accepting new bets" switch.
- **Impact**: A single live exploit forces an emergency migration; markets
  and bets in flight may need to be fenced manually (e.g. set scheduler's
  `scanLimit` to 0, set `forwarderAuthority` to a dead authority).
- **Recommendation**:
  1. Add an `EngineKillSwitch` (Pausable-like) that, when active, makes
     `recordBet` and `executeJob` revert with a clear error, and allows
     processing of withdrawal queues only.
  2. For long-term, consider migrating to UUPS so a critical fix doesn't
     require redeploying treasury / funder / vaults.

---

## High

### H-1 — Whitepaper / code fee-split mismatch (`INFRA_BPS`)
- **Where**: `contracts/RouletteEngine.sol` —
  `uint256 private constant INFRA_BPS = 250;` and `_collectMarketFees`.
- **Issue**: The whitepaper / `CLAUDE.md` specify **2.0%** to
  infrastructure and **95%** to stakers (vault). The code uses
  `INFRA_BPS = 250` = **2.5%**. With `swapAssetTotalBps = 300` (3% to
  jackpot funder split into 2.5% jackpot + 0.5% burn) the total fee is
  **5.5%**, leaving **94.5%** for stakers — not 95%.
- **Impact**: Persistent 50 bps siphoned from stakers to the infra
  recipient on every house win.
- **Recommendation**: Confirm intent with product / treasury; if
  whitepaper is canonical, change `INFRA_BPS = 200`. Either way, **make
  it configurable** with `ProtocolTimelock`-gated setter and emit an
  event. Add an invariant test that asserts the four shares sum to 100%.

### H-2 — `JackpotAssetRatioNotSet` can brick rounds
- **Where**: `contracts/RouletteEngine.sol` —
  `_appendJackpotStraightStakesForMarket`.
- **Issue**: If a market's asset is not BRB and admin has not called
  `BRBJackpotFunder.setBrbPerAssetUnitRatio(marketId, ratio)`, the jackpot
  resolution path reverts. Because jackpot resolution runs **before** the
  per-market settlement (and is forwarder-gated on a single lane), this
  blocks the entire scheduler queue.
- **Impact**: Forgetting to set the ratio for any non-BRB market makes the
  round stuck until ratio is set. No automatic recovery.
- **Recommendation**:
  1. Add a `tryFundedRatio` view + revert in `MarketRegistry.createMarket`
     when the asset is not BRB and the ratio is not pre-configured.
  2. Or default to a sentinel (e.g. 1:1) and surface a `RatioMissing` event
     so the round does not block.
  3. Add a `recoverJackpotIfRatioMissing(marketId)` admin function.

### H-3 — `UpkeepScheduler.forwarderAuthority == address(0)` opens
        `performUpkeep` to anyone
- **Where**: `contracts/UpkeepScheduler.sol` —
  `modifier onlyApprovedAutomationForwarder` defaults.
- **Issue**: When `forwarderAuthority` is zero, the modifier is a no-op
  ("any caller (tests / local tooling)"). If deployment scripts forget to
  call `setForwarderAuthority(UpkeepManager)`, ANY EOA can drive
  `performUpkeep` — which calls `ENGINE.executeJob` — and inject jobs
  out of order or rate-limit-drain protocol.
- **Impact**: Operational hijack of the engine state machine.
- **Recommendation**: Make `forwarderAuthority == address(0)` revert in
  `performUpkeep`. Provide a separate, role-gated test escape hatch
  (`grantRole(SCHEDULER_ADMIN_ROLE, …)` only).

### H-4 — `MarketRegistry.setVaultBeacon` / `setEngine` lack a timelock
- **Where**: `contracts/MarketRegistry.sol`.
- **Issue**: Both setters are gated only by `MARKET_FACTORY_ROLE`. Setting
  a new beacon retroactively upgrades **every** existing vault (this is
  the whole point of beacon proxies, but it must be governance-gated).
  Setting a new engine changes the address that future markets are wired
  to.
- **Impact**: A compromised admin key can upgrade every vault
  implementation in one tx without any social warning period.
- **Recommendation**: Route both setters through `ProtocolTimelock`. Grant
  `MARKET_FACTORY_ROLE` to the timelock; revoke from any EOA.

### H-5 — `BRBJackpotFunder.setEngine` and `JackpotTreasury.setEngine` are
        one-shot but accept a zero-address ctor
- **Where**: `BRBJackpotFunder.sol` constructor + `setEngine`;
  `JackpotTreasury.sol` `setEngine`.
- **Issue**: The constructor zero-check on the funder does **not** include
  `engine_` (only `brb_`, `router_`, `jackpotTreasury_`, `admin`). Both
  contracts accept deploy-time engine = 0 and require a follow-up
  `setEngine` call, which is then irrevocable. If a deployer mis-types,
  griefs, or front-runs the setter, the wrong engine is permanent.
- **Impact**: Misconfiguration risk → entire treasury / funder must be
  re-deployed.
- **Recommendation**: Either require non-zero engine at construction time,
  or make `setEngine` reachable from a `TimelockController` rather than a
  raw role. Add a forward-only `proposeEngine` + activation delay.

### H-6 — Permanent admin-key blast radius across the new contracts
- **Where**: `BankVault4626`, `BRBJackpotFunder`, `JackpotTreasury`,
  `MarketRegistry`, `UpkeepScheduler`, `UpkeepManager`.
- **Issue**: Each `AccessControl` contract has at least one
  `*_ADMIN_ROLE` that can rewrite the most critical parameters
  (split BPS, slippage BPS, scan limit, max payouts, beacon, engine,
  min bet…). None require timelock by default.
- **Impact**: A compromise of any of these admin keys is immediately
  exploitable — there is no social window.
- **Recommendation**: After deployment, transfer every admin / factory /
  registrant role to `ProtocolTimelock`, and require multi-sig as the
  timelock proposer. Document the off-chain process in `DEPLOY.md`.

### H-7 — `tx.gasprice`-based VRF key-hash selection
- **Where**: `contracts/RouletteEngine.sol` — `_triggerVrf`.
- **Issue**: The 2 / 30 / 150 gwei VRF lane is selected from
  `tx.gasprice`. On L2 (Arbitrum) `tx.gasprice` is mostly the
  L1-derived base fee + L2 tip; a forwarder that misconfigures gas can
  intentionally pick a slow lane (cheaper) and stall settlements. There
  is no slashing for slow VRF on L2.
- **Impact**: Mild DoS / settlement delay vector via forwarder behavior.
- **Recommendation**: Replace `tx.gasprice` with a `gasLane` field in the
  upkeep `performData` (signed by the scheduler admin in a separate
  setter), or use a single VRF key hash and let Chainlink handle gas
  pricing inside the subscription.

### H-8 — `MarketRegistry` allows the same asset to be registered twice
- **Where**: `contracts/MarketRegistry.sol` — `_registerNextMarket`.
- **Issue**: The collision check is `if (_markets[next].bank != address(0))
  revert MarketAlreadyRegistered();` — which only fails when the **next
  slot** is already occupied (it never is). There is no de-duplication
  on `asset`. Two markets can wrap the same underlying, splitting
  liquidity unintentionally and confusing the engine when assigning fees.
- **Impact**: Misconfigured markets can be created accidentally; UX and
  liquidity fragmentation.
- **Recommendation**: Add a `mapping(address asset => uint32 marketId)
  assetToMarket;` and revert when re-registering.

### H-9 — `BankVault4626.placeBet` is not fee-on-transfer-safe
- **Where**: `contracts/BankVault4626.sol` — `_placeBetCore`.
- **Issue**: `lockedBetLiquidity += amount;` is incremented by the nominal
  `amount` before `safeTransferFrom(msg.sender, address(this), amount);`.
  For fee-on-transfer (FoT) tokens, the vault actually receives less than
  `amount`, but the engine's `_bufferedMarketMaxLiability` check uses the
  nominal value and the locked accumulator is over-counted. Solvency
  invariants drift downward each bet.
- **Impact**: Insolvency over time if a FoT asset is whitelisted.
- **Recommendation**: Reject FoT assets at `MarketRegistry.createMarket`
  with a balance-of-before / balance-of-after probe of 1 wei. Or measure
  the actually-received delta inside `_placeBetCore` and pass that into
  `lockedBetLiquidity` and `recordBet`.

### H-10 — Subgraph is structurally incompatible with the `markets` ABIs
- **Where**: `biribinet/subgraph/subgraph.yaml` and all `src/mappings/*`.
- **Issue**: The current subgraph indexes `RouletteClean` /
  `StakedBRB` / `BRBReferal` / `BRB` on `arbitrum-sepolia` at obsolete
  addresses. The new contracts emit completely different event shapes
  (e.g. `BetRecorded(uint32 marketId, uint64 localRound, address player,
  uint256 amount, uint8 betType, uint16 number)`,
  `MarketRegistered(uint32, address)`, `JackpotFunded(uint64, uint32, uint256)`,
  `WithdrawalRequested(address, uint8 kind, address, uint256, uint256)`).
  No data source for `MarketRegistry`, `BRBJackpotFunder`,
  `JackpotTreasury`, `UpkeepScheduler`, `UpkeepManager`.
- **Impact**: Indexer reports nothing useful for the production deployment;
  frontend breaks.
- **Recommendation**: See `biribinet/subgraph/AUDIT.md` companion. The
  current commit re-points the manifest to `arbitrum-one` with the new
  addresses **as a stub**; mappings and schema still require a full
  rewrite — track that under prompt 2 / prompt 4 (which will produce the
  proper multi-market schema).

### H-11 — `BankVault4626.minBet == 0` is the default
- **Where**: `contracts/BankVault4626.sol` — `initialize` does not set
  `minBet`; `setMinBet` reverts on zero.
- **Issue**: Until `setMinBet` is called post-init, `minBet` is 0 and dust
  bets are accepted. Anti-DoS / griefing protection (per `CLAUDE.md`) is
  not in effect.
- **Impact**: Dust bets can be used to grow `_roundMarkets[roundId]` and
  inflate scan / payout work, plus blow up vault storage for cleanup.
- **Recommendation**: Set `minBet` in `initialize` (e.g. take it as an
  init param sourced from `MarketRegistry.createMarket`).

### H-12 — `ProtocolTimelock.DELAY = 24 hours` is short for high-impact ops
- **Where**: `contracts/ProtocolTimelock.sol` — `DELAY`.
- **Issue**: 24 hours is short for actions like vault beacon upgrade,
  engine change, fee parameter overhaul. The Compound-style standard is
  48–72 h.
- **Recommendation**: Either lengthen `DELAY` to 48 h, or introduce two
  delay tiers (operational 24 h, sensitive 72 h) keyed by `target` /
  `selector`.

---

## Medium

### M-1 — `fulfillRandomWords` does not validate `randomWords.length`
- **Where**: `contracts/RouletteEngine.sol` — `fulfillRandomWords`.
- **Issue**: Indexes `randomWords[0]` and `randomWords[1]`. The VRF
  request asks for 2 words so this should always hold, but a defensive
  `if (randomWords.length < 2) revert InvalidRound();` would be cheap
  insurance.

### M-2 — `JackpotBatchLib.computeBatch` reverts on `denom == 0`
- **Where**: `contracts/libraries/JackpotBatchLib.sol`.
- **Issue**: Division by zero if `denom` (total stake) is 0. The engine
  guards with `if (totalStake == 0 || n == 0) { jackpotDistributed = true;
  return; }` so it's currently safe — but the library should have its own
  assertion / early-return to be safe under future refactors.

### M-3 — `BRBJackpotFunder.brbPerAssetUnitRatio` is settable to zero via
        deletion path
- **Where**: `BRBJackpotFunder.sol` — `setBrbPerAssetUnitRatio` rejects 0,
  but the storage default is 0 (unset). When the engine reads the value
  and the asset is BRB, it falls back to `JACKPOT_RATIO_SCALE`. When the
  asset is non-BRB and not set, it reverts (`JackpotAssetRatioNotSet`).
  See H-2 for impact.

### M-4 — Legacy / dead code increases bytecode review surface
- **Where**: `contracts/libraries/PayoutMathLib.sol`,
  `contracts/libraries/UpkeepCodecLib.sol`, and the second overload
  `findNextJob(startCursor, scanLimit, payoutLane, payoutShardWidth)` in
  `IRouletteEngine` / `RouletteEngine` (parallel-lane fields ignored).
- **Issue**: Unused libraries and unused interface fields add deploy /
  audit overhead and risk future contributors re-introducing parallel
  payouts incompatible with current state.
- **Recommendation**: Remove the unused library files and the legacy
  overload, **or** add a CI test that asserts they remain unused.

### M-5 — `PayoutParallelLanes.test.ts` /
        `MultiMarketCrowdParallelLanes.test.ts` may be stale
- **Where**: `test/`.
- **Issue**: Parallel lanes were removed (per code comments in
  `RouletteEngine`). These tests must either be updated to verify
  single-lane semantics or removed.

### M-6 — `BankVault4626.payoutBatch` does not skip zero-amount payouts
- **Where**: `BankVault4626.sol` — `payoutBatch`.
- **Issue**: `safeTransfer(player, 0)` is allowed by most ERC-20s but a
  few legacy tokens revert. Minor cost vs. robustness.
- **Recommendation**: `if (payout.amount == 0) { unchecked { ++i; }
  continue; }`.

### M-7 — `BankVault4626.cancelWithdrawal` does not check
        `_withdrawalQueue[idx] == owner`
- **Where**: `BankVault4626.sol` — `cancelWithdrawal`.
- **Issue**: It deletes `_userQueueIndex[msg.sender]` and zero-marks
  `_withdrawalQueue[idx]` only when the slot matches. If the index is
  stale, the queue slot keeps the user address. The processor
  (`processWithdrawalQueue`) re-checks `q.kind == 0` so this is harmless
  today, but the index/queue invariants drift.
- **Recommendation**: Always delete both records consistently; add a
  comment or invariant test.

### M-8 — `recordBet` solvency check is per-marketId only, not protocol-wide
- **Where**: `RouletteEngine.sol` — `recordBet`,
  `_bufferedMarketMaxLiability`.
- **Issue**: The check is `bankBal + amount < buffered`. It does not
  enforce that the jackpot treasury can cover its share when a jackpot
  fires. With a jackpot pool that is empty (fresh launch), eligible
  STRAIGHT bets still earn a "share" of the empty pool — harmless, but
  worth a UX note.

### M-9 — No upper bound on the number of markets a single round can
        accept (`_roundMarkets[roundId]`)
- **Where**: `RouletteEngine.sol` — `_resolveOpenRound`.
- **Issue**: Each bet on a previously-unseen market pushes to the
  in-storage array. Scanning that array drives gas for jackpot collection
  and payout finder. With many markets and griefing, payout completion
  can become expensive.
- **Recommendation**: Cap `_roundMarketParticipantCount[roundId]` to e.g.
  20 markets per round; reject `recordBet` once full.

### M-10 — `UpkeepManager.approve(type(uint256).max)` to the registrar
- **Where**: `UpkeepManager.sol` constructor.
- **Issue**: Infinite LINK allowance to `KEEPER_REGISTRAR`. Mitigated by
  the registrar being a Chainlink-vetted contract, but still worth
  flagging — prefer per-call exact allowance via `forceApprove` on each
  `registerLaneUpkeep`.

### M-11 — Cancelled withdrawals leave queue holes that grow over time
- **Where**: `BankVault4626.sol` — `cancelWithdrawal` zero-marks the slot
  but does not compact the queue.
- **Issue**: For a long-lived vault with high churn, `_withdrawalQueue`
  grows monotonically until `processWithdrawalQueue` drains it to
  `head == len`. Memory cost on `processWithdrawalQueue` scales with
  total holes, not just live entries.
- **Recommendation**: Periodically compact via a small `_purge(maxN)`
  admin call, or track `aliveCount` so the engine can pace processing.

---

## Low / Info

### L-1 — `BRBToken.constructor` mints full supply to a single address
- The whole 3M BRB lands at `initialRecipient`. Until distributed (LP +
  staking incentives + grants), centralization is total. Document and
  publish the distribution plan as part of the audit narrative.

### L-2 — `BankVault4626.maxWithdraw` / `maxRedeem` may report nonzero
   even when withdrawals are queue-blocked
- The `withdraw / redeem` revert in liquidity-restricted state happens
  inside the call, not via `maxWithdraw`. Some integrations may rely on
  `maxWithdraw == 0` to mean "do not call". Consider returning 0 when
  `ENGINE.isBankLiquidityRestricted(marketId) == true`.

### L-3 — No NatSpec on every external function
- E.g. `MarketRegistry.previewNextMarketId`, several event docs missing.
  Run a NatSpec linter before publication.

### L-4 — `LPVestingLock` is admin-recoverable only via beneficiary
- `BENEFICIARY_ROLE` is granted to a single address at deploy. If lost,
  the LP is permanently locked. Either grant to a multisig, or accept
  the risk explicitly in the doc.

### L-5 — Coverage and gas-report scripts gated on optional `vars`
- `hardhat.config.ts` guards `ETHERSCAN_API_KEY` and `REPORT_GAS` with
  `vars.has`. Document in `README.md` how to set them and confirm CI is
  configured.

### L-6 — `RoulettePayoutMulLib.payoutForAmount` for unknown bet type
   returns 0
- The library returns `0` for any betType outside the expected range.
  Currently safe because validation happens in
  `RouletteBetCodecLib.routeBet`, but a future caller could miss the
  validation and silently mint zero-payout entries.

### L-7 — `BetStorageLib.addBet` does not use `unchecked` for `betCount`
- `betCount` is bounded by `maxPlayersPerSideBet`-class limits; a tiny
  gas optimization, but worth a comment that overflow is impossible.

### L-8 — `RouletteEngine.recordBet` emits both `localRound` and the
   round id with the same value
- `event BetRecorded(uint32 marketId, uint64 localRound, address player, …)`.
  `localRound` == the global round id (no per-market sub-rounds in this
  architecture). Either drop one field or rename for clarity.

---

## Build / tests — what to run locally

```bash
yarn install
yarn compile                    # hardhat compile + wagmi codegen
yarn test                       # full Hardhat suite (Chai + viem)
yarn coverage                   # solidity-coverage; expect long runtime
npx solhint 'contracts/**/*.sol'
npx prettier --check .
```

Expect at minimum:
- `MultiAssetArchitecture.test.ts`, `BankVault4626.test.ts`,
  `JackpotTreasury.test.ts`, `BRBJackpotFunder.test.ts`,
  `JackpotBatchingStress.test.ts`, `ProtocolTimelock.test.ts`,
  `UpkeepForwarderGate.test.ts`, `LPVestingLock.test.ts`,
  `E2EUpkeepFlow.test.ts`, `GasScaling.test.ts` to pass.
- `PayoutParallelLanes.test.ts` and
  `MultiMarketCrowdParallelLanes.test.ts` should be reviewed against the
  current single-lane code (see M-5).
- Coverage target: ≥ 90% lines on the new contracts. Anything below
  should be discussed before mainnet.

## Follow-ups (tracked in repo-prompts)

- C-1 (slippage), C-2 (inflation), C-3 (gap), C-4 (pause): file individual
  PRs after triage. Do not deploy fixes silently.
- H-1 (`INFRA_BPS` 250 vs 200): align with whitepaper before next deploy.
- H-3 (`forwarderAuthority`): tighten in deployment scripts immediately.
- H-10 (subgraph): see companion `AUDIT.md` and `subgraph.yaml` repointing
  commit on the same branch.
