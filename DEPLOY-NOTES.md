# DEPLOY-NOTES — Migration plan for the Critical + High audit fixes

This document maps each fix on `claude/biribi-project-prompts-SWffc` to
the action required on Arbitrum mainnet to make it effective. The
deployed contracts at the addresses in `INVENTORY.md` cannot all be
patched in place — `RouletteEngine`, `BRBJackpotFunder`,
`JackpotTreasury`, and `ProtocolTimelock` are constructor-only, so a
redeploy is needed.

## Migration classes

### A. Beacon upgrade (no redeploy)

`BankVault4626` lives behind an `UpgradeableBeacon`
(`MarketRegistry.vaultBeacon`). Pushing a new implementation and calling
`UpgradeableBeacon.upgradeTo(newImpl)` applies the new code to every
existing vault atomically.

Fixes in this bucket:

- **C-2** `_decimalsOffset()` override (`BankVault4626`)
- **C-3** `__gap` storage reservation (`BankVault4626`)
- **H-9** fee-on-transfer-safe `_placeBetCore` (`BankVault4626`)
- **H-11** `minBet` enforced at `initialize` (`BankVault4626`) — the
  `initialize` signature changed; existing vaults are already initialised
  so the new param only applies to **future** `createMarket` calls. For
  the existing vaults, run `setMinBet(...)` post-upgrade.

### B. Redeploy + re-wire

The following contracts are constructor-only and need a fresh deploy.

#### B.1 RouletteEngine (C-4, H-1, H-2, H-7)

- Deploy new `RouletteEngine`.
- The new engine address must be referenced by:
  - new `UpkeepScheduler` (engine ctor arg)
  - new `BRBJackpotFunder` (engine ctor arg, now immutable)
  - new `JackpotTreasury` (engine ctor arg, now immutable)
- Existing markets must be re-registered with the new engine. Because
  `registerMarketFromRegistry` is callable only from `MarketRegistry`,
  the cleanest path is a fresh `MarketRegistry` deploy + new
  `createMarket(...)` per asset (USDC, USDT, DAI, BRB).

#### B.2 BRBJackpotFunder + JackpotTreasury (H-5)

- Both constructors now require non-zero `engine_`; `engine` is
  `immutable`. Deploy with the new engine address from B.1.

#### B.3 UpkeepScheduler (H-3)

- Deploy a new scheduler pointed at the new engine.
- After deploy, call `setForwarderAuthority(newUpkeepManager)`.
- Leave `devMode == false` in production.

#### B.4 MarketRegistry (H-4, H-8, H-11)

- Deploy a new `MarketRegistry`.
- Immediately after deploy:
  - `setVaultBeacon(newBankVaultBeacon)` (admin EOA)
  - `setEngine(newRouletteEngine)` (admin EOA)
  - `grantRole(MARKET_FACTORY_ROLE, ProtocolTimelock)` and `revokeRole`
    from the admin EOA. This closes H-4 / H-6 operationally.
- `createMarket(...)` each asset with the appropriate `minBet`.

#### B.5 ProtocolTimelock (H-12)

- Deploy with `STANDARD_DELAY = 24h` and `SENSITIVE_DELAY = 48h`. Both
  are immutable; sensitive selectors preloaded for the high-impact
  setters listed in `ProtocolTimelock.sol`. Admin can flip more via
  `setSensitiveSelector(...)`.

### C. Operational handover (no source change useful)

- **H-4** After deploy, transfer `MARKET_FACTORY_ROLE` on the new
  `MarketRegistry` to `ProtocolTimelock`. Revoke from the EOA admin.
- **H-6** Same handover for every `*_ADMIN_ROLE` across the new
  contracts (`BANK_ADMIN_ROLE`, `FUNDER_ADMIN_ROLE`,
  `TREASURY_ADMIN_ROLE`, `SCHEDULER_ADMIN_ROLE`, `REGISTRANT_ROLE`).
  Multi-sig should hold `PROPOSER_ROLE` on the timelock; another
  multi-sig or EOA can hold `EXECUTOR_ROLE`.

### D. Subgraph (H-10)

Out of scope for this PR. Tracked in `biribinet/subgraph/MIGRATION.md`
and will land alongside prompt 2.

## Migration sequence (high-level)

1. **Quiesce the live protocol.**
   - Set `scanLimit = 0` on the current `UpkeepScheduler` to halt new
     jobs; let in-flight payout jobs drain.
   - Lower the current engine's bet path by setting bank `minBet` to a
     prohibitive value or by transferring the `BANK_ADMIN_ROLE` to a
     dead address temporarily.
2. **Deploy new contracts** in dependency order:
   1. `ProtocolTimelock` (admin = multi-sig, proposer = multi-sig,
      executor = multi-sig or guardian).
   2. `BRBToken` — reuse the existing deploy at
      `0x47e054bb133e75b1c2c7a9a52ba73e52e75a06a1` (no fix in this PR).
   3. `JackpotTreasury(engine = TBD, brb, admin)` — see step 5.
   4. `BRBJackpotFunder(engine = TBD, brb, router, treasury, admin)` —
      see step 5.
   5. `RouletteEngine(registry = TBD, jackpotTreasury, jackpotFunder,
      …)` — because three contracts in steps 3/4/5 cross-reference the
      engine address, deploy via a `CREATE2`-style script that
      pre-computes the engine address and feeds it back into the
      treasury / funder constructors. Alternatively, deploy the engine
      first using a placeholder, then redeploy treasury / funder; the
      engine is also immutable so this still works.
   6. `BankVault4626` implementation (new bytecode).
   7. `UpgradeableBeacon(implementation = new BankVault4626)`.
   8. `MarketRegistry(admin = multi-sig)`.
   9. `UpkeepScheduler(engine = new RouletteEngine, admin, scanLimit,
      maxPayoutsPerCall)`.
   10. `UpkeepManager(link, registrar, registry, target = new
       UpkeepScheduler, admin, registrant)`.
3. **Wire** post-deploy:
   - `MarketRegistry.setVaultBeacon(newBeacon)`.
   - `MarketRegistry.setEngine(newEngine)`.
   - `UpkeepScheduler.setForwarderAuthority(newUpkeepManager)`.
   - Verify `UpkeepScheduler.devMode() == false`.
4. **Transfer roles to `ProtocolTimelock`**:
   - For each contract that has a `*_ADMIN_ROLE`, grant the role to the
     timelock and revoke it from the EOA admin.
   - Document the resulting role table in a deployment report.
5. **Recreate markets**: for each (USDC, USDT, DAI, BRB, …):
   - Call `BRBJackpotFunder.setBrbPerAssetUnitRatio(nextMarketId,
     ratio)` first (non-BRB only).
   - Call `MarketRegistry.createMarket({asset, bankAdmin, minBet})` via
     the timelock proposer.
6. **Smoke test** on each new vault: deposit a small amount, place a
   small bet, run a full upkeep cycle, withdraw. Verify
   `JackpotRatioMissing` does NOT fire and the fee invariant matches
   the configured `infraBps + swapAssetTotalBps`.
7. **Re-enable**: bump `scanLimit` on the new scheduler.

## Validation checklist

- [ ] `yarn test` passes on `claude/biribi-project-prompts-SWffc`
      (Hardhat + Chai + viem). Existing suites + the new
      `test/regression/AuditFixesRegression.test.ts` must be green.
- [ ] `yarn coverage` ≥ 90 % lines on contracts touched.
- [ ] `npx solhint 'contracts/**/*.sol'` is clean.
- [ ] `npx prettier --check .` is clean.
- [ ] Every Critical / High in `AUDIT.md` has the matching `Status`
      column populated and a fix commit referenced.
- [ ] Migration sequence above has been walked through on Arbitrum
      Sepolia (dry-run) before mainnet.
- [ ] All `*_ADMIN_ROLE` instances are held by `ProtocolTimelock` after
      the role-transfer step (H-4 / H-6).

## Reference: deployed (old) addresses

For migration scripts that diff old vs new state:

| Contract          | Old address                                   |
|-------------------|-----------------------------------------------|
| MarketRegistry    | `0x9a328b11c7189a8ba2af6186643f93204b516987`  |
| RouletteEngine    | `0x60cd5a0f74f1644eaef997496e19e3737690ad1c`  |
| Scheduler         | `0x40a7f6d4e902f13e2d9e4754dee37648f2fcdfda`  |
| UpkeepManager     | `0xdbfab262996d221c72eeb9f2e6679c3d2c7bc95b`  |
| JackpotTreasury   | `0xbbe4d51cf721277d52d916291f6de4fa972e5e22`  |
| BRB               | `0x47e054bb133e75b1c2c7a9a52ba73e52e75a06a1`  |
| Jackpot funder    | `0x60ce672feaf39f35a3f6e5b3e099f46b90aee9fc`  |

Keep these on-hand when running the wire-down step (`scanLimit = 0`).
