# Chainlink CRE automation

Biribi uses the official [Bridge pattern](https://docs.chain.link/cre/reference/cla-migration-ts): `UpkeepScheduler` keeps `checkUpkeep` / `performUpkeep`; CRE workflows call `checkUpkeep` off-chain and submit reports to `AutomationReceiver`, which calls `performUpkeep` on the scheduler.

Pre-VRF automation (TriggerVrf — one job locks the round **and** requests VRF) uses **HTTP triggers only** — no cron. The [round-watcher](../round-watcher) service polls `checkUpkeep(0)` and HTTP-triggers CRE when work is ready. Bets are additionally rejected on-chain once `lockAt` elapsed, so the betting window closes at `lockAt` even before the upkeep lands.

## On-chain components

| Contract | Role |
|----------|------|
| `UpkeepScheduler` | Upkeep target (`checkUpkeep` / `performUpkeep`) |
| `AutomationReceiver` | CRE bridge; validates KeystoneForwarder + allowlisted `(target, selector)` |
| `CreExecutionAuthority` | Approves `AutomationReceiver` as `performUpkeep` caller |

## KeystoneForwarder addresses (production)

Verify in the [Forwarder Directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts) before mainnet deploy.

| Network | Chain name | Default forwarder |
|---------|------------|-------------------|
| Arbitrum Sepolia | `ethereum-testnet-sepolia-arbitrum-1` | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |
| Arbitrum One | `ethereum-mainnet-arbitrum-1` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |
| Ethereum Sepolia | `ethereum-testnet-sepolia` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |

Override with env `CRE_KEYSTONE_FORWARDER`.

## Deploy flow

Protocol deploy scripts (`deployProtocolArbitrum*.ts`, `deployProtocolSepolia.ts`) deploy the CRE bridge automatically and write workflow JSON configs under `cre/workflows/biribi-roulette-lane/` (lane LOG configs always; HTTP trigger-vrf when `CRE_HTTP_AUTHORIZED_ADDRESS` is set).

### 1. HTTP pre-VRF workflow (TriggerVrf)

Generate config (`checkData: 0x` — lane 0 only on-chain):

```bash
SCHEDULER=0xYourScheduler \
RECEIVER=0xYourAutomationReceiver \
CRE_HTTP_AUTHORIZED_ADDRESS=0xYourRoundWatcherSigner \
NETWORK=arbitrum-sepolia \
yarn generate:cre:http:configs
```

For multiple authorized senders, use `CRE_HTTP_AUTHORIZED_ADDRESSES=0xA...,0xB...` instead. Configs write `authorizedKeys: [...]`. Local simulate can use `"authorizedKeys": []` with `"allowUnauthenticatedSim": true` — never in production.

Install workflow deps:

```bash
cd cre/workflows/biribi-roulette-lane && bun install && cd ../../..
```

Deploy **one** HTTP workflow:

```bash
cre workflow deploy biribi-roulette-lane --target=trigger-vrf-production-settings
```

Record the workflow ID for round-watcher env (`CRE_WORKFLOW_ID_TRIGGER_VRF`).

| Workflow | Config | `maxDrainIterations` | Triggered by round-watcher when |
|----------|--------|----------------------|--------------------------------|
| `biribi-trigger-vrf` | `config.trigger-vrf.production.json` | 1 | `lockAt` window, `checkUpkeep(0)` true (locks round + requests VRF in one tx) |

### 2. Start round-watcher

Deploy the round-watcher service with RPC, scheduler/engine addresses, CRE gateway URL, signer private key, and workflow IDs. See `../round-watcher/README.md`.

### 3. Payout lanes (parallel LOG workflows)

On-chain `RouletteEngine` shards winner payouts across **parallel lanes** (default **10**). Each lane is a separate CRE workflow with its own `checkData`. Lanes may service **different markets at the same time** when a lane has no remaining winners on an earlier market (separate vault per market).

Deploy writes `config.lane{N}.*.json` and regenerates `workflow.yaml` with one target per lane. Regenerate manually:

```bash
SCHEDULER=0xYourScheduler \
RECEIVER=0xYourAutomationReceiver \
ENGINE=0xYourRouletteEngine \
LANE_COUNT=10 \
NETWORK=arbitrum-sepolia \
CRE_HTTP_AUTHORIZED_ADDRESS=0xYourRoundWatcherSigner \
yarn generate:cre:configs
```

Omit `CRE_HTTP_AUTHORIZED_ADDRESS` for LOG-only lane configs. When set, lanes use `migrationType: "BOTH"` (LOG + HTTP recovery in the same workflow — no extra quota slot).

Deploy **one workflow per lane** (example: 10 parallel payout workflows on testnet):

```bash
cre workflow deploy biribi-roulette-lane --target=lane0-production-settings
cre workflow deploy biribi-roulette-lane --target=lane1-production-settings
# … through lane9-production-settings
```

`lane0` is the only lane that may run TriggerVrf via HTTP; lanes `1…N-1` only service payout shards.

Env: `PAYOUT_LANE_COUNT` (on-chain shards, default `10`), `UPKEEP_LANE_COUNT` (CRE workflows to register, default = `PAYOUT_LANE_COUNT`).

> **Workflow quota:** the CRE org currently allows **3 registered workflows** — additional lane
> deploys fail with `workflow limit exceeded`. If you deploy fewer lane workflows than on-chain
> shards, you MUST shrink the on-chain shard count to match (an unserviced shard's winners would
> never be paid):
>
> ```bash
> LANE_COUNT=<deployed lane workflows> npx hardhat run scripts/setPayoutLaneCount.ts --network arbitrumsepolia
> ```

## Current Arbitrum Sepolia deployment (2026-07-21)

Registered in the Chainlink-hosted **private registry** (`deployment-registry: "private"` in `workflow.yaml`).
HTTP triggers go to the standard gateway `https://01.gateway.zone-a.cre.chain.link` with a JWT using
`alg: "ETH"` and the workflow ID **without** `0x` prefix.

Binary includes the LATEST-block patch in `contracts/evm/ts/generated/IAutomationCompatible.ts`
(`checkUpkeep`/`checkLog` read at `LATEST_BLOCK_NUMBER` instead of `LAST_FINALIZED_BLOCK_NUMBER`;
Arbitrum Sepolia finality lags head by ~15-20 min, which made workflows act on stale jobs).

| Workflow | Workflow ID |
|----------|-------------|
| `biribi-trigger-vrf-production` | `006c4256a95bae56e37f285b6a183726051caf70c1fa99508265cc4c7d3c3dc6` |
| `biribi-roulette-lane-0-production` | `0080e7288d55578edea7a27d385761376fb958c9b9ad5e3e5ef3a9ecac3eb179` |
| `biribi-roulette-lane-1-production` | `00ce9386a3f27127e0c655c39e1ac12696cea9a9e462d575dab8f963c4ebc3d1` |

Round-watcher env `CRE_WORKFLOW_ID_TRIGGER_VRF` (Railway) must match the trigger-vrf ID above.

On-chain `payoutParallelLaneCount` set to **2** to match the two deployed payout lanes
(tx `0x5deaa591dddb37bdf65c4a0eb5e0b159124713e30cc23a935daba8808ee1fe9d`).

### 4. Harden AutomationReceiver

- `setExpectedAuthor(yourWorkflowOwner)`
- `setExpectedWorkflowId` / `setExpectedWorkflowName` per workflow

## Per-lane `checkData`

| Lane | `checkData` | Jobs |
|------|-------------|------|
| 0 | `0x` | TriggerVrf (lock + VRF request), payout shard 0 |
| N > 0 | ABI-encoded `uint256(N)` | Payout shard N only |

## Payout-lane HTTP recovery (stuck after `VRFResult`)

Payout lanes are primarily **LOG**-triggered (`VRFResult` / `PayoutProgress`). CRE does **not** retry a failed LOG execution, so an RPC blip after `VRFResult` can leave unpaid shards with `checkUpkeep` still true and no wake.

**Fix without a new CRE workflow slot:** set `migrationType: "BOTH"` on each lane config (LOG + HTTP handlers in the same registered workflow). Pass the round-watcher signer when generating:

```bash
SCHEDULER=0x... RECEIVER=0x... ENGINE=0x... LANE_COUNT=2 NETWORK=arbitrum-sepolia \
CRE_HTTP_AUTHORIZED_ADDRESS=0xYourRoundWatcherSigner \
yarn generate:cre:configs
```

Then **update** the existing lane workflows in place (still counts as 2 of 3 quota slots):

```bash
cre workflow deploy biribi-roulette-lane --target=lane0-production-settings
cre workflow deploy biribi-roulette-lane --target=lane1-production-settings
```

Handler order: `--trigger-index=0` = LOG, `--trigger-index=1` = HTTP.

Round-watcher should poll `checkUpkeep(lane)` while the round is settling; if it stays true with no progress, HTTP-trigger **that** lane’s workflow ID (same gateway/JWT pattern as TriggerVrf). HTTP wakes call `checkUpkeep` only (no log) and no-op when there is no work.

| Workflow | Triggers | Purpose |
|----------|----------|---------|
| `biribi-trigger-vrf` | HTTP | Lock + request VRF |
| `biribi-roulette-lane-N` | LOG + HTTP (`BOTH`) | Payout shard N (LOG fast path; HTTP unstick) |

## Latency tuning (testnet)

| Knob | Default (Arbitrum Sepolia deploy) | Effect |
|------|-------------------------------------|--------|
| `logTriggerConfidence` | `CONFIDENCE_LEVEL_SAFE` | LOG triggers fire in seconds, not after L1 finality |
| `PAYOUT_LANE_COUNT` / `UPKEEP_LANE_COUNT` | `10` | 10 parallel CRE workflows; shards winners and can settle multiple markets concurrently |
| `CRE_LANE_MAX_DRAIN_ITERATIONS` | `5` | Each lane drains multiple batches per wake |
| TriggerVrf `maxDrainIterations` | `1` | Lock + VRF request is a single job/tx |
| `ROUND_DURATION_SECONDS` | `60` | Betting window (matches on-chain `ROUND_DURATION`) |
| `VRF_CONFIRMATIONS` | `1` | ~250ms on Arbitrum (oracle latency dominates) |
| `UPKEEP_MAX_PAYOUTS_PER_CALL` | `60` | More winners per tx → fewer batches |

**Round-watcher** (off-repo): poll `checkUpkeep(0)` every **1–2s** at/after `lockAt`. One TriggerVrf `performUpkeep` locks the round and requests VRF atomically; if the tx reverts (e.g. underfunded VRF subscription), the job stays discoverable and the watcher simply retries. Bets after `lockAt` revert on-chain regardless of upkeep timing.

**VRF:** keep subscription funded; Arbitrum Sepolia defaults use the 50 gwei key-hash lane.

**Heavy winner counts:** raise `CRE_LANE_MAX_DRAIN_ITERATIONS` or `UPKEEP_MAX_PAYOUTS_PER_CALL`; watch `writeGasLimit` (2.5M default).

## Gas

- **writeGasLimit:** `2500000` (default in config generator)

## Troubleshooting

**`CallNotAllowed`** — `setCallAllowed(scheduler, performUpkeep(bytes), true)` on receiver (`0x4585e33b`).

**`UnauthorizedAutomationForwarder`** — `CreExecutionAuthority.setExecutorApproved(automationReceiver, true)` and `scheduler.forwarderAuthority` = authority address.

**Wrong forwarder** — `AutomationReceiver` constructor must use the network's production `KeystoneForwarder`.

**HTTP trigger rejected** — verify `CRE_HTTP_AUTHORIZED_ADDRESS` matches the private key used by round-watcher (TriggerVrf and lane recovery BOTH configs share the same authorized key list).

**Stuck after VRFResult (no payouts)** — CRE does not retry failed LOG runs. With `migrationType: "BOTH"`, HTTP-trigger the stuck lane workflow, or simulate with `--trigger-index=1` (HTTP) / `--trigger-index=0 --evm-tx-hash=…` (LOG replay). See [Payout-lane HTTP recovery](#payout-lane-http-recovery-stuck-after-vrfresult).
