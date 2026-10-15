import hre, { artifacts, ethers } from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';

const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
async function main() {
  const manifest = JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json', 'utf8'));
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 421614n) throw new Error('Wrong chain');
  const block = await ethers.provider.getBlockNumber();
  const [signer] = await ethers.getSigners();
  const read = async (address: string, signature: string, fn: string, args: any[] = []) =>
    new ethers.Contract(address, [signature], ethers.provider)[fn](...args, { blockTag: block });
  const rows: any[] = [];
  const seen = new Set<string>();
  async function compare(name: string, address: string): Promise<void> {
    if (seen.has(name + address.toLowerCase())) return;
    seen.add(name + address.toLowerCase());
    const artifact = await artifacts.readArtifact(name);
    // The evaluator is created inside SideBet's viaIR build, not its standalone default build.
    const build = await artifacts.getBuildInfo(name === 'SideBetChallengeEvaluator' ? 'contracts/SideBet.sol:SideBet' : `${artifact.sourceName}:${artifact.contractName}`);
    if (!build) throw new Error(`Missing build info ${name}`);
    const compiled = build.output.contracts[artifact.sourceName][artifact.contractName].evm.deployedBytecode;
    const code = await ethers.provider.getCode(address, block);
    let local = compiled.object;
    let actual = code.slice(2);
    const refs: any[] = Object.values(compiled.immutableReferences ?? {}).flat();
    const libraries: any[] = [];
    for (const [source, names] of Object.entries(compiled.linkReferences ?? {})) {
      for (const [library, positions] of Object.entries(names)) {
        const positionsTyped = positions as { start: number; length: number }[];
        const linked = '0x' + actual.slice(positionsTyped[0].start * 2, (positionsTyped[0].start + 20) * 2);
        libraries.push({ library, address: linked });
        refs.push(...positionsTyped);
      }
    }
    // Solidity libraries embed their own deployment address behind PUSH20.
    if (local.startsWith('73' + '0'.repeat(40))) refs.push({ start: 1, length: 20 });
    const immutables = refs.map(({ start, length }) => ({ start, length, value: '0x' + actual.slice(start * 2, (start + length) * 2) }));
    for (const { start, length } of refs) {
      local = local.slice(0, start * 2) + '0'.repeat(length * 2) + local.slice((start + length) * 2);
      actual = actual.slice(0, start * 2) + '0'.repeat(length * 2) + actual.slice((start + length) * 2);
    }
    rows.push({ name, address, matches: local.toLowerCase() === actual.toLowerCase(), bytes: (code.length - 2) / 2, localBytes: compiled.object.length / 2, codeHash: ethers.keccak256(code), libraries, immutables });
    console.log(name, address, rows[rows.length - 1].matches ? 'MATCH' : 'DIFF');
    if (local.toLowerCase() === actual.toLowerCase()) {
      for (const linked of libraries) await compare(linked.library, linked.address);
    }
  }
  const implementation = async (address: string) => ethers.getAddress('0x' + (await ethers.provider.getStorage(address, slot, block)).slice(-40));
  const a = manifest.addresses;
  const beacon = await read(a.registry, 'function vaultBeacon() view returns(address)', 'vaultBeacon');
  const vaultImpl = await read(beacon, 'function implementation() view returns(address)', 'implementation');
  const scheduler = await read(a.roulette, 'function UPKEEP_SCHEDULER() view returns(address)', 'UPKEEP_SCHEDULER');
  for (const [name, address] of [
    ['RouletteEngine', await implementation(a.roulette)], ['SideBet', await implementation(a.sideBet)],
    ['BankVault4626', vaultImpl], ['MarketRegistry', a.registry], ['UpkeepScheduler', scheduler],
    ['BRBToken', a.brb], ['BRBReferal', a.brbReferal], ['BRBJackpotFunder', a.jackpotFunder],
    ['JackpotTreasury', a.jackpotTreasury], ['CreExecutionAuthority', a.creExecutionAuthority],
    ['AutomationReceiver', a.automationReceiver],
  ]) await compare(name, address);
  if (process.env.AUDIT_POST === 'true') {
    const rollout = JSON.parse(readFileSync('deployments/rollout-2026-10-09-live.json','utf8'));
    await compare('TipJar', rollout.tipJar.address);
    await compare('SideBetChallengeEvaluator', rollout.challengeEvaluator);
  }
  const infra = await read(a.roulette, 'function INFRA_RECIPIENT() view returns(address)', 'INFRA_RECIPIENT');
  const report = { revision: process.env.AUDIT_REVISION, chainId: Number(chain.chainId), block, signer: signer.address,
    balance: ethers.formatEther(await ethers.provider.getBalance(signer.address)), nonce: await ethers.provider.getTransactionCount(signer.address),
    scheduler, manifestScheduler: a.scheduler, infraRecipient: infra,
    sideBetConfigCount: String(await read(a.sideBet, 'function configCount() view returns(uint256)', 'configCount')),
    rows };
  writeFileSync(process.env.AUDIT_OUTPUT || (process.env.AUDIT_POST === 'true' ? 'deployments/post-audit-2026-10-09.json' : 'deployments/live-audit-2026-10-09.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
