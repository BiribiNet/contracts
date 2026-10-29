# Arbitrum One zero-split upgrade — 29 October 2026

**Completed and verified.** The existing engine proxy now supports 0/1, 0/2 and 0/3 split bets; 0/4 and the other invalid zero splits are rejected. The only Solidity logic change is the pure validation/winner helper in RouletteBetLib.

- Chain: Arbitrum One, 42161.
- Existing proxy: [0xfc6474d1594952ef5beb779b97ba69198b4e7625](https://arbiscan.io/address/0xfc6474d1594952ef5beb779b97ba69198b4e7625).
- Previous implementation: `0x8bf0ef0bb643fea71e3facc47b084dd55ad0e20c`.
- Current implementation: [0xa50F1EF3Ae42D8aCE07d1C0747a33A1C8f030193](https://arbiscan.io/address/0xa50F1EF3Ae42D8aCE07d1C0747a33A1C8f030193#code).
- Upgrade transaction: [0xc25251201b7397ae2668a35ac81a7490df9510f95a9219facdebe65278301966](https://arbiscan.io/tx/0xc25251201b7397ae2668a35ac81a7490df9510f95a9219facdebe65278301966).
- Upgrade confirmed at block **519393034**. The proxy address, public ABI and one payout lane are unchanged.
- Initialization payload was empty (`upgradeToAndCall(newImplementation, 0x)`). No initializer, reinitializer, role change or asset transfer was requested by this upgrade.

## Replacement contracts

Four replacement libraries and one implementation were deployed; all unaffected linked libraries were reused. Each exact runtime matched the reviewed address-specific build before changing the proxy, and all five sources were verified on Arbiscan first.

| Contract | Address | Runtime bytes |
| --- | --- | ---: |
| RouletteBetLib | [0x21FaB94a7771402876B0772523B90856679C1e3E](https://arbiscan.io/address/0x21FaB94a7771402876B0772523B90856679C1e3E#code) | 2948 |
| RouletteBetCodecLib | [0x482AEA76783eD79306E45b6FFd73040fa24109D1](https://arbiscan.io/address/0x482AEA76783eD79306E45b6FFd73040fa24109D1#code) | 933 |
| RoulettePayoutSweepLib | [0x2d44A00122e0E8aaA81Cdb3c363149b5F227e5bB](https://arbiscan.io/address/0x2d44A00122e0E8aaA81Cdb3c363149b5F227e5bB#code) | 7599 |
| RouletteUpkeepScanLib | [0x72b9Fa4FB11ec4139447aE463e36BF982A74a46b](https://arbiscan.io/address/0x72b9Fa4FB11ec4139447aE463e36BF982A74a46b#code) | 6154 |
| RouletteEngine | [0xa50F1EF3Ae42D8aCE07d1C0747a33A1C8f030193](https://arbiscan.io/address/0xa50F1EF3Ae42D8aCE07d1C0747a33A1C8f030193#code) | 22379 |

## Constructor values

These six arguments were read from the existing implementation, compared with the fork report, reused exactly for deployment and read back afterward. Constructor immutables were also included in the exact runtime comparisons. The implementation's internal self-address changes naturally with deployment and is not a changed constructor argument.

| Argument | Value | Comparison |
| --- | --- | --- |
| VRF coordinator | `0x3C0Ca683b403E37668AE3DC4FB62F4B29B6f7a3e` | Unchanged |
| VRF key hash, 2 gwei | `0x9e9e46732b32662b9adc6f3abdf6c5e926a666d174a4d6b8e39c4cca76a38897` | Unchanged |
| VRF key hash, 30 gwei | `0x8472ba59cf7134dfe321f4d61a430c4857e8b19cdd5230b09952a92671c24409` | Unchanged |
| VRF key hash, 150 gwei | `0xe9f223d7d83ec85c4f78042a4845af3a1c8df7757b4997b815ce4b8d07aca68c` | Unchanged |
| VRF confirmations | `1` | Unchanged |
| BRB referral | `0x6d19c9d21CE7b2670fC5f142f27d9819DD888544` | Unchanged |

## Validation

1. The baseline, with the helper fix temporarily removed, compiled to all 28 original deployed runtimes. The split fix was restored byte-for-byte.
2. All 56 checked OpenZeppelin Solidity files matched the deployed verified source bytes; contracts and contracts-upgradeable remain 5.6.1. The dependency lockfile did not change. No install command was run.
3. Compiler-derived engine, SideBet and vault storage layouts matched their verified explorer sources, including namespaces and nested types.
4. A protected local fork using the exact newly deployed mainnet replacement addresses passed the actual proxy upgrade, all five outcome/settlement cases, token receipt reconciliation, post-payment physical storage reads and next-round bet simulations. Its upstream gateway forwarded zero transaction submissions.
5. The mainnet upgrade passed signer authority, original implementation, nonce, runtime hash, unchanged-constructor and idle-round checks, plus a simulation, before signing.
6. All **64 engine namespace slots were identical** between the recorded live pre-upgrade block and upgrade receipt block. The proxy implementation slot changed to exactly the reviewed replacement.
7. The final live audit at block **519394584** matched **all 28 current deployed runtimes**, constructor immutables, proxy/wiring checks and the one-lane worker. Arbiscan's proxy implementation link is refreshed.
8. Live read-only checks accepted only zero-split IDs 1, 2 and 3 and verified the exact winning-split arrays for outcomes 0–3. No mainnet wagers were placed as part of this release.

## Cost and evidence

Actual gas cost for all six mainnet transactions: **0.00018120679373 ETH**. The reviewed maximum was 0.000808391084928 ETH. All transaction values were zero; the expenditure was network gas.

- `plan.json`: frozen addresses, creation/runtime hashes, constructor values, exact data and fee bounds.
- `journal.json`: six successful receipts, nonces, transaction hashes and gas costs.
- `mainnet-state-before.json`, `mainnet-state-after.json`: identical 64-slot namespace snapshots.
- `runtime-verification.json`: all 28 current runtime hashes and read-only wiring checks.
- `proxy-explorer-link.json`: successful Arbiscan metadata refresh.
- `actual-address-fork/`: exact-address local fork report and per-outcome raw-storage/payment evidence.

Signed transaction material is kept in a protected local diagnostics directory outside this Git repository. The public records contain no private keys or authenticated RPC URLs. Never blindly rerun deployment or upgrade phases: inspect the saved journal and already-mined hashes first.
