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
| Seed side-bet catalogue (Sepolia) | `yarn seed:side-bets:arbitrum-sepolia` |

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

## SideBet (BRBGAME)

`SideBet` is deployed and wired by the protocol deploy (registry, engine, and each vault's
`sideBetController`), but **no bet template is ever created for it**. Seeding is a required
post-deploy step, not an optional extra.

### 1. Upgrade the implementation (existing deployments only)

```bash
yarn upgrade:side-bet:arbitrum-sepolia
```

Requires `DEFAULT_ADMIN_ROLE` on the proxy. The script deploys the current implementation, calls
`upgradeToAndCall`, then sets `settleTimeout`.

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

Then check the subgraph returns them (`sideBetConfigs(where: {active: true})`) and that `/brbgame`
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
9. Seed the side-bet catalogue (see **SideBet (BRBGAME)** above) from an account holding
   `SIDE_BET_CONFIG_ROLE` and `SIDE_BET_LIMITS_ROLE`, pointing `SIDE_BET_ADDRESS` at the mainnet
   proxy. Fund each vault first — the seed refuses to activate configs the vault cannot back.

## Manifest output

- Testnet: `../subgraph/deployments/arbitrum-sepolia.json`
- Mainnet: `../subgraph/deployments/arbitrum-one.json`
