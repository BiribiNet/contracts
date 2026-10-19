# Biribi protocol deployment

## Commands

| Network | Command |
|---------|---------|
| Arbitrum Sepolia (testnet) | `yarn deploy:protocol:arbitrum-sepolia` |
| Arbitrum One (production) | `yarn deploy:protocol:arbitrum` |
| Ethereum Sepolia | `yarn deploy:protocol:sepolia` |
| Re-verify Sepolia | `yarn verify:protocol:arbitrum-sepolia` |
| Generate CRE lane configs | `yarn generate:cre:configs` |
| Upgrade SideBet (Sepolia) | `yarn upgrade:side-bet:arbitrum-sepolia` |
| Upgrade BankVault beacon (Sepolia) | `yarn upgrade:vault:arbitrum-sepolia` |
| Seed side-bet catalogue (Sepolia) | `yarn seed:side-bets:arbitrum-sepolia` |
| Plan side-bet catalogue (Arbitrum One) | `SEED_CATALOGUE=legacy SEED_MARKET_IDS=1 yarn seed:side-bets:arbitrum` |

## Hardhat vars (required)

```bash
hardhat vars set BRB_KEY
hardhat vars set ARBITRUM_SEPOLIA_RPC_URL   # testnet
hardhat vars set ARBITRUM_RPC_URL           # mainnet
hardhat vars set SEPOLIA_RPC_URL            # Ethereum Sepolia
hardhat vars set ETHERSCAN_API_KEY          # optional verify
```

## Arbitrum Sepolia checklist

1. Fund deployer with ETH (+ LINK for VRF if creating a new subscription).
2. Run `yarn deploy:protocol:arbitrum-sepolia`.
3. Confirm on-chain:
   - `UpkeepScheduler.forwarderAuthority` = `CreExecutionAuthority`
   - `CreExecutionAuthority` approves `AutomationReceiver`
   - `AutomationReceiver.setCallAllowed(scheduler, performUpkeep(bytes), true)`
   - VRF subscription lists engine as consumer
4. Deploy **10** parallel payout CRE workflows (`lane0` … `lane9`) plus the HTTP trigger-vrf workflow — [docs/CRE_MIGRATION.md](docs/CRE_MIGRATION.md). Set `PAYOUT_LANE_COUNT` / `UPKEEP_LANE_COUNT` to tune.
5. Seed vault liquidity; place test bets.
6. **Seed the side-bet catalogue** — see below. A deploy leaves `SideBet.configCount == 0`, and a
   SideBet with no config offers nothing: every `placeBet` reverts `UnknownConfig` and the frontend
   renders its empty "no side bets are open" state.

## SideBet (Side bets)

`SideBet` is deployed and wired by the protocol deploy (registry, engine, and each vault's
`sideBetController`), but **no bet template is ever created for it**. Seeding is a required
post-deploy step, not an optional extra.

### 1. Upgrade the implementation (existing deployments only)

```bash
yarn upgrade:side-bet:arbitrum-sepolia
```

Requires `DEFAULT_ADMIN_ROLE` on the proxy. The script deploys the current implementation, calls
`upgradeToAndCall` with `initializeReservedAccounting()` as its payload, then sets `settleTimeout`.

**Upgrade before seeding, never after.** The payload adopts the incremental accounting behind
`reservedOf`, which counts only the bets placed after it exists. On a proxy that already holds bets
it would under-report the payout at risk in each market forever, and nothing on-chain would show the
gap — so the call reverts (`ReservedAccountingMigrationUnsafe`) and takes the upgrade with it. The
script also refuses up front, before paying for an implementation deploy, when `betCount != 0`.
Reaching that state means the catalogue was seeded and played on the old implementation: migrating
then needs a deliberate backfill, not this script.

**Why the timeout write is mandatory:** `DEFAULT_SETTLE_TIMEOUT` is applied only inside
`initialize`, so an upgraded proxy reads `settleTimeout == 0` and expiry stays disabled. A bet that
never becomes decidable — because its market went quiet and global rounds stopped advancing — would
then pin its settlement lane cursor permanently. The script writes the value and asserts it stuck.

### 2. Seed the catalogue

```bash
yarn seed:side-bets:arbitrum-sepolia               # dry run: prints the transaction plan
SEED_APPLY=true yarn seed:side-bets:arbitrum-sepolia
```

Requires **both** `SIDE_BET_CONFIG_ROLE` and `SIDE_BET_LIMITS_ROLE`; the script checks this before
sending anything. It creates the nine templates in `scripts/utils/sideBetCatalogue.ts` for every
registered market and is idempotent — a re-run only activates what is still inactive.

Two transactions are needed per config, because `addConfig` overwrites the stake limits with zero
regardless of what is passed, and `placeBet` reverts `StakeLimitsNotSet` until they are set:

| Step | Function | Role |
|---|---|---|
| Create the template | `addConfig` | `SIDE_BET_CONFIG_ROLE` |
| Make it playable | `setConfigStakeLimits` | `SIDE_BET_LIMITS_ROLE` |

`maxStake` is derived from each vault's live liquidity, because `lockSideBetStake` requires the
vault to cover `stake × (multiplier − 1)`. **A thin vault leaves its configs created but not
activated**, with a message naming the shortfall — deposit via `scripts/seedBankVaultLiquidity.ts`
and re-run. Tune with `SEED_MIN_STAKE_UNITS` (default 1 whole asset unit) and `SEED_SAFETY_BPS`
(default 2000 = one bet may reserve 20% of the pool).

### 3. Verify

```bash
# configCount must be markets × 9
cast call $SIDE_BET "configCount()(uint256)" --rpc-url $ARBITRUM_SEPOLIA_RPC_URL
```

Then check the subgraph returns them (`sideBetConfigs(where: {active: true})`) and that `/side-bets`
lists the catalogue.

> **Role hazard on a fresh deploy.** `scripts/utils/deployRouletteEngine.ts` grants
> `SETTLEMENT_ROLE` to the scheduler using the *deployer* key, while `initialize` gives
> `DEFAULT_ADMIN_ROLE` to `PROTOCOL_ADMIN`. When `PROTOCOL_ADMIN` is a multisig — as the Arbitrum
> One checklist requires — that `grantRole` reverts and the deploy fails mid-flight. Grant the role
> from the multisig afterwards, or deploy with `PROTOCOL_ADMIN` set to the deployer and transfer
> admin last.

## Arbitrum One checklist (production)

1. **Multisig** — set `PROTOCOL_ADMIN` to the production multisig.
2. **VRF** — create and fund subscription; set `VRF_SUBSCRIPTION_ID`.
3. **Router** — set `UNISWAP_V2_ROUTER` (do not use `DEPLOY_LOCAL_UNISWAP`).
4. **Tokens** — set `USDC_TOKEN`, `DAI_TOKEN`, `BRB_TOKEN`.
5. **CRE** — verify `CRE_KEYSTONE_FORWARDER` in [Forwarder Directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts).
6. Run `yarn deploy:protocol:arbitrum`.
7. Deploy `UPKEEP_LANE_COUNT` CRE workflows (defaults to `PAYOUT_LANE_COUNT`) — [docs/CRE_MIGRATION.md](docs/CRE_MIGRATION.md).
8. LP: lock Uniswap LP in `LPVestingLock` (3-year cliff).
9. Seed the side-bet catalogue from an account holding `SIDE_BET_CONFIG_ROLE` and
   `SIDE_BET_LIMITS_ROLE`. The mainnet command reads the proxy from `deployments/arbitrum-one.json`
   and requires an explicit catalogue and market selection. Fund each selected vault first —
   the seed refuses to activate configs the vault cannot back. See the commands below.

### Mainnet SideBet activation

The production page displays an empty catalogue until configs are created with `addConfig` and
opened with `setConfigStakeLimits`. Start with a dry run for the BRB market (market 1):

```bash
SEED_CATALOGUE=legacy SEED_MARKET_IDS=1 yarn seed:side-bets:arbitrum
```

Review every proposed multiplier, minimum, maximum, vault liquidity, settlement compatibility,
and pending VRF status. The dry run broadcasts no transaction. USDC and DAI (markets 2 and 3)
should be selected only after their vaults are funded and their risk limits reviewed. To apply the
reviewed plan, use the same catalogue and market IDs, plus the transaction switch and the mainnet
proxy confirmation:

```bash
SEED_CATALOGUE=legacy SEED_MARKET_IDS=1 SEED_APPLY=true \
  SEED_MAINNET_CONFIRM=0x96e34298425c310422bfba424bd4ed455b597d7f \
  yarn seed:side-bets:arbitrum
```

The script checks chain ID 42161, the proxy against the deployment manifest, both required roles,
liquidity limits, settlement compatibility, and that no VRF request is pending before broadcasting.
It can be rerun after an interrupted batch; it reads existing configs and skips matching ones.
Verify `configCount`, active limits, the indexer, and the public `/side-bets` catalogue after the
transactions confirm. This procedure requires approval of the exact offers and an authorized
signer; a frontend deployment alone cannot open them.

## Manifest output

- Testnet: `../subgraph/deployments/arbitrum-sepolia.json`
- Mainnet: `../subgraph/deployments/arbitrum-one.json`
