# Contracts INVENTORY — historical snapshot

> ⚠️ **This is a snapshot of `markets @ 045b14c9`, not a description of `master`.**
> It is kept for the architectural notes. **Do not use the address table below** —
> every address in it is stale, and `UpkeepManager` no longer exists at all.
>
> **Authoritative addresses live in `../subgraph/deployments/*.json`**, which
> `sync-pipeline` maintains and `check-constants` guards in CI. This repository
> keeps no deployment record of its own.
>
> For current security status see `AUDIT.md`, which has been re-verified against
> `master`. Sections below carry inline corrections where they state something
> that is now false.

This document inventories every contract introduced or materially changed on
the `markets` branch (the multi-asset refactor) and mapped them to the addresses
deployed at that time.

## Deployed contracts — STALE, superseded (do not use)

| Contract          | Address                                         | Source file                          |
|-------------------|-------------------------------------------------|--------------------------------------|
| MarketRegistry    | `0x9a328b11c7189a8ba2af6186643f93204b516987`    | `contracts/MarketRegistry.sol`       |
| RouletteEngine    | `0x60cd5a0f74f1644eaef997496e19e3737690ad1c`    | `contracts/RouletteEngine.sol`       |
| Scheduler         | `0x40a7f6d4e902f13e2d9e4754dee37648f2fcdfda`    | `contracts/UpkeepScheduler.sol`      |
| JackpotTreasury   | `0xbbe4d51cf721277d52d916291f6de4fa972e5e22`    | `contracts/JackpotTreasury.sol`      |
| BRB               | `0x47e054bb133e75b1c2c7a9a52ba73e52e75a06a1`    | `contracts/BRBToken.sol`             |
| Jackpot funder    | `0x60ce672feaf39f35a3f6e5b3e099f46b90aee9fc`    | `contracts/BRBJackpotFunder.sol`     |

Vaults (`BankVault4626` beacon proxies) and `ProtocolTimelock` / `LPVestingLock`
are deployed per-market / per-pair via the registry and deployment scripts; see
`scripts/deployProtocolArbitrumSepolia.ts` and `scripts/deployMultiAsset.ts`.

## Architecture overview

The protocol moved from a **single-asset monolith** (`RouletteClean.sol`,
`StakedBRB.sol`, `JackpotContract.sol`, `BRBReferal.sol`) to a **multi-asset
hub-and-spoke** design:

> **The diagram is as of the snapshot.** On `master`, `UpkeepManager` is gone —
> the automation path is `CreExecutionAuthority` → `AutomationReceiver` →
> `UpkeepScheduler` — `RouletteEngine` is UUPS with scoped roles rather than
> `Ownable`, and `SideBet` (not shown) also drives the vaults.

```
                       ┌──────────────────────┐
                       │   MarketRegistry     │  AccessControl
                       │  (creates markets,   │
                       │   holds beacon)      │
                       └──────────┬───────────┘
                                  │ createMarket()
                                  ▼
   ┌────────────────────┐    BeaconProxy    ┌──────────────────────┐
   │  UpgradeableBeacon │◄──────────────────│   BankVault4626      │  ERC4626Upgradeable
   │ (BankVault impl)   │                   │  (one per asset)     │  AccessControlUpgradeable
   └────────────────────┘                   └──────────┬───────────┘
                                                       │ placeBet / payoutBatch /
                                                       │ transferOut / processQueue
                                                       ▼
   ┌──────────────────────┐     onlyScheduler     ┌──────────────────────┐
   │   UpkeepScheduler    │──────────────────────►│   RouletteEngine     │  Ownable, VRFConsumerBaseV2
   │ (Automation gateway) │                       │ (rounds, VRF, fees)  │
   └──────────────────────┘                       └──┬────────┬──────────┘
            ▲                                       │        │
            │ isApprovedAutomationForwarder          │        │
   ┌──────────────────────┐              fundFromMarket    payBatch
   │    UpkeepManager     │                          ▼        ▼
   │ (LINK + registrar)   │                    ┌──────────┐ ┌────────────────┐
   └──────────────────────┘                    │ Jackpot- │ │ JackpotTreasury│
                                               │ Funder   │ │ (BRB pool)     │
                                               │ (Uniswap │ └────────────────┘
                                               │  V2)     │
                                               └────┬─────┘
                                                    ▼
                                              ┌──────────┐
                                              │  BRBToken│
                                              │ (BRB)    │
                                              └──────────┘

   Auxiliary:
     • ProtocolTimelock — 24 h queue for privileged calls (e.g. beacon upgrades)
     • LPVestingLock     — 3-year cliff on Uniswap V2 LP tokens
     • RouletteLib + RouletteLiabilityMathLib + JackpotBatchLib + RouletteBetLib
       + RouletteBetCodecLib + RoulettePayoutMulLib + PayoutMathLib + UpkeepCodecLib
       + BetStorageLib — linked libraries (off-engine bytecode)
```

## New / changed top-level contracts

### `contracts/BRBToken.sol` (660 bytes)
Protocol ERC-20. `ERC20Burnable + ERC20Permit`. Fixed supply
`3_000_000 × 10^18` minted to `initialRecipient` at deploy. Name `"BIRIBI"`,
symbol `"BRB"`. Replaces legacy `BRB.sol`.

### `contracts/MarketRegistry.sol` (5,328 bytes)
`AccessControl`. Role `MARKET_FACTORY_ROLE`. Holds `vaultBeacon`
(`UpgradeableBeacon`) and `ENGINE` references. `createMarket(params)` deploys
a new `BeaconProxy(vaultBeacon, init)` per asset and registers it with the
engine. Bank share `name = "BRB " + asset.name()`, `symbol = "brb" + asset.symbol()`.

### `contracts/BankVault4626.sol` (11,656 bytes)
Per-asset vault. `ERC4626Upgradeable + AccessControlUpgradeable +
ReentrancyGuardTransient`. Role `BANK_ADMIN_ROLE`. Beacon-proxy-deployable.
Handles `placeBet` / `placeBetWithPermit` → engine `recordBet`, vault-side
withdrawal queue with `WithdrawalEjected` reasons (insufficient shares /
liquidity), `transferOut` and `payoutBatch` reserved for the engine, blocks
deposits / withdraws while the bank is "liquidity-restricted" (round
locked / settling).

### `contracts/JackpotTreasury.sol` (2,211 bytes)
`AccessControl`. Holds BRB pool. Engine-only `payBatch(winners[], amounts[])`.
Role `TREASURY_ADMIN_ROLE`. One-shot `setEngine` (irrevocable once set).

### `contracts/BRBJackpotFunder.sol` (7,646 bytes)
`AccessControl`. Receives per-round profit slice in the market's asset from
the engine via `transferOut`, swaps to BRB through Uniswap V2 router (when
asset ≠ BRB), splits the BRB between `JackpotTreasury` and `burn()` according
to `treasuryBrbNumerator / treasuryBrbDenominator` (default 250 / 300). Role
`FUNDER_ADMIN_ROLE`. One-shot `setEngine`. Per-market BRB-per-asset ratio
mapping (`brbPerAssetUnitRatio`) for off-chain / engine jackpot parity.

### `contracts/RouletteEngine.sol` (53,851 bytes)
Core game engine. `Ownable + VRFConsumerBaseV2`. **NOT upgradeable.** Manages
global rounds across all markets, per-market `BankVault4626` bookkeeping,
VRF requests with three gas-tier key hashes (`tx.gasprice`-based selection),
sequential `Job` lifecycle (`OpenRound → TriggerVrf (lock + VRF) → Payout`) driven
by `UPKEEP_SCHEDULER`. Implements jackpot-eligible STRAIGHT-only proportional
payouts based on stake share via `JackpotBatchLib`. Settles per-market fees
(`INFRA_BPS = 250` to `INFRA_RECIPIENT`, `swapAssetTotalBps` to
`JACKPOT_FUNDER`).

### `contracts/UpkeepScheduler.sol` (4,818 bytes)
`AccessControl + AutomationCompatibleInterface`. Role `SCHEDULER_ADMIN_ROLE`.
> **CORRECTED.** Both claims below were true at the snapshot and are false on `master`.
> Parallel lanes are the *primary* architecture now (`DEFAULT_PAYOUT_LANE_COUNT = 10`),
> and a zero forwarder authority no longer "allows any caller" — that was AUDIT.md's
> H-3 auth bypass. `performUpkeep` reverts on a zero authority
> (`UpkeepScheduler.sol:79-87`) and zero is no longer settable (`:92-96`).

~~Single-lane upkeep (parallel lanes were removed). Restricts `performUpkeep`
to approved Automation forwarders via `IUpkeepForwarderAuthority` (when set);
`address(0)` allows any caller for tests / tooling — must be configured for
production.~~

### `contracts/UpkeepManager.sol` — DELETED
Removed in the CRE migration. Chainlink Automation self-registration was replaced
by `AutomationReceiver` + `CreExecutionAuthority` + `cre/workflows/`; there is no
LINK token, registrar or `approve` call left in `contracts/`. AUDIT.md's M-10
described this contract's constructor and is marked obsolete for that reason.

### `contracts/ProtocolTimelock.sol` (3,090 bytes)
`AccessControl`. 24 h fixed `DELAY`. Roles `PROPOSER_ROLE` / `EXECUTOR_ROLE`.
Queue / execute / cancel pattern using `keccak256(target, value, data, salt)`
operation ids.

### `contracts/LPVestingLock.sol` (1,943 bytes)
`AccessControl`. 3-year cliff (computed at deploy) on a Uniswap V2 LP token.
`BENEFICIARY_ROLE` can `release` after the cliff.

### `contracts/RouletteLib.sol` (1,153 bytes)
Linked library. `SAFETY_BUFFER_BPS = 11000` (110%). `max` / `max3` /
`applySafetyBuffer` (`raw * 11000 / 10000`).

## Libraries (`contracts/libraries/`)

| File                              | Role                                                                     |
|-----------------------------------|--------------------------------------------------------------------------|
| `BetStorageLib.sol`               | `RoundTotals { totalAmount, betCount }` + `addBet`                       |
| `RouletteBetLib.sol`              | Winning bet types decoding (splits / corners / lines / color / parity)   |
| `RouletteBetCodecLib.sol`         | Typed bet validation + routing to numbered / flat buckets                |
| `RoulettePayoutMulLib.sol`        | Straight payout multipliers per bet type                                 |
| `RouletteLiabilityMathLib.sol`    | Worst-case per-market liability with safety buffer                       |
| `JackpotBatchLib.sol`             | Pro-rata jackpot batch computation with "last winner gets the dust"      |
| `PayoutMathLib.sol`               | Generic BPS helpers + pool cap (**currently unused by visible code**)    |
| `UpkeepCodecLib.sol`              | Job ABI encode / decode (**currently unused by visible code**)           |

## Interfaces (`contracts/interfaces/`)

`IMarketRegistry`, `IBankVault`, `IRouletteEngine`, `IJackpotTreasury`,
`IBRBJackpotFunder`, `IRouletteBetErrors`, `IERC20PermitCompat`,
`IUniswapV2Router02`, `IUpkeepForwarderAuthority`, `IUpkeepScheduler`,
`IAutomationRegistrar2_1`, `IAutomationRegistry2_1`.

## Removed (vs `master`)

- `contracts/BRB.sol`             → replaced by `BRBToken.sol`
- `contracts/RouletteClean.sol`   → replaced by `RouletteEngine.sol`
- `contracts/StakedBRB.sol`       → replaced by `BankVault4626.sol`
- `contracts/JackpotContract.sol` → replaced by `JackpotTreasury.sol`
- `contracts/BRBReferal.sol`      → removed (no referral contract in `markets`)
- `contracts/BRBUpkeepManager.sol`→ replaced by `UpkeepManager.sol`, itself since deleted (CRE migration)
- `contracts/StakedBRBFeeMath.sol`, `StakedBRBLiquidityEscrow.sol` → removed

## Tests on `markets`

`test/` (Hardhat + Chai + viem):
`BRBJackpotFunder`, `BRBToken`, `BankVault4626`, `CoverageGaps`,
`E2EUpkeepFlow`, `FullBalanceSettlement`, `GasScaling`,
`JackpotBatchingStress`, `JackpotTreasury`, `LPVestingLock`,
`MultiAssetArchitecture`, `MultiMarketCrowdParallelLanes`, `PayoutMathLib`,
`PayoutParallelLanes`, `ProtocolTimelock`, `UpkeepForwarderGate`,
`UpkeepManager`.

> **CORRECTED.** The note here said `PayoutParallelLanes` and
> `MultiMarketCrowdParallelLanes` referenced behaviour marked removed. The premise
> has since inverted: parallel lanes are the production architecture, both tests are
> current, and `TenLaneParallelPayouts`, `MultiMarketParallelLanes` and
> `HundredPlayerTwoMarketLanes` were added alongside them. The `UpkeepManager` suite
> is gone with its contract.

## Configuration / scripts

- `hardhat.config.ts` — Solidity 0.8.27 with `viaIR: true`,
  `optimizer.runs = 1`, EVM `cancun`. Multi-compiler (0.5.16, 0.6.6 for
  Uniswap V2 vendored code). Etherscan v2 single-key.
- `scripts/deployMultiAsset.ts`, `scripts/deployProtocolSepolia.ts`,
  `scripts/deployProtocolArbitrumSepolia.ts`,
  `scripts/verifyArbitrumSepoliaProtocol.ts`,
  `scripts/update-subgraph-abis.mjs`.
- `package.json` scripts: `yarn compile` (hardhat + wagmi codegen),
  `yarn test`, `yarn coverage`, `yarn deploy:multiasset`,
  `yarn deploy:protocol:arbitrum-sepolia`.

## ABI vs subgraph drift

The subgraph still indexes the **legacy** `RouletteClean` / `StakedBRB` /
`BRBReferal` / `BRB` event signatures on **`arbitrum-sepolia`** at obsolete
addresses (`0x2b68…0654`, `0x21de…080d`, `0x522f…039b`, `0x48e8…e831b`).
Every event the `markets` branch emits is structurally different. The
subgraph requires a full re-wiring against the new contracts before any
deploy to `arbitrum-one`. See `AUDIT.md` for specifics.
