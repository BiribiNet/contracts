# Arbitrum One deployment and Cloudflare keeper

The mainnet deployment uses the address catalog in `scripts/constants/arbitrumOne.ts` and the signing account from Hardhat `BRB_KEY`. It does not load `.env`, RPC overrides, recipient overrides, or CRE settings. The router is the real Uniswap V2 router. Production engine initialization uses predicted CREATE addresses for the registry, treasury and funder; referral and scheduler addresses are checked after deployment. Local tests still use isolated fixture contracts.

The marketing recipient, infrastructure recipient and dedicated keeper EOA must be chosen by the owner and entered in the catalog. Deployment validates all three entries and stops before sending any transaction if one is missing or invalid. Do not substitute a random address, a test account or the administrator's account. New protocol addresses depend on the deployer's nonce; the script records actual deployed addresses in `deployments/arbitrum-one.json`.

## Commands

- `yarn check:dependencies:arbitrum` reads the configured Arbitrum RPC without a signing account and validates dependency code, token decimals, router factory and coordinator gas lanes.
- `yarn typecheck:deployment` checks the deployment entrypoints and their generated contract types.
- `yarn deploy:protocol:arbitrum` broadcasts the protocol deployment after preflight. Fund the deployer with ETH, LINK and native USDC, and fund the dedicated keeper with ETH. Use the deployer exclusively for this release; concurrent sends invalidate CREATE predictions. A progress journal prevents blind reruns after any partial deployment. Configuration transactions are recorded in `arbitrum-one-transactions.jsonl`; inspect the signer's complete nonce range for subscription, CREATE and funding transactions after an interruption.
- `yarn verify:protocol:arbitrum` performs explorer verification separately. It requires the explorer's authentication credential (`ETHERSCAN_API_KEY`); that credential is not an address or a contract-deployment input. Failed verification leaves `verificationComplete` false.
- `yarn deploy:cloudflare:arbitrum` bundles the actual manifest addresses, fixed RPC catalog and lane/market settings into the dedicated keeper. It uses Wrangler's saved OAuth login and uploads only the dedicated `KEEPER_PRIVATE_KEY` as a secret. It validates code, chain, cross-contract wiring, executor approval and keeper gas before uploading. The administrator key is rejected. Temporary secrets have restrictive file permissions and are removed in `finally`; no secrets are written under the repository's deployments directory.

## Worker operation

`cre-automation-starter/src/mainnet.ts` is a dedicated mainnet entrypoint. It imports no CRE execution code and does not depend on Goldsky webhooks. One SQLite-backed Durable Object owns the dedicated keeper EOA. Its alarm polls all configured scheduler lanes, handles roulette and SideBet jobs, waits for each receipt, and periodically processes each market's jackpot funding queue. A minute cron restores the alarm after outages. Transactions are signed and durably saved before broadcast; retries reconcile or rebroadcast the same transaction rather than silently allocating another nonce. A stuck transaction stops subsequent sends and makes readiness fail, so it requires operator recovery rather than accumulating conflicting transactions.

`GET /health` checks configuration and recent keeper execution. An unconfigured worker returns HTTP 503 and schedules no signing work. The public endpoint accepts no transaction calldata or webhook requests. Funding retry exhaustion is logged and makes readiness fail; an administrator must investigate and reset the appropriate retry, rather than the worker overriding the circuit breaker.

Provisioning uses `wrangler.mainnet-provision.jsonc`, with the real Biribi Cloudflare account and a dedicated mainnet worker name. It deploys the actual code and Durable Object without a cron, signer or contract catalog. Activation adds the real mainnet catalog, dedicated signing secret and cron through the validated deployment command. This does not modify the existing testnet watcher or its workflow bindings.

## Outstanding launch requirements

The current genesis allocation sends 300,000 BRB to marketing, 300,000 BRB to infrastructure, and pairs 2,400,000 BRB with the deployer's entire USDC balance. LP tokens remain with the deployer, as already specified by this release. It does **not** seed any of the three bank vaults, create a DAI/BRB pool, or seed a SideBet offer catalog. Choose and fund those allocations before launch. DAI fee conversion needs a liquid direct DAI/BRB pair under the current funder implementation; the worker cannot invent that liquidity.

Deployment and worker readiness are not launch approval. `activationApproved` stays false. The minimum ETH checks do not prove complete gas runway or LINK subscription sufficiency. Confirm bankroll, all funding routes, reviewed SideBet offers, indexer/frontend configuration, source verification, monitoring and bounded live acceptance transactions before launch. Existing contract-level audit findings and the repository-wide TypeScript failures are separate from this deployment-path check.

## Optional RPC proxy authentication

The public RPC catalog works without extra credentials. To use the dedicated authenticated Cloudflare RPC proxy locally, store only its `rpcProxyApiKey` in `scripts/constants/arbitrumOne.local.json` with file permissions 0600. This file is ignored by Git and contains no addresses or RPC URL overrides. No environment variable is used. Do not put the proxy credential in the public address catalog or commit generated Worker bundles containing an authenticated RPC URL.
