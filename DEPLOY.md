# Biribi protocol deployment

## Commands

| Network | Command |
|---------|---------|
| Arbitrum Sepolia (testnet) | `yarn deploy:protocol:arbitrum-sepolia` |
| Arbitrum One (production) | `yarn deploy:protocol:arbitrum` |
| Re-verify Sepolia | `yarn verify:protocol:arbitrum-sepolia` |

## Hardhat vars (required)

```bash
hardhat vars set BRB_KEY
hardhat vars set ARBITRUM_SEPOLIA_RPC_URL   # testnet
hardhat vars set ARBITRUM_RPC_URL           # mainnet
hardhat vars set ETHERSCAN_API_KEY          # optional verify
```

## Arbitrum Sepolia checklist

1. Fund deployer with ETH + LINK.
2. Run `yarn deploy:protocol:arbitrum-sepolia`.
3. Confirm on-chain:
   - `UpkeepScheduler.forwarderAuthority` = `UpkeepManager`
   - `SideBet` has `SETTLEMENT_ROLE` granted to scheduler
   - VRF subscription lists engine as consumer
4. Create BRB/USDC and BRB/DAI Uniswap V2 pools on the deployed router.
5. Seed vault liquidity; place test bets.
6. Optional: `SKIP_SUBGRAPH_SYNC=true` if subgraph pipeline is not ready.

## Arbitrum One checklist (production)

1. **Multisig** — set `PROTOCOL_ADMIN` to the production multisig (not the hot deploy key).
2. **Chainlink** — create and fund VRF subscription; set `VRF_SUBSCRIPTION_ID` (required).
3. **Router** — set `UNISWAP_V2_ROUTER` to the production Uniswap V2 router (do not use `DEPLOY_LOCAL_UNISWAP`).
4. **Tokens** — set `USDC_TOKEN`, `DAI_TOKEN`, `BRB_TOKEN` (or deploy BRB to `PROTOCOL_ADMIN`).
5. **Automation** — verify `KEEPER_REGISTRY` / `KEEPER_REGISTRAR` against [Chainlink Automation networks](https://docs.chain.link/chainlink-automation/overview/supported-networks).
6. **VRF** — verify coordinator + key hashes against [Chainlink VRF networks](https://docs.chain.link/vrf/v2-5/supported-networks).
7. Run `yarn deploy:protocol:arbitrum`.
8. Transfer roles from deployer to `ProtocolTimelock` (recommended before public launch).
9. Register `UPKEEP_LANE_COUNT` upkeeps (defaults to `PAYOUT_LANE_COUNT`).
10. LP: lock Uniswap LP in `LPVestingLock` (3-year cliff).

## Post-deploy operations

- **Rotate funder** (non-upgradeable): deploy new `BRBJackpotFunder` → `engine.setJackpotFunder` → `sweepToken` on old funder.
- **Stuck swap assets**: monitor `FundFromMarketSkipped` and funder token balances; `sweepToken(asset, to, 0)`.
- **Beacon upgrade**: `UpgradeableBeacon.upgradeTo` via timelock only; append fields to `BankVaultStorage` only.

## Manifest output

- Testnet: `../subgraph/deployments/arbitrum-sepolia.json`
- Mainnet: `../subgraph/deployments/arbitrum-one.json`
