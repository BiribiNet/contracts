# Voluntary player protection

`BankVault4626` appends a per-wallet `PlayerProtectionLib.Limits` mapping to its existing ERC-7201 storage. No initializer, registry change or new privileged role is needed. An implementation/beacon upgrade is still required; this branch does not deploy one.

Both `_placeBetCore` (including the permit entry point) and `lockSideBetStake` consume the same per-vault budget before funds move. A revert rolls back usage. Normal settlement, redemption and withdrawal queues do not consult the protection state.

- `setPlayerLimits(dailyLimit, sessionSeconds)` accepts a positive raw-token cap and 60–86400 seconds. First opt-in and reductions apply immediately. Increases wait 24 hours; mixed changes tighten each reduced dimension immediately and schedule the remaining increase. A new request replaces/cancels the previous pending request, never accelerates it.
- Stakes are counted even before opt-in, starting at the implementation upgrade. The daily counter resets at UTC midnight. Winnings/refunds do not replenish the budget. Amounts from different assets are never combined.
- The first accepted stake starts a rolling 24-hour session window. A configured session duration closes further stakes until that window ends. Midnight and configuration changes do not reset the session. A first stake after 24 hours begins a new window.
- `selfExclude(durationSeconds)` accepts 1–365 days and only extends an existing exclusion. No player/admin function can shorten it. As with all upgradeable contracts, an implementation upgrade can change the rules; this is not an immutable guarantee.
- `playerLimits(player)` resolves matured increases and today's spend at read time. Indexer observations are historical and cannot substitute for this RPC read.

Scope is explicitly **one wallet on one vault**. This is not identity-based or protocol-wide exclusion; other wallets/vaults are outside its scope. There is no claim that it prevents all gambling. Existing implementation histories before upgrade are not retroactively counted.

## Validation and rollout

Run `hardhat compile`, `hardhat test test/PlayerProtection.test.ts test/BankVault4626.test.ts test/StuckWithdrawalQueue.test.ts test/SideBet.test.ts test/ZeroBetLegRejection.test.ts` and inspect storage compatibility and deployed bytecode size before any upgrade. Keep the old fields in their original order. `scripts/export-player-protection.mjs` generates the focused frontend ABI from the compiled artifact. The subgraph's BankVault ABI receives the new fragments; its merged events must retain events from historical implementations.

Review all three repository changes together. Stage and re-index the subgraph first, then stage the vault implementation upgrade and verify limits with distinct wallets and markets. Only an approved deployment makes these protections active. No deployment or on-chain transaction was performed while preparing this change.
