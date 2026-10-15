# Read-only activation preflight

Run `node scripts/protocol-preflight.mjs /path/to/deployment.json report.json`
with the reviewed Arbitrum Sepolia deployment catalog from the subgraph repository.
Optionally set `PREFLIGHT_RPC_URL`. No private key, signer, transaction or dotenv
file is loaded. RPC failures do not print credentials. The public default RPC can
be rate limited; use a trusted archival endpoint when necessary.

The report pins protocol reads to one block and records its hash. It discovers
the engine implementation through ERC-1967 and vault implementations through the
registry beacon, checking every registered bank points to that beacon. It records
code hashes, owner, assets, shares and locked roulette liquidity in raw token units.
Token balance and totalAssets need not match when bets or other liabilities are
reserved. Do not add amounts from different tokens or infer loss from this gap.

The subscription ID is read from the engine; the coordinator is taken from the
deployment catalog and is explicitly not claimed to be immutable-verified. VRF
subscription LINK, native balance and registered consumers are reported separately.
Wallet LINK is not subscription LINK. A positive balance alone is not a guarantee
that the next request can be funded. Pending randomness is a state, not by itself
a timeout or permission to retry the draw.

This tool deliberately leaves upgradeApproved=false. Its report is an inventory,
not storage compatibility or a successful upgrade simulation. Before activation:

1. Match the deployed bytecode to a reproducible source/build, including linked
   libraries and constructor immutables.
2. Validate namespaced storage compatibility with that exact deployed revision.
3. Simulate the engine and shared vault beacon upgrade on a pinned local fork;
   preserve active bets, pending VRF and withdrawal queues through settlement.
4. Reindex to a separate Goldsky version and reconcile evidence before alias changes.

BRBJackpotFunder is not a proxy: its replacement requires its own configuration,
retained-balance migration plan and indexer activation block. Never apply an engine
or beacon upgrade operation to that address.
