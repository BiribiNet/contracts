# Biribi protocol deployment

## Commands

| Network | Command |
|---------|---------|
| Arbitrum Sepolia (testnet) | `yarn deploy:protocol:arbitrum-sepolia` |
| Arbitrum One (production) | `yarn deploy:protocol:arbitrum` |
| Ethereum Sepolia | `yarn deploy:protocol:sepolia` |
| Re-verify Sepolia | `yarn verify:protocol:arbitrum-sepolia` |
| Generate CRE lane configs | `yarn generate:cre:configs` |

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

## Arbitrum One checklist (production)

1. **Multisig** — set `PROTOCOL_ADMIN` to the production multisig.
2. **VRF** — create and fund subscription; set `VRF_SUBSCRIPTION_ID`.
3. **Router** — set `UNISWAP_V2_ROUTER` (do not use `DEPLOY_LOCAL_UNISWAP`).
4. **Tokens** — set `USDC_TOKEN`, `DAI_TOKEN`, `BRB_TOKEN`.
5. **CRE** — verify `CRE_KEYSTONE_FORWARDER` in [Forwarder Directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts).
6. Run `yarn deploy:protocol:arbitrum`.
7. Deploy `UPKEEP_LANE_COUNT` CRE workflows (defaults to `PAYOUT_LANE_COUNT`) — [docs/CRE_MIGRATION.md](docs/CRE_MIGRATION.md).
8. LP: lock Uniswap LP in `LPVestingLock` (3-year cliff).

## Manifest output

- Testnet: `../subgraph/deployments/arbitrum-sepolia.json`
- Mainnet: `../subgraph/deployments/arbitrum-one.json`
