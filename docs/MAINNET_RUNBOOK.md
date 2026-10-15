# Arbitrum One release runbook

Status: preparation only. Use the current evidence and remaining blockers in `MAINNET_FOLLOWUP_2026-10-10.md`, alongside the historical `MAINNET_REVIEW_2026-10-09.md`, before funding/public activation. Initial owner is an explicit EOA, per the user; Safe migration is a later operation. Keep the existing hosting project and existing Sepolia contracts/services.

## 1. Freeze and rehearse

Record reviewed Git commits for all repositories, compiler/settings, lockfiles, artifact hashes, linked-library addresses and explicit proxy storage layouts. Use Node 22 and immutable dependency installs. Patch/triage dependency advisories first. Run full contract tests, subgraph tests/build, frontend tests/lint/typecheck/build and worker tests. Review the pending/skipped tests individually; CI does not substitute for a fork rehearsal.

Run `yarn test:swarm` and `ARBITRUM_FORK_BLOCK=513332057 yarn test:fork:arbitrum` from contracts; retain sanitized JSON from `reports/swarm/` and `reports/fork/`. Configure an archival `ARBITRUM_FORK_URL` securely when needed. The completed rehearsal's limits are documented in the follow-up. Apply the announced October 14 Next security update before release, rerun the dependency audit, and close/review its remaining exceptions.

Rehearse the **same** deploy/configuration/handoff sequence on a pinned Arbitrum fork with contract-size limits enabled. Use real token/router/coordinator interfaces, a gas-capped VRF callback, worst-case winners/jackpot, late/reordered reports, uncertain receipts and stuck withdrawal/funding queues. Preserve an untouched Sepolia branch, manifest, index version, cloud config and Vercel deployment for rollback. Confirm a separate operator can recover from the deployment journal.

## 2. Prepare explicit inputs

Use a dedicated secured deploy/admin EOA, not a browser bot signer. Maintain an offline backup and enough Arbitrum ETH. Keep `BRB_KEY`, RPC credentials and explorer key in Hardhat's existing secure configuration, never tracked files or shell transcripts.

Set these public settings deliberately:

| Variable | Requirement |
| --- | --- |
| `PROTOCOL_ADMIN` | Explicit nonzero EOA initially; can differ from deployer |
| `CRE_WORKFLOW_OWNER` | Dedicated mainnet CRE report owner, verified against hosted workflow metadata |
| `CRE_HTTP_AUTHORIZED_ADDRESS` | Dedicated mainnet round-watcher HTTP signer address |
| `UNISWAP_V2_ROUTER` | Reviewed deployed V2 router; verify factory, WETH, pair bytecode and real BRB/token liquidity |
| `VRF_SUBSCRIPTION_ID` | Existing funded Arbitrum One subscription owned by deployment signer for consumer registration |
| `BRB_TOKEN` | Omit for a new BRB mint to admin; otherwise verify token and provide its historical `BRB_START_BLOCK` |
| `PAYOUT_LANE_COUNT`, `UPKEEP_LANE_COUNT` | Equal, within tested capacity; deploy a matching hosted workflow for every lane |
| `VERIFY_CONTRACTS` | `true` for release; configure explorer API key |

Defaults for native USDC, DAI, LINK, coordinator, gas lanes and CRE forwarder are in `deployProtocolArbitrum.ts`. Recheck [VRF supported networks](https://docs.chain.link/vrf/v2-5/supported-networks) and [production CRE forwarders](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts) on release day. Code existence and token decimals are not code-identity/security proofs. Review any override independently. Ensure adequate LINK **in the subscription**, budget worst-case throughput/gas and configure low-balance alerts.

From `contracts`, preflight sends no transactions:

```sh
REPORT_GAS=false yarn deploy:protocol:arbitrum
```

Inspect chain 42161, signer/admin, subscription owner/consumers, dependency identities and artifact sizes. Funding sufficiency remains an explicit manual gate. The current `protocol-preflight.mjs` is Sepolia-specific; do not present it as a mainnet attestation.

## 3. Deploy contracts after the gates close

Disable concurrent use of the deploy signer: stack deployment predicts CREATE addresses from its nonce. Snapshot public preflight output. Confirm chain/network in the wallet and reviewed release inputs. Then, and only then:

```sh
CONFIRM_MAINNET_DEPLOY=arbitrum-one:42161 REPORT_GAS=false yarn deploy:protocol:arbitrum
```

The script creates `deployments/arbitrum-one-progress.json`, then `deployments/arbitrum-one.json`, configures markets and performs role handoff. It refuses reruns if either exists. On timeout or failure, inspect pending nonce and every chain receipt; the journal is a checkpoint, not a transaction-complete recovery engine. Do not delete it to force a retry. Early failures can leave partial contracts not yet listed in the coarse journal: reconstruct from signer nonce/receipts, verify identities, and resume with a separately reviewed recovery script. Explorer failure can occur after successful deployment; complete verification separately, never redeploy just to verify.

Read back all roles for Engine, SideBet, Registry, Scheduler, Treasury, Funder and CRE authority; ownership of receiver and beacon; bank admin roles; implementations and linked libraries; three assets/decimals/banks; min bets; VRF subscription/coordinator/key hashes and registered consumer; scheduler/receiver/authority allowlists; CRE expected author. Verify BRB, referral, evaluator created by SideBet implementation, all libraries, implementations/proxies, beacon and banks on the explorer. The generated manifest marks verification complete only after the scripted verification calls succeed; independently check every verification link and external dependency too. Mainnet uses strict proxy verification: explorer log lookup failures cannot set the completion flag. Do not fabricate completion flags to pass a build.

Archive the final manifest, all receipts, artifact/layout hashes and verification evidence. `activationApproved=false` is a record, **not an on-chain pause**: inspect actual exposed contract entrypoints and limits before adding liquidity. No global pause is installed by this script.

## 4. Provision isolated mainnet automation

Install/build and simulate the generated project in `contracts/deployments/arbitrum-one-cre`. Keep the original `contracts/cre` Sepolia project unchanged. Verify every generated RPC selector is mainnet; supply its mainnet RPC securely. Generated workflow names have a `biribi-arbitrum-one` prefix; verify distinct registry names/accounts from Sepolia before registering. Register one pre-VRF HTTP workflow and every payout lane. Confirm delivered metadata matches the receiver's expected owner and only `scheduler.performUpkeep(bytes)` is allowlisted. A shared owner authorizes all that owner's workflows; isolate it accordingly.

Create separate mainnet round-watcher/RPC workers by copying current deployment configuration to new worker names and **new Cloudflare Workflow resource names/bindings**. Do not deploy the checked-in default wrangler files over existing testnet workers. Set independent webhook/HMAC secrets, RPC credentials, scheduler/engine addresses and chain ID 42161. Ensure every fallback RPC returns 42161. Keep signing modes/fallbacks explicitly scoped and only allow authorized recovery paths.

Configure BRB/router pairs, liquidity/quote limits, TWAP observations, and a supervised mainnet `scripts/runFundingKeeper.ts` service. Start its read-only mode first. Only enable `FUNDING_APPLY=true` after observing valid quotes and queues; use an isolated minimally funded keeper account. Alert on repeated swap failures, queued age, pending treasury/burn debts and keeper ETH.

Set `FUNDER_ADDRESS` from the verified manifest and `FUNDING_EXPECTED_CHAIN_ID=42161` for both modes. Writes additionally require `CONFIRM_MAINNET_FUNDING=arbitrum-one:42161`; run with `--network arbitrum`. See the follow-up for supervised daily-cycle commands. Measure queue age from events, not the credited amount field.

## 5. Build and stage the mainnet subgraph

From `subgraph`, choose a fresh release directory:

```sh
node scripts/prepare-environment.mjs ../contracts/deployments/arbitrum-one.json /tmp/biribi-mainnet-release
cd /tmp/biribi-mainnet-release
node node_modules/@graphprotocol/graph-cli/bin/run.js codegen
node node_modules/@graphprotocol/graph-cli/bin/run.js build
```

Review all sources/templates, constants and start blocks. This exporter intentionally excludes old Sepolia funders and TipJar. Add a verified mainnet TipJar/source and frontend configuration if launch requires tipping. Preserve enough historical blocks for accounting reconciliation.

Return to `subgraph`. Select/login to the **brb** project. All provided Goldsky administrative release scripts verify the active credential's project ID/name before proceeding. With a deliberately chosen unused immutable version (example only):

```sh
GOLDSKY_BUILD_DIR=/tmp/biribi-mainnet-release/build node scripts/goldsky-deploy.mjs biribi-arbitrum-one/1.0.0
```

Submission is untagged, does not delete old versions and does not prove indexing. Wait for healthy + synced status and no fatal/nonfatal indexing errors. For a first mainnet version, reconcile against chain receipts/events at a pinned indexed block: market creation, token supply, every bank's assets/shares, bets/payouts/fees/jackpot, SideBet economics, funding debts, BRBP governance weights and receiver execution results. Do not compare mainnet totals to Sepolia totals. Existing `validate-deploy.mjs` compares **two versions on the same chain**; pass explicit versions for later upgrades. Run `reconcile-vaults.mjs` with explicit mainnet RPC and the candidate GraphQL endpoint; private endpoints require appropriate authentication support, so use a secured candidate proxy or extend the script rather than stripping protections.

After reviewing saved reconciliation evidence:

```sh
node scripts/goldsky-promote.mjs biribi-arbitrum-one/1.0.0 --validated
```

`--validated` is an operator acknowledgement, not automatic accounting proof. The script checks current health/sync/errors and moves only that name's `prod` tag. Serialize promotion, record the previous target, verify the alias after the change and retain rollback versions. Existing testnet stays `biribi/prod`. Mainnet Turbo pipelines are **not** generated: independently configure new mainnet chain/source/address/name/webhook sinks in BRB, validate before apply, and retain testnet pipelines. Never run legacy `sync:pipeline` for mainnet.

## 6. Preserve one Vercel project with two builds

First create a persistent `testnet` branch from the verified Sepolia frontend state. In the existing Vercel project, bind `testnet.biribi.net` to that branch's Preview deployment, and configure the exact DNS record Vercel provides. Scope Sepolia addresses/RPC/Goldsky upstream, a separate Ably app, webhook/cron/mirror credentials and `NEXT_PUBLIC_DISABLE_INDEXING=true` to that branch. Keep `BOT_PAUSED=true`, and never expose a mainnet signer to Preview/untrusted PRs. Confirm deployment protection permits intended testers and legitimate webhook delivery.

Export public values without provider/account calls:

```sh
# from contracts; output directories must be new
node scripts/export-release-config.mjs ../subgraph/deployments/arbitrum-sepolia.json testnet /tmp/biribi-testnet-config
node scripts/export-release-config.mjs deployments/arbitrum-one.json mainnet /tmp/biribi-mainnet-config
```

Each directory contains public env values, a public frontend manifest and a server env **template**, never secrets. Copy the appropriate manifest into that frontend build's `deployments/` directory. Set the template values in Vercel, including WalletConnect project ID. Use separate Ably apps (shared channel names), secrets and mainnet upstream `biribi-arbitrum-one/prod` within BRB. Use a query-only Goldsky credential where available; keep deploy-admin credentials in the release environment.

Provision HTTPS REST Redis credentials `SECURITY_REDIS_REST_URL` / `SECURITY_REDIS_REST_TOKEN` server-side for distributed limits and one-use auth nonces. Validate atomic EVAL/SET NX support and fail-closed behavior before cutover. Leave `GTM_SECURITY_REVIEWED=false` until the actual container and account access are reviewed. Nonce HTML is dynamic/private/no-store; verify hosting preserves its headers. Run the frontend's production Chrome smoke check as described in `frontend/docs/mainnet-security.md`.

Set `BIRIBI_RELEASE_CHECK=1` for both cutover builds; select the matching `BIRIBI_DEPLOYMENT_MANIFEST`. Production must explicitly set `NEXT_PUBLIC_CHAIN_ENV=mainnet`, `NEXT_PUBLIC_SITE_URL=https://biribi.net`, mainnet addresses/RPC/explorer and `BOT_PAUSED=true`. Release guard runs before `next build`. Two domains pointing to one deployment cannot select different compiled public environments. Build mainnet separately; do not alias the Sepolia bundle onto production. Verify no testnet events arrive through production Ably.

Vercel native crons apply only to production. Keep Sepolia round automation on its current worker and provision authenticated testnet health/digest scheduling if needed; Preview bot signing remains paused. Verify production cron auth/idempotency and low-balance alerts. Disable automatic production-domain assignment during canary preparation if supported by the current plan, then explicitly cut over the reviewed production build. [Branch domains](https://vercel.com/docs/git), [environment variables](https://vercel.com/docs/environment-variables), [cron constraints](https://vercel.com/kb/guide/troubleshooting-vercel-cron-jobs).

## 7. Canary, cutover and recovery

With capped initial liquidity and small real bets, test deposit/approval, losing/winning roulette, jackpot, SideBet settlement, referral, withdrawals and queued withdrawals, swap failure, funding recovery and replayed/late automation. Verify assets/shares and payouts on-chain and in the index, exact chain/explorer links, wallet switch rejection, no false success for reverted/unknown receipts, fresh balances and domain canonical/robots behavior. Publish source/addresses, admin trust assumptions and recovery contact.

Only after reconciliation and alerts pass should the reviewed mainnet build serve `biribi.net`. Observe at least complete round/withdrawal/funding cycles before increasing limits. Monitor VRF LINK/age, round/CRE lag per lane, indexing health/lag, CallFailed events, withdrawal queue age, funder debt/failures, RPC chain/errors, webhook failures and signer ETH.

For frontend/index incidents, roll back to a **same-chain** verified build/index and keep the former version. Reverting production to a Sepolia build would mislead users and is not a mainnet rollback. For contract incidents, contain new activity using reviewed available controls, preserve withdrawals where safe, inspect pending settlement and use a reviewed upgrade/recovery plan; contracts and transferred funds cannot be rolled back by redeploying the website. Never retry unknown transactions or change VRF requests merely to get a preferred outcome.

Later Safe migration: enumerate/grant all protocol roles and each bank role, transfer beacon/receiver ownership and VRF subscription ownership, update workflow-owner binding if the hosted owner changes, secure CRE/cloud/CI accounts, verify readbacks, then revoke EOA roles last. Test that settlement still works and obsolete EOA permissions are gone. A single `DEFAULT_ADMIN_ROLE` transfer does not migrate the whole system.
