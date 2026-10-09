# TipJar

An immutable, BRB-only voluntary-contribution router, separate from RouletteEngine and
its proxy/storage. Constructor arguments are the protocol BRB token and engine. The
infrastructure recipient is resolved once from the engine, then fixed. No administrator,
redirect, custody, automatic donation, game advantage or points reward exists.

`tip(amount)` uses SafeERC20.transferFrom directly from the caller to the fixed recipient.
It rejects zero amounts, recipient self-transfers and non-exact recipient balance deltas.
ReentrancyGuard protects the external token call. A successful transfer emits
`TipSent(sender, token, recipient, amount)`. The supported BRB is an ordinary ERC-20:
taxed/rebasing assets are intentionally unsupported. A later engine recipient change
requires a new router and explicit frontend/indexer configuration.

## Test and publish interfaces

    yarn hardhat compile
    yarn hardhat test test/TipJar.test.ts
    node scripts/update-tip-abis.mjs
    node scripts/update-tip-abis.mjs --check

The last commands synchronize the exact artifact into the sibling frontend and subgraph
repositories without regenerating unrelated ABIs. Tests cover direct receipt/event,
allowance and balance failures, invalid configuration and taxed-transfer rollback.

## Explicit deployment

Set TIP_BRB_TOKEN, TIP_ENGINE and TIP_CHAIN_ID for the intended network and use the
repository's existing signer/network configuration. Review addresses before running:

    yarn hardhat run scripts/deployTipJar.ts --network <configured-network>

The script checks chain ID and 18 token decimals, refuses an existing deployment record,
and writes `deployments/tip-jar-<network>.json` only after a successful deployment receipt.
Verify its address, chain, token, engine, fixed recipient, transaction hash and startBlock;
verify the contract source with the two constructor arguments on the chain explorer.
Do not rerun a deployment after an ambiguous provider error without inspecting the signer.

Pass that record to the subgraph's configure-tips script. Activate the frontend router only
after the new data source is indexed and reconciled. No public deployment is performed by
tests or compilation. No existing protocol deployment or proxy needs upgrading.
