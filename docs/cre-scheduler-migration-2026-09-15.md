# Arbitrum Sepolia scheduler migration — 2026-09-15

Read-only checks at block 309239639 found a scheduler configuration mismatch. The engine authorizes `0xC95749f8a6c10AaE755bc10086bE252A73f4FF69`; the checked-in CRE targets still used `0xad1f181ad88aee13a6643104941ecea2b963c2d7`.

The old scheduler's `performUpkeep` reverted in eth_call with `0x103b7db1` (`UnauthorizedScheduler`). At the same state the new scheduler's action succeeded in eth_call. No transaction was broadcast. Round 803 had not requested VRF, despite its countdown having ended on 2026-09-15 at 17:41:38 UTC.

The subscription held 15.950079503464559663 LINK; its owner wallet held 62.522061403837496623 LINK. The new scheduler was allowed by the receiver and held SideBet's SETTLEMENT_ROLE; SideBet referenced the same engine, had 4 bets and a 2592000-second expiry. These checks validate wiring and the current trigger action, not every possible side-bet payout or the private CRE account's billing status.

## Apply the configuration to deployed workflows

Changing these JSON files or merging this PR does not update live CRE workflows.

1. In the authenticated CRE organization, inspect the actual active workflow targets. Update the existing pre-VRF workflow and every active payout lane that still uses the old scheduler. Preserve workflow names, registry, authorized keys, lane count and trigger settings.
2. From the `cre` project directory, redeploy each existing target with its original name/registry using the matching target in `workflow.yaml`. For example, if the deployed pre-VRF target is `trigger-vrf-production-settings`:

   ```sh
   cre workflow deploy workflows/biribi-roulette-lane --target trigger-vrf-production-settings
   ```

3. Updating a workflow changes its workflow ID. Update the external round-watcher's workflow ID and any receiver ID validation where configured. Verify the workflow is active; updates preserve the previous active/paused status.
4. Align `NEXT_PUBLIC_UPKEEP_SCHEDULER_ADDRESS` in the frontend's Arbitrum Sepolia deployment and any round-watcher scheduler configuration with the engine-authorized address. Do not send LINK to the scheduler address as a remedy.
5. Verify a real `VrfRequested` for the waiting round, then `VRFResult`, payouts and the next round. Verify side-bet settlement on each active lane. An eth_call success alone does not prove live CRE delivery.

CRE was not authenticated in this workspace; no live workflow was inspected or redeployed. If live workflows already target the new scheduler, inspect their execution errors and the HTTP round-watcher delivery separately; the repository drift alone does not prove their private deployed configuration.

Source: [Chainlink workflow updates](https://docs.chain.link/cre/guides/operations/updating-deployed-workflows).
