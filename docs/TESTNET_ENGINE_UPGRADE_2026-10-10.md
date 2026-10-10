# Arbitrum Sepolia Engine upgrade — 2026-10-10

The existing Engine proxy was upgraded to activate bounded jackpot preparation. Mainnet was untouched. A subsequent settlement exposed an incompatible legacy funder; see [recovery evidence](TESTNET_VRF_RESULT_RECOVERY_2026-10-10.md). The initial idle rehearsal below did not exercise that dependency.

- Chain: Arbitrum Sepolia, 421614.
- Proxy: `0x7eb8110d9E84D3c32fA6468d13Ea2bC81544acf1`.
- Previous implementation: `0x2bDeaA54d941BCF873C2e89fa74bDB3a1bc10a77`.
- New implementation: `0x4FFDD949820B8Cb358ab64985B436Cc8Dd4F68E8`.
- [Upgrade transaction](https://sepolia.arbiscan.io/tx/0x1dd86882d7b666c771619e828cc2754e16af4ce8483d0c92bbca4fdc753969c7), block **317690058**.
- Engine runtime: **22,379 bytes**, below the 24,576-byte limit.

The local fork rehearsal used source block **317689573**, chain 31337, with size limits enforced. It deployed the linked libraries and implementation, impersonated the existing admin locally, upgraded the actual proxy and compared wiring, all three markets' bank assets/shares/token balances, round diagnostics and admin role. The compiler-AST storage-prefix regression also passed.

Live post-upgrade readbacks match the pre-upgrade rehearsal state. Both configured scheduler lanes read successfully and report no work; no VRF request is pending. The testnet is idle at round 2136. No live wager or randomness retry was submitted by this operation. End-to-end settlement under load was tested locally in the preceding swarm; the idle live readback is not itself a live betting/settlement test.

The Engine implementation and all ten linked libraries are verified on Arbiscan. Evidence is in `reports/upgrades/sepolia-engine-{rehearsal,live,postcheck}.json`; the live journal's final status is `verified`. It records library addresses, constructor inputs, starting signer nonce, implementation and upgrade receipt. The existing VRF key hashes, confirmation count, subscription, coordinator and referral were retained exactly.

The configured RPC was unavailable; Arbitrum's public Sepolia endpoint was used. RPC credentials and private signer material were never added to reports. No Goldsky operation was performed. The subgraph's deployment manifest records the new implementation; all indexed source/proxy addresses and historical start blocks remain unchanged.

For future rehearsals, run `scripts/rehearseEngineArbitrumSepolia.ts` on local Hardhat with `RUN_ARBITRUM_FORK=1` to enforce size limits. It requires the secure Hardhat `BRB_KEY` setting only to derive the administrator address, never to broadcast to the source chain. The guarded live upgrade accepts `ENGINE_UPGRADE_REHEARSAL` and a fresh `ENGINE_UPGRADE_JOURNAL`; it rejects mismatched implementation/admin/constructor inputs, pending signer transactions, unfinished rounds and existing journals. Inspect confirmed receipts before any recovery; do not remove a journal to blindly retry. `scripts/verifyEngineArbitrumSepoliaUpgrade.ts` performs read-only postchecks against the saved evidence.
