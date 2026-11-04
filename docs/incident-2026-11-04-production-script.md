# Production recovery script and local fork rehearsal

Entry point: `scripts/incident20261104-mainnet.cjs`.
Shared execution sequence: `scripts/incident20261104-execution.cjs`.
Local fork setup: `scripts/incident20261104-fork.cjs`.

**Completed on Arbitrum mainnet (42161) on 2026-11-04: all 9 transactions confirmed.** Cloudflare automation stays stopped. Keeper approval and the scheduler's SideBet settlement role are preserved. The recovery is complete; the execution preflight rejects an already recovered state.

## Mainnet result

- Incident holder's vault shares: **0**.
- Tickets **9–13** cancelled with no refund; bank lock and side-bet reserve both **0**.
- Bank BRB, holder liquid BRB and BRB supply unchanged by recovery.
- Side bets disabled; both recovery functions removed from the final implementations.
- Keeper approval and scheduler settlement role retained.
- Withdrawal queue length/head unchanged at **0/0**; no queue drain was called.
- Mainnet receipts, implementation runtime hashes and final storage/getters independently read back successfully.

[Recovery transaction](https://arbiscan.io/tx/0xf8b5c580d8dba7963ef04b80b91eeba4983e641baa1046847d959d5165ed6187), [bank cleanup upgrade](https://arbiscan.io/tx/0x31890e2921bdb26748e9a680bb1b6b61f698c46f6739afad3c588208e37ee52d), [SideBet cleanup upgrade](https://arbiscan.io/tx/0xffa3439fb2d25cbfbce1f5276268d850810eb9726c7f873aca6900d5fdd3ca5e).

Final bank implementation: `0x129cAf686c2489685841Ef1E9d442Fd8b963797D`.
Final SideBet implementation: `0xc097778ffDF918Df9777B32251D0A5f6139C00A6`.

Execution journal: `reports/incident-2026-11-04/mainnet-execution-2026-11-04T18-59-44-816Z.json`.
Independent verification: `reports/incident-2026-11-04/mainnet-verification.json`.

## Explorer source verification

- Active SideBet `0xc097778ffDF918Df9777B32251D0A5f6139C00A6`: **Exact Match** on Arbiscan.
- Active bank `0x129cAf686c2489685841Ef1E9d442Fd8b963797D`: Arbiscan **Similar Match** to the original bank implementation. Submitting its exact compiler input returns **Already Verified**, and the explorer retains the Similar Match label.
- Both temporary recovery implementations: **Exact Match**.

All four saved compiler inputs were independently compiled and matched byte-for-byte against their actual deployment transaction inputs. The active bank's executable bytecode, excluding the Solidity metadata trailer, also matches the original bank. This independent reproduction does not change Arbiscan's displayed Similar Match classification.

Verification used only explorer API submissions and read-only chain queries; no additional blockchain transactions were sent. The sources and settings are saved in `reports/incident-2026-11-04/compiler-inputs/`, with status in `reports/incident-2026-11-04/explorer-verification.json`. The reusable publication/check command is `node scripts/verifyIncident20261104.cjs`.

## Rehearse the production script

From the contracts directory:

```sh
INCIDENT_FORK_BLOCK=521259858 node scripts/incident20261104-mainnet.cjs --fork
```

This compiles the contracts, validates the deployed/recovery/cleanup storage layouts and code sizes, runs 10 execution-guard tests and 24 targeted contract tests, and forks the last successful pre-recovery Arbitrum snapshot. Pinning the block reproduces the incident now that mainnet has been recovered. Omitting `INCIDENT_FORK_BLOCK` selects the latest state, which is already recovered and fails the incident preflight.

Execution uses an in-process Hardhat node with chain ID **31337**, contract-size enforcement enabled and the admin impersonated locally. Mainnet RPC access passes through a read-only relay. The fork branch does not construct a private-key wallet. It calls the **same `executeRecovery` function** used by the production branch. The historical recovery artifacts and pre-recovery deployment manifest are archived separately; current Solidity sources and the live deployment manifest stay aligned with the final mainnet implementations.

## Shared production sequence

The script sends and confirms 9 sequential transactions:

1. Deploy the temporary bank recovery implementation.
2. Deploy the temporary SideBet recovery implementation.
3. Deploy the bank implementation with recovery removed.
4. Deploy the SideBet implementation with recovery removed.
5. Upgrade SideBet and set the stored `sideBetsDisabled` flag to true atomically.
6. Upgrade the bank beacon to the temporary recovery implementation.
7. Call the bank recovery: burn the incident holder's shares, cancel tickets 9–13 without refund and release their exact reserves in one transaction.
8. Upgrade the beacon to the bank implementation without recovery.
9. Upgrade SideBet to the implementation without recovery, retaining the disable flag.

All four implementations are deployed before installing either recovery implementation. The complete sequence spans multiple transactions; the share burn and ticket cancellation themselves are atomic.

No keeper approval or scheduler role is revoked. The worker remains paused in Cloudflare, while the SideBet disable flag blocks placement and both settlement entry points even for an authorized scheduler. Preserving approval allows normal automation to be restored later. The Cloudflare pause stops this worker; it is not a contract-level pause of every authorized caller.

## Guards and reports

Before the first transaction, the script verifies the execution chain and admin signer, admin/owner roles, original implementations, deployed bank bytecode, absence of pending VRF/resolution, expected active tickets, reserve accounting, legitimate share supply and absence of pending admin transactions.

It rechecks the execution chain and expected admin nonce before every submission. It rechecks incident balances, shares, reserves, tickets, protected positions and other banks before installing the recovery implementations and immediately before recovery. Unexpected state stops execution.

Each submitted transaction hash is journaled before waiting for its receipt. There are no automatic write retries. If an execution stops after submissions, inspect its journal and chain state before restarting; the script intentionally rejects an already recovered state.

Recovery must leave bank BRB, holder liquid BRB, BRB supply and checked unrelated positions unchanged. After cleanup, the script verifies the clean implementation addresses, unavailable recovery selectors, admin/owner permissions, disabled side bets and preservation of the recovered state. Keeper approval and the scheduler's settlement role must equal their pre-execution values, including at intermediate preflight checks.

The current fork runner executes only those same 9 production transactions. It does not add a queue drain, test deposit/withdrawal, extra upgrade or false/true flag toggle. Local impersonation and the local gas-balance override live in the separate fork setup file, which the mainnet branch does not invoke. Recovery's `releaseBets` callback only updates the liquidity lock; it does not process withdrawals.

Results: `reports/incident-2026-11-04/mainnet-script-fork-rehearsal.json`.
Sizes: `reports/incident-2026-11-04/bytecode-sizes.json`.
Storage layouts: `reports/incident-2026-11-04/storage-validation.json`.

## Tests of normal operations after cleanup

`test/IncidentPostCleanup.test.ts` deploys the exact generated cleanup bytecode for both contracts behind their proxies, then checks preserved LP balances, NAV, token balances, admin roles, beacon ownership, the disable flag and scheduler role. It verifies that the still-authorized scheduler receives `SideBetsDisabled` when attempting side-bet settlement.

For both 6- and 18-decimal assets, it then places a normal roulette wager, verifies unchanged NAV/deposit pricing at bet placement, queues a withdrawal, requests and fulfills mock VRF, settles through the real scheduler/engine, checks the payout and normal engine-driven queue processing, and deposits again afterward. It does not call `drainWithdrawalQueue`. These operations run on isolated local test deployments, not in the production sequence or against mainnet.

Earlier 11-transaction rehearsals included authority revocations and are superseded by the 9-transaction plan above. Earlier fork-only extra-upgrade and deposit/withdrawal probes passed; they are not part of the current production command.

The revised 9-transaction production sequence passed on a fresh fork of Arbitrum block **521259858**, executing entirely on chain **31337**. Keeper approval and the scheduler settlement role were **true before and after** execution. Side bets finished disabled, both recovery functions were removed, and checked balances/positions were preserved. All 24 contract tests and 10 execution-guard tests passed. No mainnet transaction was sent.

## Mainnet execution branch

The production branch requires explicit `--mainnet` selection and `INCIDENT_MAINNET_CONFIRM=arbitrum-one:42161`. It checks actual RPC chain ID **42161**, rejects a Hardhat node, and requires the configured signer to match admin `0x90416a578646be1c3b2e6aa0A2F593445ca3Ebce`. It loads the RPC and signer from Hardhat variables only in that branch; no keys are written into reports.

Mainnet execution produces a separate timestamped `mainnet-execution-*.json` journal. It includes only the production sequence: no impersonation, injected storage, test deposits, test upgrades or temporary re-enabling of side bets. Running the fork command does not authorize or trigger this branch. The approved execution completed with admin nonces **295–303**; the post-execution nonce is **304**.

## Repository release validation

After promoting the exact cleanup sources into `contracts/`, the full local Solidity suite passed **519 tests**, with **13 opt-in tests skipped**. The 23 Node execution-guard, ABI-export and preflight tests passed. The archived recovery sequence replayed successfully at block 521259858 on local chain 31337, with exactly 9 transactions and permissions retained. No additional mainnet transactions were sent during repository cleanup.
