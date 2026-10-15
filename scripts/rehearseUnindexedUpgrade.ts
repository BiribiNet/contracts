/** Fork-only rehearsal. This script refuses public networks and never broadcasts there. */
import { ethers, network } from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';

const folder = 'deployments/unindexed-upgrade-2026-10-15';
const json = (name: string) => JSON.parse(readFileSync(`${folder}/${name}`, 'utf8'));
const stringify = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
async function main() {
  if (network.name !== 'hardhat' || (await ethers.provider.getNetwork()).chainId !== 31337n) throw new Error('Fork-only script');
  const state = json('live-state.json');
  const summary = json('build-summary.json');
  const manifest = JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json', 'utf8'));
  const rpc = process.env.FORK_RPC_URL || 'https://arbitrum-sepolia-rpc.publicnode.com';
  await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: rpc, blockNumber: state.block } }] });
  const pinned = await ethers.provider.getBlock(state.block);
  if (pinned?.hash !== state.blockHash) throw new Error('Pinned block hash mismatch');
  await network.provider.request({ method: 'hardhat_impersonateAccount', params: [state.signer] });
  await network.provider.request({ method: 'hardhat_setBalance', params: [state.signer, '0x56BC75E2D63100000'] });
  const signer = await ethers.getSigner(state.signer);
  const baselineCodes = new Map<string, string>();
  const oldLibraries = new Map<string, string>();
  const baselineChecks: unknown[] = [];
  const transactions: unknown[] = [];
  const deployments: Record<string, any> = {};
  const baseline = Object.fromEntries(summary.map((row: any) => [row.name, json(`${row.name}-baseline-output.json`)]));
  const candidates = Object.fromEntries(summary.map((row: any) => [row.name, json(`${row.name}-candidate-output.json`)]));
  function normalized(code: string, compiled: any) {
    let value = code.replace(/^0x/, '').toLowerCase();
    const refs: any[] = Object.values(compiled.immutableReferences || {}).flat();
    for (const names of Object.values(compiled.linkReferences || {}) as any[]) for (const positions of Object.values(names) as any[]) refs.push(...positions);
    if (compiled.object.startsWith('73' + '0'.repeat(40))) refs.push({ start: 1, length: 20 });
    for (const { start, length } of refs) value = value.slice(0, start * 2) + '0'.repeat(length * 2) + value.slice((start + length) * 2);
    return value;
  }
  async function checkBaseline(group: string, source: string, name: string, address: string) {
    const compiled = baseline[group].contracts[source][name].evm.deployedBytecode;
    const actual = await ethers.provider.getCode(address);
    if (normalized(actual, compiled) !== normalized(compiled.object, compiled)) throw new Error(`Deployed source mismatch: ${name} ${address}`);
    baselineCodes.set(`${group}:${source}:${name}`, actual);
    baselineChecks.push({ name, address, codeHash: ethers.keccak256(actual), verifiedSourceRecompiled: true });
    for (const [path, names] of Object.entries(compiled.linkReferences) as [string, any][]) for (const [lib, positions] of Object.entries(names) as [string, any][]) {
      const p = positions[0];
      const linked = ethers.getAddress('0x' + actual.slice(2 + p.start * 2, 2 + (p.start + p.length) * 2));
      oldLibraries.set(`${path}:${lib}`, linked);
      await checkBaseline(group, path, lib, linked);
    }
  }
  for (const row of summary) await checkBaseline(row.name, row.sourcePath, row.name, row.oldAddress);
  const implementation = ethers.getAddress('0x' + (await ethers.provider.getStorage(state.engine.proxy, slot)).slice(-40));
  if (implementation !== ethers.getAddress(summary.find((r: any) => r.name === 'RouletteEngine').oldAddress)) throw new Error('Engine implementation drift');
  const engineRow = summary.find((r: any) => r.name === 'RouletteEngine');
  const engine: any = new ethers.Contract(state.engine.proxy, baseline.RouletteEngine.contracts[engineRow.sourcePath].RouletteEngine.abi, signer);
  const beacon: any = new ethers.Contract(state.vaultBeacon.address, ['function owner() view returns(address)', 'function implementation() view returns(address)', 'function upgradeTo(address)'], signer);
  if (!await engine.hasRole(ethers.ZeroHash, state.signer) || (await beacon.owner()).toLowerCase() !== state.signer.toLowerCase()) throw new Error('Upgrade permissions missing');
  const snapshot = async () => {
    const banks = [];
    for (const row of state.banks) {
      const bank: any = await ethers.getContractAt('BankVault4626', row.bank);
      banks.push({ address: row.bank, assets: await bank.totalAssets(), shares: await bank.totalSupply(), locked: await bank.lockedBetLiquidity(), marketId: await bank.marketId(), sideBetController: await bank.sideBetController() });
    }
    return { banks, round: await engine.currentGlobalRound(), pendingVrf: await engine.hasPendingVrf(), registry: await engine.REGISTRY(), scheduler: await engine.UPKEEP_SCHEDULER(), treasury: await engine.JACKPOT_TREASURY(), funder: await engine.JACKPOT_FUNDER() };
  };
  const before = await snapshot();
  const deploy = async (group: string, source: string, name: string, args: any[] = []): Promise<any> => {
    const key = `${source}:${name}`;
    if (deployments[key]) return new ethers.Contract(deployments[key].address, candidates[group].contracts[source][name].abi, signer);
    const compiled = candidates[group].contracts[source][name];
    let bytecode = compiled.evm.bytecode.object;
    let runtime = compiled.evm.deployedBytecode.object;
    const links: Record<string, string> = {};
    for (const [path, names] of Object.entries(compiled.evm.bytecode.linkReferences) as [string, any][]) for (const lib of Object.keys(names)) {
      const dependency = await deploy(group, path, lib);
      const address = await dependency.getAddress(); links[`${path}:${lib}`] = address;
      for (const p of names[lib]) bytecode = bytecode.slice(0, p.start * 2) + address.slice(2) + bytecode.slice((p.start + p.length) * 2);
      for (const p of compiled.evm.deployedBytecode.linkReferences[path]?.[lib] || []) runtime = runtime.slice(0, p.start * 2) + address.slice(2) + runtime.slice((p.start + p.length) * 2);
    }
    const old = oldLibraries.get(key);
    if (old && normalized(await ethers.provider.getCode(old), { ...compiled.evm.deployedBytecode, linkReferences: {} }) === normalized(runtime, { ...compiled.evm.deployedBytecode, linkReferences: {} })) {
      deployments[key] = { address: old, reused: true, libraries: links }; return new ethers.Contract(old, compiled.abi, signer);
    }
    const deployed: any = await new ethers.ContractFactory(compiled.abi, '0x' + bytecode, signer).deploy(...args);
    const receipt = await deployed.deploymentTransaction().wait();
    if (receipt.status !== 1) throw new Error(`Deployment failed ${name}`);
    const address = await deployed.getAddress();
    const actual = await ethers.provider.getCode(address);
    if (normalized(actual, { ...compiled.evm.deployedBytecode, linkReferences: {} }) !== normalized(runtime, { ...compiled.evm.deployedBytecode, linkReferences: {} })) throw new Error(`Candidate runtime mismatch ${name}`);
    const prior = baselineCodes.get(`${group}:${source}:${name}`);
    if (prior && args.length && baseline[group].contracts[source][name]) {
      const oldRefs = baseline[group].contracts[source][name].evm.deployedBytecode.immutableReferences || {};
      for (const [id, positions] of Object.entries(compiled.evm.deployedBytecode.immutableReferences || {}) as [string, any][]) {
        const previous = oldRefs[id]?.[0]; if (!previous) throw new Error(`Missing original immutable ${name}:${id}`);
        const previousValue = prior.slice(2 + previous.start * 2, 2 + (previous.start + previous.length) * 2);
        for (const p of positions) {
          const nextValue = actual.slice(2 + p.start * 2, 2 + (p.start + p.length) * 2);
          // AST 1477 in this verified build is OpenZeppelin UUPSUpgradeable.__self.
          // It must track the new implementation; protocol configuration must stay exact.
          const oldImplementation = summary.find((row: any) => row.name === group)?.oldAddress;
          const selfRotation = group === 'RouletteEngine' && name === 'RouletteEngine' && id === '1477'
            && previousValue.toLowerCase() === ethers.zeroPadValue(oldImplementation, p.length).slice(2).toLowerCase()
            && nextValue.toLowerCase() === ethers.zeroPadValue(address, p.length).slice(2).toLowerCase();
          if (nextValue !== previousValue && !selfRotation) throw new Error(`Immutable changed ${name}:${id}`);
        }
      }
    }
    deployments[key] = { address, args, libraries: links, runtimeBytes: (actual.length - 2) / 2 };
    transactions.push({ label: `deploy ${key}`, hash: receipt.hash, gasUsed: receipt.gasUsed });
    console.log('Rehearsed deployment', name, address);
    return deployed;
  };
  const next: Record<string, any> = {};
  for (const row of summary) {
    const args = row.name === 'RouletteEngine' ? state.engine.constructorArguments : row.name === 'BRBJackpotFunder' ? state.funder.constructorArguments : row.name === 'TipJar' ? [manifest.addresses.brb, state.engine.proxy] : row.name === 'CreExecutionAuthority' ? [state.signer] : row.name === 'AutomationReceiver' ? [state.receiver.forwarder] : [];
    next[row.name] = await deploy(row.name, row.sourcePath, row.name, args);
  }
  for (const [label, action] of [ ['upgrade engine', () => engine.upgradeToAndCall(next.RouletteEngine.target, '0x')], ['upgrade vault beacon', () => beacon.upgradeTo(next.BankVault4626.target)] ] as const) {
    const receipt = await (await action()).wait(); if (receipt.status !== 1) throw new Error(label + ' failed');
    transactions.push({ label, hash: receipt.hash, gasUsed: receipt.gasUsed });
    if (stringify(before) !== stringify(await snapshot())) throw new Error(`Protocol state changed during ${label}`);
  }
  if ((await ethers.provider.getStorage(state.engine.proxy, slot)).slice(-40).toLowerCase() !== next.RouletteEngine.target.slice(2).toLowerCase() || (await beacon.implementation()).toLowerCase() !== next.BankVault4626.target.toLowerCase()) throw new Error('Implementation pointer verification failed');
  const report = { complete: true, mode: 'fork-only', chainId: 31337, sourceChainId: 421614, sourceBlock: state.block, sourceBlockHash: state.blockHash,
    signer: state.signer, baselineChecks, deployments, transactions, before, after: await snapshot(), engineAndVaultStatePreserved: true,
    replacementsDeployedButNotActivated: ['BRBJackpotFunder', 'TipJar', 'CreExecutionAuthority', 'AutomationReceiver'],
    outstandingActivationRequirements: ['Select event-only versus all-local-change scope', 'Restore CRE authentication before changing receiver routing', 'Prepare block-aware indexer/mirror and frontend cutover', 'Preserve all authority approvals, receiver allowlists, funder policies and retained liabilities during replacement'] };
  writeFileSync(`${folder}/fork-rehearsal.json`, stringify(report) + '\n');
  console.log('Fork rehearsal passed; no public-network transactions sent.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
