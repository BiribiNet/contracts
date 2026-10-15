import hre, { ethers, artifacts, network } from 'hardhat';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const live = process.env.LIVE_APPLY === 'true';
const journalPath = `deployments/pr-rollout-2026-10-09-${live ? 'live' : 'fork'}.json`;
const resume = process.env.LIVE_RESUME === 'true';
const journal: any = resume && existsSync(journalPath) ? JSON.parse(readFileSync(journalPath,'utf8')) : { chainId: live ? 421614 : 31337, transactions: [], deployments: {}, checks: [] };
const save = () => writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
let started = false;
async function main() {
  if (existsSync(journalPath) && !resume) throw new Error(`Existing journal ${journalPath}: inspect before resuming`);
  if (journal.complete) throw new Error('This rollout is already complete');
  const catalog = JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json', 'utf8'));
  const audit = JSON.parse(readFileSync('deployments/pr-review-before-2026-10-09.json', 'utf8'));
  if (live) {
    const rehearsal = JSON.parse(readFileSync('deployments/pr-rollout-2026-10-09-fork.json','utf8'));
    const storage = JSON.parse(readFileSync('deployments/pr-storage-check-2026-10-09.json','utf8'));
    if (!rehearsal.complete || !storage.every((r:any)=>r.compatible)) throw new Error('Prerequisites missing');
  }
  if (!live) {
    if (network.name !== 'hardhat') throw new Error('Simulation requires hardhat');
    await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: process.env.FORK_RPC_URL || 'https://arbitrum-sepolia-rpc.publicnode.com', blockNumber: Number(process.env.FORK_BLOCK || audit.block) } }] });
    await network.provider.request({ method: 'hardhat_impersonateAccount', params: [audit.signer] });
    await network.provider.request({ method: 'hardhat_setBalance', params: [audit.signer, '0x56BC75E2D63100000'] });
  }
  if ((await ethers.provider.getNetwork()).chainId !== BigInt(journal.chainId)) throw new Error('Wrong chain');
  const baseSigner = live ? (await ethers.getSigners())[0] : await ethers.getSigner(audit.signer);
  const signer: any = new ethers.NonceManager(baseSigner);
  signer.address = baseSigner.address;
  if (signer.address.toLowerCase() !== audit.signer.toLowerCase()) throw new Error('Wrong signer');
  journal.signer = signer.address;
  journal.sourceBlock = !live && process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : audit.block;
  journal.revision = 'df898f08c8eb822dd772903f01d25fad6e5d251f';
  started = true;
  save();
  const a = catalog.addresses;
  const engine: any = await ethers.getContractAt('RouletteEngine', a.roulette, signer);
  const side: any = await ethers.getContractAt('SideBet', a.sideBet, signer);
  const registry: any = await ethers.getContractAt('MarketRegistry', a.registry, signer);
  const beacon: any = new ethers.Contract(await registry.vaultBeacon(), ['function implementation() view returns(address)', 'function owner() view returns(address)', 'function upgradeTo(address)'], signer);
  for (const contract of [engine, side]) if (!await contract.hasRole(ethers.ZeroHash, signer.address)) throw new Error('Missing admin');
  if ((await beacon.owner()).toLowerCase() !== signer.address.toLowerCase()) throw new Error('Missing beacon owner');
  if (!await engine.hasRole(await engine.ENGINE_FEE_ROLE(), signer.address)) throw new Error('Missing engine fee role');
  const expectedReserved = new Map<number, bigint>([ [1,0n], [2,0n], [3,0n] ]);
  const betCount = await side.betCount();
  console.log('Preflight', { live, betCount: String(betCount) });
  for (let id = 0n; id < betCount; id++) {
    const bet = await side.getBet(id);
    if (Number(bet.status) === 0) expectedReserved.set(Number(bet.marketId), (expectedReserved.get(Number(bet.marketId)) ?? 0n) + bet.payout);
  }
  for (const [id, expected] of expectedReserved) if (await side.reservedOf(id) !== expected) throw new Error(`Invalid reserved accounting market ${id}`);
  const snapshot = async () => {
    const banks = [];
    for (let id=1; id<=Number(await registry.marketCount()); id++) {
      const market = await registry.getMarket(id);
      const bank: any = await ethers.getContractAt('BankVault4626', market.bank);
      banks.push([market.bank, await bank.totalAssets(), await bank.totalSupply(), await bank.lockedBetLiquidity(), await bank.marketId(), await bank.sideBetController()]);
    }
    return JSON.stringify({ banks, bets: await side.betCount(), configs: await side.configCount(), timeout: await side.settleTimeout(), engine: await side.ENGINE(), registry: await side.REGISTRY(), scheduler: await engine.UPKEEP_SCHEDULER(), round: await engine.currentGlobalRound(), pending: await engine.hasPendingVrf(), reserved: await Promise.all([1,2,3].map(id=>side.reservedOf(id))) }, (_,v)=>typeof v==='bigint'?v.toString():v);
  };
  const before = await snapshot();
  journal.before = JSON.parse(before);
  const send = async (label: string, txPromise: Promise<any>) => {
    const tx = await txPromise;
    journal.transactions.push({ label, hash: tx.hash }); save();
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`Failed: ${label}`);
    Object.assign(journal.transactions[journal.transactions.length-1], { blockNumber: receipt.blockNumber, status: receipt.status }); save();
    console.log(label, tx.hash);
  };
  const previous = JSON.parse(readFileSync('deployments/rollout-2026-10-09-live.json','utf8'));
  async function matches(name: string, address: string, links: Record<string,string>) {
    const art = await artifacts.readArtifact(name);
    let expected = art.deployedBytecode.slice(2);
    for (const [source,names] of Object.entries(art.deployedLinkReferences)) for (const [lib,positions] of Object.entries(names)) {
      const addr = links[`${source}:${lib}`].slice(2).toLowerCase();
      for (const p of positions) expected=expected.slice(0,p.start*2)+addr+expected.slice((p.start+p.length)*2);
    }
    let actual=(await ethers.provider.getCode(address)).slice(2).toLowerCase();
    if (expected.startsWith('73'+'0'.repeat(40))) actual=actual.slice(0,2)+'0'.repeat(40)+actual.slice(42);
    return expected.toLowerCase()===actual;
  }
  const libraries = new Map<string,string>();
  async function deploy(name: string, args: any[] = []): Promise<any> {
    if (journal.deployments[name]) {
      const saved = journal.deployments[name];
      if (await ethers.provider.getCode(saved.address) === '0x') throw new Error(`Unconfirmed existing deployment ${name}`);
      console.log('Reuse confirmed deployment', name, saved.address);
      return ethers.getContractAt(name, saved.address, signer);
    }
    const artifact = await artifacts.readArtifact(name);
    const links: Record<string,string> = {};
    for (const [source, names] of Object.entries(artifact.linkReferences)) for (const library of Object.keys(names)) {
      const fq = `${source}:${library}`;
      if (!libraries.has(fq)) libraries.set(fq, await (await deploy(fq)).getAddress());
      links[fq] = libraries.get(fq)!;
    }
    const old = previous.deployments[name];
    if (name.includes(':') && old && await matches(name,old.address,links)) {
      journal.reusedLibraries ??= {};
      journal.reusedLibraries[name]=old.address; save();
      return ethers.getContractAt(name,old.address,signer);
    }
    const factory = await ethers.getContractFactory(name, { signer, libraries: links });
    if ((artifact.deployedBytecode.length-2)/2 > 24576) throw new Error(`Oversized ${name}`);
    const contract = await factory.deploy(...args);
    const address = await contract.getAddress();
    journal.deployments[name] = { address, args: args.map(x=>typeof x==='bigint'?x.toString():x), libraries: links }; save();
    await send(`deploy ${name}`, Promise.resolve(contract.deploymentTransaction()));
    await contract.waitForDeployment();
    return contract;
  }
  // Check drift since the pinned source inspection before the first write.
  for (const [proxy,name] of [[a.roulette,'RouletteEngine'], [a.sideBet,'SideBet']]) {
    const implementation = '0x'+(await ethers.provider.getStorage(proxy,IMPLEMENTATION_SLOT)).slice(-40);
    const row = audit.rows.find((r:any)=>r.name===name);
    const own = journal.deployments[name]?.address;
    if (implementation.toLowerCase()!==own?.toLowerCase() && (implementation.toLowerCase()!==row.address.toLowerCase() || ethers.keccak256(await ethers.provider.getCode(implementation))!==row.codeHash)) throw new Error(`Implementation drift ${name}`);
  }
  const initialFunder:any=await ethers.getContractAt('BRBJackpotFunder',a.jackpotFunder,signer);
  if (!await initialFunder.hasRole(await initialFunder.FUNDER_ADMIN_ROLE(),signer.address)) throw new Error('Missing old funder admin');
  if (await new ethers.Contract(a.brb,['function balanceOf(address) view returns(uint256)'],signer).balanceOf(a.jackpotFunder)!==0n) throw new Error('Old BRB balance requires obligation reconciliation before writes');
  if ((await engine.JACKPOT_FUNDER()).toLowerCase()!==a.jackpotFunder.toLowerCase() && (await engine.JACKPOT_FUNDER()).toLowerCase()!==journal.newFunder?.toLowerCase() && (await engine.JACKPOT_FUNDER()).toLowerCase()!==journal.deployments.BRBJackpotFunder?.address.toLowerCase()) throw new Error('Funder wiring drift');
  const keys = await Promise.all(['VRF_KEY_HASH_2_GWEI','VRF_KEY_HASH_30_GWEI','VRF_KEY_HASH_150_GWEI','VRF_CONFIRMATIONS','BRB_REFERRAL'].map(fn=>engine[fn]()));
  const newEngine = await deploy('RouletteEngine', [catalog.vrf.coordinator, ...keys]);
  if (!journal.transactions.some((tx:any)=>tx.label==='upgrade engine' && tx.status===1)) await send('upgrade engine', engine.upgradeToAndCall(await newEngine.getAddress(), '0x'));
  if (!live && before !== await snapshot()) throw new Error('Protocol state changed during fork engine upgrade');
  journal.checks.push('Engine upgrade preserves captured storage on pinned fork; SideBet and banks untouched'); save();
  await engine.roundDiagnostics(await engine.currentGlobalRound());
  const oldFunder: any = await ethers.getContractAt('BRBJackpotFunder', a.jackpotFunder, signer);
  if (!await oldFunder.hasRole(await oldFunder.FUNDER_ADMIN_ROLE(), signer.address)) throw new Error('Missing funder admin');
  const treasury = await engine.JACKPOT_TREASURY();
  const funder = await deploy('BRBJackpotFunder', [a.roulette, a.brb, await oldFunder.router(), treasury, a.sideBet, signer.address]);
  const policies: [string,string, string?][] = [['swapAssetTotalBps','setSwapAssetBps'],['slippageBps','setSlippageBps'],['coldSlippageBps','setColdSlippageBps'],['twapWindowSeconds','setTwapWindowSeconds']];
  for (const [getter,setter] of policies) {
    const value = await oldFunder[getter]();
    if (await funder[getter]() !== value) await send(`preserve ${getter}`, funder[setter](value));
  }
  const num = await oldFunder.treasuryBrbNumerator(), den = await oldFunder.treasuryBrbDenominator();
  if (await funder.treasuryBrbNumerator() !== num || await funder.treasuryBrbDenominator() !== den) await send('preserve treasury split', funder.setTreasuryBrbSplit(num, den));
  if (!journal.transactions.some((tx:any)=>tx.label==='wire new jackpot funder' && tx.status===1)) await send('wire new jackpot funder', engine.setJackpotFunder(await funder.getAddress()));
  if ((await engine.JACKPOT_FUNDER()).toLowerCase() !== (await funder.getAddress()).toLowerCase()) throw new Error('Funder wiring mismatch');
  const assets = new Set<string>([a.brb.toLowerCase()]);
  for (let id=1; id<=Number(await registry.marketCount()); id++) assets.add((await registry.getMarket(id)).asset.toLowerCase());
  journal.migratedBalances ??= {};
  for (const asset of assets) {
    const token:any=new ethers.Contract(asset,['function balanceOf(address) view returns(uint256)'],signer);
    const balance=await token.balanceOf(await oldFunder.getAddress());
    if (asset===a.brb.toLowerCase() && balance>0n) throw new Error('Old BRB balance requires explicit obligation reconciliation');
    if (balance>0n) {
      const prior=await token.balanceOf(await funder.getAddress());
      await send(`migrate retained ${asset}`,oldFunder.sweepToken(asset,await funder.getAddress(),balance));
      if (await token.balanceOf(await funder.getAddress())<prior+balance) throw new Error('Migration balance mismatch');
    }
    journal.migratedBalances[asset]=balance.toString(); save();
    if (await token.balanceOf(await oldFunder.getAddress())!==0n) throw new Error('Old funder still holds assets');
  }
  journal.previousFunder = await oldFunder.getAddress();
  journal.after=JSON.parse(await snapshot());
  journal.newFunder=await funder.getAddress();
  if ((await funder.pendingTreasuryBrb())+(await funder.pendingBurnBrb()) > await new ethers.Contract(a.brb,['function balanceOf(address) view returns(uint256)'],signer).balanceOf(await funder.getAddress())) throw new Error('Unbacked BRB obligations');
  journal.complete = true; save();
  delete journal.error; save();
  console.log('Rollout checks passed', journalPath);
}
main().catch(e=>{ if (started) { journal.error = e.message; save(); } console.error(e); process.exitCode = 1; });
