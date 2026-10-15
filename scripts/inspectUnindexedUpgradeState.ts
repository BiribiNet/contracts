import { ethers } from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 421614n) throw new Error('Expected Arbitrum Sepolia');
  const manifest = JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json', 'utf8'));
  const preflight = JSON.parse(readFileSync('deployments/unindexed-preflight-2026-10-15.json', 'utf8'));
  const folder = 'deployments/unindexed-upgrade-2026-10-15';
  const a = manifest.addresses;
  const block = await ethers.provider.getBlockNumber();
  const at = { blockTag: block };
  const read = (name: string, address: string) => {
    const source = JSON.parse(readFileSync(`${folder}/${name}-verified.json`, 'utf8'));
    return new ethers.Contract(address, JSON.parse(source.ABI), ethers.provider) as any;
  };
  const engine = read('RouletteEngine', a.roulette);
  const funder = read('BRBJackpotFunder', await engine.JACKPOT_FUNDER(at));
  const receiver = read('AutomationReceiver', a.automationReceiver);
  const authority = read('CreExecutionAuthority', a.creExecutionAuthority);
  const registry: any = await ethers.getContractAt('MarketRegistry', a.registry);
  const beaconAddress = await registry.vaultBeacon(at);
  const beacon: any = new ethers.Contract(beaconAddress, ['function owner() view returns(address)', 'function implementation() view returns(address)'], ethers.provider);
  const signer = preflight.signer;
  const scheduler: any = await ethers.getContractAt('UpkeepScheduler', a.scheduler);
  const banks = [];
  for (let id = 1; id <= Number(await registry.marketCount(at)); id++) {
    const market = await registry.getMarket(id, at);
    const bank: any = await ethers.getContractAt('BankVault4626', market.bank);
    const token: any = new ethers.Contract(market.asset, ['function balanceOf(address) view returns(uint256)'], ethers.provider);
    banks.push({ id, asset: market.asset, bank: market.bank, totalAssets: await bank.totalAssets(at), totalSupply: await bank.totalSupply(at), locked: await bank.lockedBetLiquidity(at),
      oldFunderAssetBalance: await token.balanceOf(await funder.getAddress(), at), queuedFunding: funder.interface.hasFunction('fundingAccounts') ? Array.from(await funder.fundingAccounts(id, at)) : null, pendingBrb: Array.from(await funder.pendingBrbByMarket(id, at)) });
  }
  const report = {
    chainId: 421614, block, blockHash: (await ethers.provider.getBlock(block))!.hash, signer,
    roles: { engineAdmin: await engine.hasRole(ethers.ZeroHash, signer, at), engineFeeAdmin: await engine.hasRole(await engine.ENGINE_FEE_ROLE(at), signer, at),
      beaconOwner: await beacon.owner(at), funderAdmin: await funder.hasRole(await funder.FUNDER_ADMIN_ROLE(at), signer, at),
      schedulerAdmin: await scheduler.hasRole(await scheduler.SCHEDULER_ADMIN_ROLE(at), signer, at), authorityAdmin: await authority.hasRole(ethers.ZeroHash, signer, at), receiverOwner: await receiver.owner(at) },
    engine: { proxy: a.roulette, round: await engine.currentGlobalRound(at), pendingVrf: await engine.hasPendingVrf(at), scheduler: await engine.UPKEEP_SCHEDULER(at),
      constructorArguments: [manifest.vrf.coordinator, await engine.VRF_KEY_HASH_2_GWEI(at), await engine.VRF_KEY_HASH_30_GWEI(at), await engine.VRF_KEY_HASH_150_GWEI(at), await engine.VRF_CONFIRMATIONS(at), await engine.BRB_REFERRAL(at)] },
    vaultBeacon: { address: beaconAddress, implementation: await beacon.implementation(at) },
    funder: { address: await funder.getAddress(), constructorArguments: [await funder.engine(at), await funder.brb(at), await funder.router(at), await funder.jackpotTreasury(at), await funder.sideBet(at), signer],
      policies: Object.fromEntries(await Promise.all(['swapAssetTotalBps', 'slippageBps', 'coldSlippageBps', 'twapWindowSeconds', 'treasuryBrbNumerator', 'treasuryBrbDenominator'].map(async name => [name, await funder[name](at)]))),
      maxSwapReserveBps: funder.interface.hasFunction('maxSwapReserveBps') ? await funder.maxSwapReserveBps(at) : null, pendingTreasuryBrb: await funder.pendingTreasuryBrb(at), pendingBurnBrb: await funder.pendingBurnBrb(at) },
    receiver: { address: a.automationReceiver, forwarder: await receiver.getForwarderAddress(at), expectedAuthor: await receiver.getExpectedAuthor(at), expectedWorkflowId: await receiver.getExpectedWorkflowId(at), expectedWorkflowName: await receiver.getExpectedWorkflowName(at),
      schedulerAllowed: await receiver.isCallAllowed(a.scheduler, ethers.id('performUpkeep(bytes)').slice(0, 10), at) },
    authority: { address: await scheduler.forwarderAuthority(at), oldReceiverApproved: await authority.isApprovedAutomationForwarder(a.automationReceiver, at), operatorApproved: await authority.isApprovedAutomationForwarder(signer, at) },
    banks,
  };
  const output = JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  writeFileSync(`${folder}/live-state.json`, output + '\n');
  console.log(output);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
