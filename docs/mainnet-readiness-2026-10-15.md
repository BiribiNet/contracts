> Historical audit snapshot from before the deployment and withdrawal follow-up fixes. Findings below describe the audited revision and are not a current launch approval. See `docs/arbitrum-one-keeper-deployment.md` and `deployments/arbitrum-one-deployment-review.json` for the later deployment status; rerun release checks against the final candidate before launch.

# Mainnet readiness review — 15 October 2026

**Decision: NO-GO for Arbitrum One with the current deployment path.** Storage compatibility is encouraging, but it does not resolve the deployment, authorization, liveness and migration findings below. This review changed audit tooling and test fixtures only; no production contract or deployment script was fixed, and no public-network transaction was sent.

Reviewed contracts revision: `7dc9bb6` (full hash in the evidence JSON). Reference for the source/storage comparison: recorded testnet release `df898f08c8eb822dd772903f01d25fad6e5d251f`. Existing untracked deployment reports and scripts were preserved. The 9 October reports are historical evidence, not a current mainnet sign-off.

Scope: Solidity implementation and linked libraries; production deploy and upgrade scripts; governance and recovery paths; local contract, worker and RPC tests; frontend chain selection and indexer/CRE configuration; public Arbitrum dependency reads. No mainnet protocol manifest exists locally, so actual protocol ownership, subscription funding, pools, deployed workflows and end-to-end mainnet operation remain unverified. This is an engineering readiness review, not a completed independent security audit.

## Findings and release decisions

**Follow-up review:** The distinctions below refine the original severity wording. The forwarder/admin controls work; missing workflow authorization is a separate boundary. The confirmed callback failure used a privileged 2,000-lane setting; the normal ten-lane configuration has now passed explicit capped callback tests. An immutable variable pointing at an upgradeable proxy is compatible with upgrading that proxy. Entirely non-proxied modules have different replacement constraints. See the follow-up details below; these findings should not be described as four equivalent permissionless exploits.

| ID | Priority | Finding | Required resolution |
|---|---|---|---|
| M01 | High; conditional delivery | CRE receiver accepts DON-valid forwarded reports without requiring the expected workflow author/ID. A local report redirected a roulette winner's payment to a different account. This requires valid delivery through the trusted forwarder, not an EOA signature bypass. | Require an authorized workflow identity before activation, verify multi-lane identity policy, transfer receiver ownership to governance, and run negative identity/report tests. |
| M02 | High | The production script's default USDC address is wrong and has no mainnet contract code. | Correct the default; reject nonexistent/wrong-chain token, router, forwarder and coordinator addresses before spending deployment gas. |
| M03 | High | A separate `PROTOCOL_ADMIN` makes deployment fail after contracts are created: the deployer attempts privileged calls despite assigning roles to the other admin. | Implement and rehearse a complete bootstrap/configure/handoff flow or generate executable multisig configuration batches. |
| M04 | High | A token-blocked withdrawal receiver causes `_processQueue` to revert inside market finalization. The global round cannot complete. | Isolate failing withdrawals without losing their claims or burning unpaid shares; provide a safe owner recovery/receiver-change route; test blocked winners too. |
| M05 | Admin guardrail / capacity validation | VRF callback work grows with markets, winning entries and lane count. An accepted admin-only 2,000-lane configuration fails within the callback budget; normal ten-lane tests passed up to 3,000 winning legs across three markets. | Bound admin configuration; establish supported traffic limits with capped callback tests. This is not a demonstrated default-setting callback failure. |
| M06 | High | VRF recovery re-requests randomness after 24 hours; there is no general roulette cancellation/refund path or subscription/gas setter. | Review fairness and coordinator failure semantics, remove/restrict unsafe re-draw behavior, and rehearse an explicit recovery mechanism. A retry cannot repair deterministic callback gas failure. |
| M07 | Architecture decision | Treasury and registry are non-proxied contracts without ordinary state migration paths; the new funder cannot export its reserved funding queues. Immutable references to proxy addresses are not themselves a defect. | Accept and document the replacement constraints, or implement/rehearse easier migration/upgrade paths to meet the requested upgradeability objective. These contracts do not all inherently need proxies. |
| M08 | High | Current collectors enqueue funding, while no funding keeper is installed by deployment or the round watcher's Wrangler configuration. | Install and supervise funding processing, oracle warm-up, retry reset alerts, operator funding and queue reconciliation. |
| M09 | High | The production manifest uses `addresses.engine`; indexer sync expects `addresses.roulette`. Its `startBlock` is captured after market creation. | Align the manifest schema and capture per-contract creation blocks; prove every initial market registration and bank template is indexed. |
| M10 | Release gate | The complete test suite and repository-wide TypeScript check are not green. Mainnet deployment, governance handoff and live upgrade rehearsals are absent. | Resolve/triage failures, run the supported Node 22 release checks, and retain a pinned mainnet-fork rehearsal plus limited live acceptance evidence. |

### M01: workflow authorization is a fund-safety boundary

`scripts/utils/deployCreAutomation.ts` deploys the receiver, approves it on the authority, and allowlists `performUpkeep(bytes)`. It never sets `setExpectedAuthor`, `setExpectedWorkflowId` or workflow-name validation, and never transfers receiver ownership. `ReceiverTemplate.onReport` skips metadata validation when all expectations are zero.

`RouletteEngine._payPreparedRows` checks a cursor and aggregate liability, but trusts the recipient/amount rows in the report. The audit test changed the recipient in a valid payout bundle and delivered it through a mock of the authorized forwarder: the altered recipient received the payout. **This is not evidence that an arbitrary EOA can directly impersonate the real forwarder.** It proves that sender-only authentication is insufficient when another workflow can obtain delivery through that shared forwarder. Identity hardening is required before trusting these report-supplied payments. Review the remaining trust placed in an authorized workflow/DON separately; workflow pinning alone does not make the payment rows trustless.

### M02/M03: the deploy command can fail after spending gas

At pinned mainnet block `515006790` (`0x3ad1ed4104db10094db1e20102165212f4e89f30a2936cb0cabed82f35cb5612`):

- Script default: `0xaf88d065e77c8cC2239327C2EDb1aB17869eD1BE`; normalized address has **zero code**.
- Circle's Arbitrum USDC: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`; code exists and `decimals() == 6`.
- The default coordinator and production forwarder match Chainlink's directory and have code. DAI and LINK have code and 18 decimals. This does not verify a project subscription or a usable BRB pool.

Sources: [Circle's Arbitrum USDC publication](https://www.circle.com/blog/usdc-on-arbitrum-now-available), [Chainlink VRF networks](https://docs.chain.link/vrf/v2-5/supported-networks), [CRE forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts). On-chain measurements are in `deployments/mainnet-dependencies-2026-10-15.json`.

The role mismatch occurs inside `deployRouletteEngine` when granting the scheduler `SETTLEMENT_ROLE` from the deployer after SideBet admin was assigned to the separate protocol admin. Later `setVaultBeacon`, market creation, lane configuration and authority configuration have the same signer/admin issue. VRF consumer registration also requires subscription-owner authorization, which is not prevalidated before deployment.

Using the deployer as admin avoids that mismatch but leaves a governance handoff unfinished. A valid production flow must configure everything, prove the destination multisig/timelock can execute, transfer the beacon and receiver ownership, grant every operational/admin role, then revoke temporary privileges. Persist every transaction/nonce/address as it completes, rather than writing the only manifest at the end.

### M04/M05/M06: ways the protocol can remain stuck

**Reachability clarified after follow-up:** A withdrawal destination need not be the LP owner and need not hold LP shares. `_enqueueWithdrawal` checks the requesting owner and its shares, but only requires that the destination is nonzero. Therefore an unblocked LP may intentionally choose an already-blacklisted destination; the LP does not need the power to blacklist anyone. The updated local test sets the destination's blocked status **before** enqueueing. At Arbitrum block `515015343`, a read of native USDC's `isBlacklisted(USDC_ADDRESS)` returned true. Its own token address is one concrete nonzero blocked destination. See `deployments/usdc-recipient-review-2026-10-15.json`. Circle's [`transfer` implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/FiatTokenV1.sol) rejects blacklisted destinations; the [blacklister role](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol) belongs to the issuer, not normal LPs. This review did not send a real USDC transfer or queue a public withdrawal.

**Callback capacity measured after follow-up:** `test/VrfCallbackBudget.test.ts` calls the actual engine `rawFulfillRandomWords` from its locally impersonated configured coordinator with an explicit **2,500,000 transaction gas limit**, keeping the normal **ten lanes**. Three populated markets with 110 winning straight legs each succeeded at **1,089,118 transaction gas used**; three with 1,000 each succeeded at **1,545,688**. Receipt gas can reflect refunds; successful completion within the fixed transaction budget is the key result. This covers the actual callback, not DON delivery/billing or every outcome/market shape. Existing crowd tests exercise settlement but call a mock fulfillment helper without an explicit callback cap; `GasScaling.test.ts` measures the request/trigger path, not fulfillment. The 2,000-lane failure is privileged misconfiguration, and is recorded as such. Results: `deployments/vrf-callback-budget-2026-10-15.json`.

The queue test models a token that refuses transfers to a particular receiver. A legitimate queued withdrawal to that receiver makes `processWithdrawalQueue` revert from `_finalizeMarketSettlement`; all changes in that settlement transaction roll back. The market remains restricted and the shared round stays open for settlement, preventing the next round. No withdrawal cancellation or receiver-edit entry point was found. `drainWithdrawalQueue` is useful for quiet markets but cannot bypass the same failing head transfer or the settling restriction. Direct winner transfers in `payoutBatch` and treasury `payBatch` also deserve failure isolation; the queue reproduction is confirmed, while blocked-winner behavior was inspected in source rather than separately reproduced.

The callback loops over registry markets, over winning buckets' lengths, and over lanes in `RoulettePayoutSweepLib`. The minimum stake is enforced per ticket, so a one-USDC ticket can contain 250 positive red legs of 0.004 USDC each. Repeated duplicate legs have no per-round count cap. The local test proved that such a ticket is accepted and that setting 2,000 lanes is accepted, then fulfillment fails at 2.5M gas and reducing the lane count is rejected during settlement. This configuration requires a privileged lane setter; **no exact player-count threshold at the default ten lanes has been certified**. A larger synthetic bucket stress hit the local Node heap limit and is not counted as a completed benchmark.

The public coordinator reports a 2.5M maximum callback gas limit. Merely funding LINK or requesting another draw does not reduce callback work. Mainnet's configured 2.5M is already at that maximum. The subscription ID and callback gas limit are stored but have no regular setters; the coordinator, lane keys, confirmations and referral address are implementation immutables. Changing them requires an engine implementation upgrade and explicit treatment of outstanding requests.

Chainlink says not to re-request randomness for a commitment and warns that failed callbacks are not retried automatically. The 24-hour delay does not by itself prove a request is irrecoverably expired, unbiased, or safe to replace. See [VRF security considerations](https://docs.chain.link/vrf/v2-5/security). SideBet also accepts a ticket while the start round's request is pending, as long as fulfillment is not yet stored; review that ordering against the same guidance on freezing user inputs before requesting randomness. No claim is made here of a permissionless public-mempool attack on Arbitrum.

## Storage and upgradeability

**Immutable reference versus immutable module:** `immutable ENGINE` pointing at the engine's UUPS proxy is fine: the address stays constant while the implementation behind it changes. Likewise, an immutable value in an upgradeable implementation can change when a new implementation is deployed, subject to a deliberate immutable/configuration review. That does not make the contract containing an immutable reference upgradeable. `JackpotTreasury`, `MarketRegistry` and `BRBJackpotFunder` are deployed directly; their own code has no proxy upgrade operation. They can still be workable immutable modules with accepted replacement plans. The concern is the user's requested ease of future replacement/state migration, not a general prohibition on Solidity `immutable`.

Compiler-derived comparison, including nested structs/mappings/arrays, slots, offsets and field types, passed against the recorded reference source. The script verifies candidate build inputs against local sources and reconstructs reference sources from Git with an unchanged dependency lockfile. It is **not** an assertion that the currently live testnet bytecode still equals that source revision.

| Implementation | Custom fields | Ordinary storage | Namespace result | Mechanism / authority |
|---|---:|---|---|---|
| RouletteEngine | 44 → 44 | None | Preserved; ERC-7201 formula matches | UUPS; `DEFAULT_ADMIN_ROLE` |
| SideBet | 11 → 11 | `ENGINE` slot 0, `REGISTRY` slot 1 preserved | Preserved; ERC-7201 formula matches | UUPS; `DEFAULT_ADMIN_ROLE` |
| BankVault4626 | 14 → 14 | None | Preserved; ERC-7201 formula matches | Shared `UpgradeableBeacon`; beacon owner |

Namespace roots:

```text
RouletteEngine  0x8a653c570a28b92a786a8846d2fb5907e111615753e347ab6161fea696c7eb00
SideBet         0x1846f22cbddf11ab4f03976bc184e4c229eb24d5ca6fd07bdce57e89b8a62c00
BankVault4626   0xb0c430920bd46af8c5ecb68ebf1a5f6f3805a863a6d4fa0fa5e65feb72f8e800
```

The force build explicitly warns that the engine namespace, defined in a library, is omitted from normal OpenZeppelin namespaced-layout validation. **Keep the additional compiler probe in CI.** Do not rely on empty ordinary storage or `validateImplementation` as an engine layout check. Parent OpenZeppelin namespaces use the unchanged dependency source closure; dependency upgrades still need their own layout comparison.

OZ implementation safety validation passes for SideBet and the vault. Engine validation passes only with explicit constructor/immutable/external-library exceptions, which require review: the base VRF constructor sets an immutable coordinator, and linked libraries execute in proxy context. No storage checks were skipped by the custom comparison. The stock plugin's cached unlink scan also failed on a shorter candidate; `auditUpgradeSafety.ts` validates the exact artifact version through upgrades-core instead.

All 25 inspected production contracts/libraries fit EIP-170. Current engine runtime: **22,410 bytes**; SideBet: **22,197**; vault: **15,094**; funder: **16,656**. Engine has 2,166 bytes of headroom and SideBet 2,379. The audit network enforces contract-size limits. The evaluator is replaced along with a new SideBet implementation because it is an immutable constructor-created dependency; verify that child using the SideBet build, not only a standalone artifact.

A local **same-version replacement rehearsal** passed for both UUPS proxies and the shared vault beacon while a roulette request, an active side bet, reserves, LP shares and a queued withdrawal existed. It preserved captured state/configuration/roles, rejected unauthorized upgrades, checked UUPS UUIDs and SideBet initializer locks, then settled the original request and side bet and processed the withdrawal. This proves the current mechanisms work in that local fixture. It does not prove a future version, historical implementation migration, live-fork state, populated multi-market beacon migration, partial jackpot migration or outstanding funding queue migration.

`BankVault4626` has no `_disableInitializers()` constructor. A local unrelated account initialized the standalone implementation and acquired its local admin role. That does not grant roles on the beacon proxies, but implementation locking should be added before launch. Review initializer input validation too; the registry supplies valid inputs, but direct vault initialization does not validate all critical addresses.

### Every important contract's future upgrade path

| Contract | Upgrade in place? | Replacement / migration constraints |
|---|---|---|
| RouletteEngine | Yes, UUPS | Preserve library namespace, linked code and constructor immutables; coordinate any coordinator change with pending requests. |
| SideBet | Yes, UUPS | Preserve ordinary slots and namespaced bet/config structs; preserve active reserves; replace/verify evaluator; preserve scheduler ABI compatibility. |
| BankVault4626 | Yes, shared beacon | One owner transaction changes every vault using that beacon. Every market needs state/accounting checks; a bad implementation affects all of them. There is no per-vault canary upgrade on that shared beacon. |
| MarketRegistry | No | Engine and SideBet retain its address; registry holds market/asset mappings and immutable engine/SideBet references. No normal import/replacement setter exists. A custom migration/implementation plan is needed. Changing `vaultBeacon` affects future banks, not existing BeaconProxy beacons. |
| JackpotTreasury | No | Engine can select a new treasury, but the old pool does not move. Only the engine can call `payBatch`; the treasury admin role has no pool-migration method. A reviewed engine migration upgrade could move funds, but that is not a routine replacement path. Finish any snapshotted jackpot before cutover. |
| BRBJackpotFunder | No | Engine can select a replacement; SideBet reads the engine's active funder. Router/token/treasury/collector references are immutable. Reserved queues and pending BRB are protected from sweeps; keep the old funder serviced or drain it. `importFunding` on a new funder does not export old reserves. Permanently failing queued input has no ordinary migration/cancel method. |
| UpkeepScheduler | No | Engine setter supports replacement; grant new SideBet settlement role, wire authority/receiver and workflows, reconcile lane cursors and revoke old roles. No direct cursor-import method; settled history may need rescanning. |
| AutomationReceiver | No | Forwarder/identity/call permissions are configurable by owner. Redeployment needs authority approval plus every workflow receiver address changed, followed by old receiver revocation. Owner currently defaults to deployer. |
| CreExecutionAuthority | No | Executors configurable by roles; scheduler can point at a replacement authority. Preserve an approved emergency executor and test revocation. |
| BRBToken | No | Fixed token address and supply model. Replacing it affects holders, pools, treasury and funder; there is no ordinary token upgrade. Confirm this is intentional. |
| BRBReferal | No | Immutable engine binding; engine immutable points at referral. A replacement requires a new engine implementation and an explicit balance/history policy. |
| LPVestingLock | No, intentionally | Fixed token and three-year cliff. Beneficiary/admin roles can rotate but cannot shorten the cliff. Production deploy does not create/fund this lock. |
| ProtocolTimelock | No | Fixed 24-hour delay. It exists in source but production deploy does not instantiate or wire it. Target authorities must actually belong to the timelock, with bypass roles revoked. |
| TipJar | No, low custody | Token/recipient captured immutably; replace and update frontend/indexer when either changes. No normal retained tip balance. |
| SideBetChallengeEvaluator | No directly | Replace through SideBet UUPS implementation's immutable dependency. |
| Linked engine libraries | Through engine implementation | Deploy new libraries, preserve exact storage/ABI, link new engine, validate and upgrade. Library addresses themselves are not proxies. |

Current public upgrade commands are Sepolia-specific, EOA-signer oriented and do not automatically perform a full layout diff or multisig simulation. They are not ready-made mainnet upgrade commands. The SideBet script also chooses `initializeReservedAccounting()` whenever `betCount == 0`; repeated upgrades of an empty proxy already initialized to version 2 can fail. Determine migration version/need explicitly rather than inferring it solely from a zero bet count. The engine verification library map omits `JackpotBatchLib`, although deployment links it; reconcile that before relying on automatic verification.

## Complete launch checklist

PASS means a specific check completed, LIMITED means only the stated local/source scope passed, FAIL means a concrete issue, and UNVERIFIED means required deployment/operator evidence is absent.

| Area | Check | Status / evidence or next action |
|---|---|---|
| Release | Reproducible compiler/source candidate | PASS: Node 22 force compile, 179 Solidity files; preserve exact inputs/settings/lockfile. |
| Release | Bytecode size limits | PASS: 25 production artifacts/libraries below EIP-170; audit network enforces limits. |
| Release | Complete contract suite | FAIL: 446 passing, 3 failing, 4 skipped on initial Node 23 run; three failures reproduced on Node 22. |
| Release | Focused protocol CI regressions | PASS: 143 tests on Node 22. |
| Release | Read-only preflight tests | PASS: 7 tests. |
| Release | Worker and RPC tests/types | PASS: worker 96 tests; RPC 27 tests; both typechecks passed. |
| Release | Whole contracts/CRE TypeScript build | FAIL: repository-wide `tsc --noEmit` reports SDK resolution/version, filesystem declarations and viem/harness type errors. |
| Release | Independent review and invariant/fuzz evidence | UNVERIFIED: no new independent audit or completed fuzz campaign claimed. |
| Storage | Engine library namespace and nested storage | PASS for source comparison; additional compiler probe required. |
| Storage | SideBet ordinary storage and namespaced storage | PASS for source comparison; slots 0/1 and 11 custom fields preserved. |
| Storage | Vault layout and inherited dependency stability | PASS for source comparison with unchanged lockfile/source closure. |
| Upgrades | Unauthorized upgrade rejection / UUPS UUID | PASS in local rehearsal. |
| Upgrades | Implementation initializer locking | FAIL for standalone BankVault4626; SideBet lock checked locally; engine source disables initializers. |
| Upgrades | Active bets / VRF / reserves / withdrawal continuity | LIMITED: same-version local fixture passed; pinned live-fork version transition still required. |
| Upgrades | All markets after shared beacon upgrade | UNVERIFIED: rehearse populated multi-market fixtures/fork and per-vault migration calls if needed. |
| Upgrades | Treasury, registry and queued-funder replacement | FAIL for the requested easy-migration objective; no ordinary complete migration paths. |
| Upgrades | Mainnet multisig calldata/runbook | UNVERIFIED: existing upgrade commands target Sepolia. |
| Governance | Distinct deployer/admin deployment | FAIL: reproduced role mismatch. |
| Governance | Timelock / multisig authority and recovery | UNVERIFIED: specify Safe signers/threshold, timelock roles, beacon owner, all admin/operational roles and backup process. |
| Governance | Receiver ownership handoff | FAIL in deploy path: remains deployer-owned. |
| Governance | Role renunciation / bypass prevention | UNVERIFIED: prove governance works before revoking deployer; do not renounce the last recoverable authority. |
| Dependencies | Correct native USDC | FAIL: wrong default, zero code. |
| Dependencies | Chainlink coordinator/forwarder / DAI / LINK | PASS for pinned public code/config reads and official directory comparison; not a subscription or workflow health check. |
| Dependencies | Router, factory, pair hash, token pair identities | UNVERIFIED: choose production-compatible router and verify factory/pair derivation against real pools. Local Uniswap flag remains possible on chain 42161. |
| VRF | Subscription owner, proxy consumer and funding runway | UNVERIFIED: no mainnet subscription supplied; EOA wallet LINK is not subscription LINK. |
| VRF | Distinct 2/30/150 gwei lane defaults | FAIL in default wiring: `vrfKeyHashTriple(default2)` makes all three equal the 2-gwei key unless overridden; declared 30/150 defaults are unused. |
| VRF | Callback gas / bet and lane growth bounds | LIMITED PASS at ten lanes: 330 and 3,000 winning legs over three markets succeeded under an enforced 2.5M callback transaction budget. Admin-only excessive lane count still lacks a guard; global capacity bound not certified. |
| VRF | Failure recovery and no unsafe re-draw | FAIL / design review required: admin retry replaces commitment; no general refund/cancel recovery. |
| VRF | Late SideBet placement policy | REVIEW REQUIRED: pending-request placement is allowed until outcome stored. |
| Automation | Expected workflow identity required | FAIL: empty expectations and redirected-payment reproduction. |
| Automation | All payout lanes and HTTP round trigger | FAIL / UNVERIFIED live: config permits fewer workflows than on-chain lanes. Every lane must have an executor; otherwise its winners remain unpaid. Deploy exact chain/receiver/scheduler/trigger keys. |
| Automation | Missed-event recovery, outages and replay | LIMITED: local regressions pass; rehearse missed webhook, RPC outage and workflow restart on target chain. Monitor `CallFailed`, not just successful receiver tx receipts. |
| Automation | CRE target RPC chain configuration | UNVERIFIED / configuration work required: `cre/project.yaml` binds named lane0/lane1/trigger production targets to Sepolia RPC aliases; regenerate matching mainnet target entries for every lane. Generating mainnet JSON alone does not correct those aliases. |
| Automation | Permissioned emergency executor | UNVERIFIED: approve/test a controlled backup; the round scheduler is not permissionless. |
| Funding | Queue accounting and protected sweeps | PASS locally: funding regressions and two reconciliation identities tested; mainnet balances still unverified. |
| Funding | Supervised queue processing and reset alerts | UNVERIFIED / operational blocker: permissionless callable functions do not execute themselves; five failures stop a market until admin reset. |
| Funding | TWAP warm-up and cold-quote policy | UNVERIFIED: deploy observations/processing; approve slippage, reserve cap, cold-price behavior and sandwich risk on real liquidity. |
| Liquidity | Vault capital vs roulette + SideBet liabilities | LIMITED: collision and liability tests pass; approve actual per-market capital and stake limits. Never sum unlike tokens as collateral. |
| Liquidity | BRB pools, ownership and three-year LP lock | UNVERIFIED: deploy script creates neither funded production pools nor funded LPVestingLock. |
| Economics | Ticket fee policy and LP margin | UNVERIFIED approval: current merged source charges positive ticket profit independently; price every active offer after 3% swap + 2% infra fee and operating costs. |
| Catalogue | Mainnet seed/configuration tools | FAIL for turnkey launch: catalogue scripts reuse the Sepolia-only chain guard; mainnet-safe tooling and an approved exact catalogue are needed. |
| Catalogue | Expiry and quiet-market refunds | LIMITED: local SideBet expiry tests pass; keep nonzero timeout and funded settlement automation. |
| Withdrawals | Quiet-market permissionless queue drain | PASS locally; restricted appropriately while roulette liabilities remain. |
| Withdrawals | Blocked receiver / unpayable winner isolation | FAIL: queue case reproduced; direct payout transfer risks inspected. |
| Assets | Supported ERC20 semantics | REQUIRED CONSTRAINT: standard non-rebasing/non-taxed tokens only for vault/funding accounting; operational pause/blacklist risks remain. |
| Indexer | Manifest schema and start blocks | FAIL: `engine`/`roulette` mismatch; end-of-deployment start block can miss registration/template creation. |
| Indexer | Mainnet reindex, historical sources and balances | UNVERIFIED: Arbitrum One catalog locally contains zero placeholders; reconcile before activation. |
| Frontend | Mainnet chain/address/index endpoint coherence | UNVERIFIED deployment: code supports mainnet but defaults to testnet; set exact reviewed addresses and chain env, verify direct reads and receipt/index behavior. |
| Operations | Monitoring and incident ownership | UNVERIFIED: stale VRF, round age, lane progress, low LINK/ETH, stopped funding, liabilities, RPC/index lag and failed calls need tested alerts. |
| Acceptance | Pinned mainnet fork plus limited live lifecycle | UNVERIFIED: deploy/handoff, deposit, roulette, SideBet win/loss/expiry, withdrawal, funding, jackpot and upgrade/recovery rehearsal. |

### Existing test failures

The same three tests fail on Node 22 with audit gas reporting disabled:

1. `BranchCoverage100.test.ts:514`: reuses market 1 with BRB after binding it to USDC; current funder correctly raises `AssetMismatch`.
2. `BranchCoverage100Gap.test.ts:464`: hand-built jackpot-only report refreshes the roulette shard cursor rather than the jackpot cursor; current engine raises `StaleJackpotChunk`.
3. `BranchCoverage100Remain16.test.ts:342`: same stale jackpot cursor construction.

These look like fixtures lagging deliberate safety changes, not evidence that the normal scheduler generates those errors. They still need repaired tests and a green supported-runtime full suite. Four original tests were skipped, including the opt-in Sepolia fork suite; a skipped test is not a passed upgrade rehearsal. The six audit probes pass by confirming current mechanisms and vulnerabilities, not by declaring the vulnerabilities fixed.

## Release and upgrade procedure to establish before mainnet

1. Resolve confirmed blockers and release failures; add the M05 configuration guardrail and settle the M07 architecture decision. Decide which directly deployed contracts should gain upgradeability or explicit migrations, and which immutable modules can retain documented replacement constraints. Document the authority/trust tradeoff. Freeze the reviewed candidate commit, compiler inputs, library links and dependency lockfile.
2. Prepare a read-only deployment plan with a validated token/router/coordinator/forwarder catalog, subscription owner/consumer plan, governance role matrix, funds/runway, calldata and incremental transaction journal. Rehearse distinct deployer and governance accounts on a pinned mainnet fork.
3. Bootstrap and hand off the complete authority graph. Deploy and test workflow identities/lane coverage, backup executor, supervised funding keeper and alerts. Require positive evidence of governance execution before removing temporary deployer roles.
4. Fund and lock approved liquidity, initialize observations, seed exact reviewed offers and reconcile solvency/fees per asset. Index from actual creation blocks with a schema-compatible manifest. Verify sources, libraries, proxy slots, evaluator and every bank/beacon relationship.
5. Before each upgrade, prove the deployed code/source baseline, compare all ordinary and namespaced storage including nested array strides, review immutable/library changes, and simulate the exact multisig/timelock calls against captured live states. Exercise pending VRF, partially paid roulette/jackpots, active SideBet reserves, queued withdrawals and queued/pending funder balances. A beacon upgrade does not run a reinitializer on its vaults automatically.
6. Coordinate a safe betting/cutover window. There is no general pause function today, so define an on-chain admission-control design that preserves settlements/withdrawals before relying on a maintenance window. Retain valid outstanding randomness; do not simply switch coordinator mid-request. Preserve old funder service/history until its liabilities are actually cleared. Reversing an implementation address is not a rollback of state migrations.
7. Run bounded real acceptance transactions after deployment and before broad launch. Reconcile receipts, payments, reserves, governance and alerts. Mark each UNVERIFIED row complete with dated evidence, then make the launch decision again.

## Evidence and rerun commands

- `deployments/mainnet-storage-2026-10-15.json`: recursive compiler layouts and source-reference comparison.
- `deployments/mainnet-build-2026-10-15.json`: sizes, computed roots and safety validation/explicit exceptions.
- `deployments/mainnet-dependencies-2026-10-15.json`: pinned public mainnet dependency reads.
- `deployments/mainnet-audit-2026-10-15/`: captured test/build logs and summary.
- `test/MainnetReadinessAudit.test.ts`: six local reproductions/rehearsal probes.
- `contracts/test/MockBlockedRecipient.sol`: isolated token failure fixture; not a production contract.
- `test/VrfCallbackBudget.test.ts`: explicit normal-configuration callback-budget measurements.
- `deployments/mainnet-audit-2026-10-15/followup-review.log` and `followup-boundaries.log`: additional local tests.

### Follow-up: exact CRE boundary

Re-reviewed `ReceiverTemplate`, `AutomationReceiver`, `CreExecutionAuthority`, scheduler permissions and the installed Chainlink `KeystoneForwarder` source. The owner alone can change our receiver forwarder/call permissions. An arbitrary wallet cannot call the receiver directly, cannot authorize itself on the scheduler, cannot use Chainlink's protected `route`, and cannot submit unsigned reports through `report`.

However, the Chainlink contract's `report` validates signatures against a DON/configuration, then routes to the chosen consumer. It does not apply a consumer-specific Biribi workflow owner allowlist. A different authorized CRE workflow can produce a valid signed report without compromising the forwarder or forging DON signatures. Whether a particular external actor can deploy and operate such a workflow depends on CRE access; no unauthorized production workflow was deployed during this review.

The additional local test uses the **actual installed Chainlink forwarder implementation** and locally configured test DON signers, rather than the permissive forwarding mock. It confirms signature-count rejection, protected-route and direct-receiver rejection, and separately checks consumer-owner authorization on a valid signed report. With expectations unset, the report executes; setting `expectedAuthor` to Biribi's owner rejects a different owner's signed report. These test DON private keys are not production DON keys, so this is a boundary test, not proof that anyone can forge production reports. Chainlink explicitly distinguishes forwarder authentication from [workflow ID/owner authorization](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts). For multiple Biribi lanes sharing one owner, setting the correct expected owner is compatible with accepting all of those workflows; a single fixed workflow ID would require a multi-workflow design.

Use Node 22. No deployment/upgrade commands are needed to rerun these local checks:

```bash
yarn hardhat compile --force --config hardhat.audit.config.ts
python3 scripts/auditStorageLayouts.py
yarn hardhat run --no-compile --config hardhat.audit.config.ts scripts/auditUpgradeSafety.ts
yarn hardhat test --no-compile --config hardhat.audit.config.ts test/MainnetReadinessAudit.test.ts
node --test scripts/protocol-preflight.test.mjs
node scripts/auditMainnetDependencies.mjs  # public read-only RPC
```

The audit tooling complements [OpenZeppelin's upgrade validation](https://docs.openzeppelin.com/upgrades-plugins); a successful structural check does not certify application migrations or operating readiness.
