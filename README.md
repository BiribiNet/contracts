# BIRIBI

## Contract checks

GitHub Actions runs one smoke job on pull requests and pushes to `master`.
Markdown-only and report-only changes skip CI. New commits cancel older automatic
runs for the same PR or branch. Yarn downloads and Hardhat compilation outputs
are cached; Hardhat still checks whether sources need recompiling.

The automatic job runs preflight and release configuration tests, the side-bet
economics typecheck, and `yarn test:ci`. The smoke suite covers engine storage
compatibility, payout math, zero-amount bet rejection, a complete round and jackpot
settlement, upkeep authorization, VRF retries, and side-bet compatibility/pricing.
It is a quick regression gate, not the full contract suite or a load test.

Run the same checks locally with Node 22 and installed dependencies:

```sh
node --test scripts/protocol-preflight.test.mjs scripts/export-mainnet-abis.test.mjs scripts/release-manifest.test.mjs
yarn typecheck:side-bet-economics
yarn test:ci
```

Full regressions, swarm tests and fork rehearsals are manual. In Actions, select
**Contracts CI → Run workflow** and choose `full`, `swarm` or `fork` in `suite`.
The default manual selection is `smoke`. Only `fork` uses the `mainnet-rehearsal`
environment and its RPC secret; `fork_block` optionally pins its block. Uploaded
swarm/fork reports expire after seven days, so retain release evidence separately.

Before a release or contract upgrade, run the full suite and required rehearsals:

```sh
REPORT_GAS=false yarn hardhat test
yarn test:swarm
ARBITRUM_FORK_BLOCK=513332057 yarn test:fork:arbitrum
```

The fork command requires a securely configured `ARBITRUM_FORK_URL`. See
[the release runbook](docs/MAINNET_RUNBOOK.md) for rehearsal requirements.
