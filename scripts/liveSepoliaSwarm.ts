import { network, viem } from 'hardhat';
import { vars } from 'hardhat/config';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, parseEther, zeroAddress, parseEventLogs } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { encodeMultiBet, straightLegs } from '../test/helpers/multiBetEncode';

const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const path = process.env.LIVE_SWARM_JOURNAL || 'reports/swarm/live-sepolia-2026-10-10.json';
const mode = process.env.LIVE_SWARM_MODE || 'preflight';
async function main() {
  if (network.name !== 'arbitrumsepolia') throw Error('Live swarm requires arbitrumsepolia');
  const pc = await viem.getPublicClient();
  if ((await pc.getChainId()) !== 421614) throw Error('Wrong chain');
  if (!['preflight', 'prepare', 'run', 'observe', 'cleanup', 'verify-cleanup'].includes(mode))
    throw Error('Unknown mode');
  if (['prepare', 'run', 'cleanup'].includes(mode) && process.env.CONFIRM_LIVE_SWARM !== '421614:250x37x1BRB')
    throw Error('Explicit live testnet confirmation required');
  const key = vars.get('BRB_KEY');
  const admin = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
  const [wallet] = await viem.getWalletClients();
  if (wallet.account.address.toLowerCase() !== admin.address.toLowerCase()) throw Error('Signer mismatch');
  const deploy = JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json', 'utf8'));
  const engine = await viem.getContractAt('RouletteEngine', deploy.addresses.roulette);
  const registry = await viem.getContractAt('MarketRegistry', await engine.read.REGISTRY());
  const market = await registry.read.getMarket([3]);
  const bank = await viem.getContractAt('BankVault4626', market.bank);
  const brb = await viem.getContractAt('BRBToken', deploy.addresses.brb);
  const scheduler = await viem.getContractAt('UpkeepScheduler', await engine.read.UPKEEP_SCHEDULER());
  const funder = await engine.read.JACKPOT_FUNDER();
  if (
    market.asset.toLowerCase() !== brb.address.toLowerCase() ||
    funder.toLowerCase() !== deploy.addresses.jackpotFunder.toLowerCase()
  )
    throw Error('Deployment wiring mismatch');
  const count = 250,
    walletCount = 25,
    ticket = parseEther('37');
  const accounts = Array.from({ length: walletCount }, (_, i) =>
    privateKeyToAccount(
      `0x${createHmac('sha256', Buffer.from(key.replace(/^0x/, ''), 'hex'))
        .update(`biribi-live-swarm:421614:2026-10-10:${i}`)
        .digest('hex')}`,
    ),
  );
  const transport = http(process.env.ARBITRUM_SEPOLIA_RPC_URL || vars.get('ARBITRUM_SEPOLIA_RPC_URL'), {
    retryCount: 0,
    timeout: 20000,
  });
  const clients = accounts.map((account) => createWalletClient({ account, chain: arbitrumSepolia, transport }));
  const round = await engine.read.currentGlobalRound();
  const baseline = {
    chainId: 421614,
    engine: engine.address,
    bank: bank.address,
    funder,
    scheduler: scheduler.address,
    admin: admin.address,
    tickets: count,
    legs: count * 37,
    uniqueWallets: walletCount,
    round,
    phase: await engine.read.roundPhase([round]),
    duration: await engine.read.ROUND_DURATION(),
    adminEth: await pc.getBalance({ address: admin.address }),
    adminBrb: await brb.read.balanceOf([admin.address]),
    bankAssets: await bank.read.totalAssets(),
    bankShares: await bank.read.totalSupply(),
    gasPrice: await pc.getGasPrice(),
    startBlock: await pc.getBlockNumber(),
  };
  if (mode === 'preflight') {
    console.log(stringify(baseline));
    return;
  }
  let report: any = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : {
        ...baseline,
        status: 'created',
        wallets: accounts.map((a) => ({ address: a.address, bets: [] })),
        transactions: [],
      };
  if (
    report.engine.toLowerCase() !== engine.address.toLowerCase() ||
    report.admin !== admin.address ||
    report.chainId !== 421614 ||
    report.wallets.some((w: any, i: number) => w.address !== accounts[i].address)
  )
    throw Error('Journal identity mismatch');
  const save = () => {
    mkdirSync('reports/swarm', { recursive: true });
    writeFileSync(path, stringify(report) + '\n');
  };
  const wait = async (hash: `0x${string}`) => {
    const r = await pc.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (r.status !== 'success') throw Error(`Reverted transaction ${hash}`);
    return r;
  };
  const adminTx = async (label: string, send: () => Promise<`0x${string}`>) => {
    const hash = await send();
    report.transactions.push({ label, hash });
    save();
    await wait(hash);
    return hash;
  };
  if (mode === 'verify-cleanup') {
    if (report.status !== 'cleaned') throw Error('Cleanup has not finished');
    const balances = await Promise.all(
      accounts.map(async (a) => ({
        address: a.address,
        brb: await brb.read.balanceOf([a.address]),
        allowance: await brb.read.allowance([a.address, bank.address]),
        eth: await pc.getBalance({ address: a.address }),
      })),
    );
    if (balances.some((b) => b.brb !== 0n || b.allowance !== 0n)) throw Error('Test-wallet recovery incomplete');
    if ((await engine.read.ROUND_DURATION()) !== 60) throw Error('Round duration changed');
    const blocks = report.wallets.flatMap((w: any) => w.bets.map((b: any) => BigInt(b.block)));
    const first = blocks.reduce((a: bigint, b: bigint) => (a < b ? a : b)),
      last = blocks.reduce((a: bigint, b: bigint) => (a > b ? a : b));
    const [firstBlock, lastBlock] = await Promise.all([
      pc.getBlock({ blockNumber: first }),
      pc.getBlock({ blockNumber: last }),
    ]);
    report.cleanupVerification = {
      wallets: balances,
      roundDuration: 60,
      chainAdmissionSeconds: lastBlock.timestamp - firstBlock.timestamp,
      firstBetBlock: first,
      lastBetBlock: last,
      adminEth: await pc.getBalance({ address: admin.address }),
      adminBrb: await brb.read.balanceOf([admin.address]),
      verifiedAt: new Date().toISOString(),
    };
    if (report.cleanupVerification.chainAdmissionSeconds >= 60n)
      throw Error('Tickets exceeded 60-second admission window');
    save();
    console.log(
      stringify({
        status: 'cleaned',
        allWalletBrbRecovered: true,
        allAllowancesZero: true,
        chainAdmissionSeconds: report.cleanupVerification.chainAdmissionSeconds,
        roundDuration: 60,
      }),
    );
    return;
  }
  if (mode === 'prepare') {
    if (report.status !== 'created' && report.status !== 'preparing') throw Error('Preparation already finished');
    if (baseline.adminBrb < ticket * BigInt(count)) throw Error('Insufficient BRB for 250 tickets');
    if (baseline.adminEth < parseEther('0.15')) throw Error('Insufficient test ETH budget');
    if (
      (await pc.getTransactionCount({ address: admin.address, blockTag: 'pending' })) !==
      (await pc.getTransactionCount({ address: admin.address, blockTag: 'latest' }))
    )
      throw Error('Admin has pending transactions');
    report.status = 'preparing';
    save();
    for (let i = 0; i < walletCount; i++) {
      const a = accounts[i].address,
        target = ticket * 10n;
      const balance = await brb.read.balanceOf([a]);
      if (balance < target) await adminTx(`fund BRB wallet ${i}`, () => brb.write.transfer([a, target - balance]));
      if ((await pc.getBalance({ address: a })) < parseEther('0.004'))
        await adminTx(`fund ETH wallet ${i}`, () => wallet.sendTransaction({ to: a, value: parseEther('0.004') }));
      if ((await brb.read.allowance([a, bank.address])) < target) {
        const hash = await clients[i].writeContract({
          address: brb.address,
          abi: brb.abi,
          functionName: 'approve',
          args: [bank.address, target],
        });
        report.transactions.push({ label: `approve wallet ${i}`, hash });
        save();
        await wait(hash);
      }
    }
    report.status = 'prepared';
    save();
    console.log('Prepared 25 wallets for 250 live tickets.');
    return;
  }
  if (mode === 'run') {
    if (report.status !== 'prepared') throw Error('Run requires prepared journal; never blindly retry a partial run');
    if (
      (await engine.read.roundPhase([round])) !== 1 ||
      (await engine.read.marketRoundStateByRound([round, 3])).totals.betCount !== 0n ||
      (await engine.read.hasPendingVrf())
    )
      throw Error('Need idle open round without BRB bets');
    for (let id = 1; id <= Number(await registry.read.marketCount()); id++)
      if ((await engine.read.marketRoundStateByRound([round, id])).totals.betCount !== 0n)
        throw Error('Wait for a completely idle round');
    if ((await engine.read.ROUND_DURATION()) !== 60)
      throw Error('The live test requires the unchanged 60-second window');
    const nonces = await Promise.all(
      accounts.map((a) => pc.getTransactionCount({ address: a.address, blockTag: 'pending' })),
    );
    report.round = round.toString();
    report.originalDuration = 60;
    report.startBlock = (await pc.getBlockNumber()).toString();
    report.walletBalancesBefore = await Promise.all(accounts.map((a) => brb.read.balanceOf([a.address])));
    report.bankAssetsBefore = await bank.read.totalAssets();
    report.status = 'running';
    save();
    const betData = encodeMultiBet(straightLegs(37, parseEther('1')));
    const gasPrice = baseline.gasPrice * 2n;
    const started = Date.now();
    report.admissionStartedAt = new Date(started).toISOString();
    save();
    // One in-flight transaction per EOA; cache fees/nonces and avoid per-wager
    // estimation RPCs. Each wave waits for all receipts before another wave.
    for (let wave = 0; wave < 10; wave++) {
      if (Date.now() - started > 50_000) throw Error('Admission safety deadline reached; inspect partial journal');
      if ((await engine.read.currentGlobalRound()) !== round) throw Error('Round changed during admission');
      const results = await Promise.allSettled(
        accounts.map(async (_, i) => {
          const hash = await clients[i].writeContract({
            address: bank.address,
            abi: bank.abi,
            functionName: 'placeBet',
            args: [ticket, betData, zeroAddress],
            gas: 6_000_000n,
            gasPrice,
            nonce: nonces[i] + wave,
            type: 'legacy',
          });
          const entry: any = { hash };
          report.wallets[i].bets.push(entry);
          save();
          const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 500 });
          entry.gas = receipt.gasUsed.toString();
          entry.block = receipt.blockNumber.toString();
          entry.receiptStatus = receipt.status;
          if (receipt.status !== 'success') {
            save();
            throw Error(`Wager reverted ${hash}`);
          }
          const event = parseEventLogs({ abi: bank.abi, logs: receipt.logs, eventName: 'BetPlaced' })[0];
          entry.actualRound = event?.args.roundId.toString();
          if (!event || event.args.roundId !== round) {
            save();
            throw Error('Bet receipt round mismatch');
          }
          const countdown = parseEventLogs({
            abi: engine.abi,
            logs: receipt.logs,
            eventName: 'RoundCountdownStarted',
          })[0];
          if (countdown) report.lockAt = countdown.args.lockAt.toString();
          entry.confirmed = true;
          entry.confirmedAt = new Date().toISOString();
          save();
        }),
      );
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      console.log(`Confirmed ${(wave + 1) * 25}/250 tickets in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    report.admissionSeconds = (Date.now() - started) / 1000;
    report.status = 'submitted';
    report.admissionEndBlock = (await pc.getBlockNumber()).toString();
    save();
    console.log('250 tickets submitted; observing real VRF and existing automation.');
    return;
  }
  if (mode === 'observe') {
    const rid = BigInt(report.round),
      diagnostics = await engine.read.roundDiagnostics([rid]);
    const phase = await engine.read.roundPhase([rid]);
    const current = await engine.read.currentGlobalRound();
    report.observation = {
      block: await pc.getBlockNumber(),
      currentRound: current,
      phase,
      diagnostics,
      market: await engine.read.marketRoundStateByRound([rid, 3]),
    };
    if (current > rid && phase === 4 && diagnostics.fulfilled) {
      const after = await Promise.all(accounts.map((a) => brb.read.balanceOf([a.address])));
      const delta = after.reduce((sum, b, i) => sum + b - BigInt(report.walletBalancesBefore[i]), 0n);
      report.observation.walletDelta = delta;
      const paid = report.observation.market.bankPaidRunning;
      if (paid < parseEther('9000')) throw Error('Ordinary payout total below swarm liability');
      report.observation.externalTickets = report.observation.market.totals.betCount - 250n;
      if (report.observation.externalTickets === 0n && paid !== parseEther('9000'))
        throw Error('Unexpected ordinary payout total');
      if (!diagnostics.jackpotDistributed && delta !== parseEther('-250')) throw Error('Unexpected wallet accounting');
      if (report.wallets.reduce((n: number, w: any) => n + w.bets.filter((b: any) => b.confirmed).length, 0) !== 250)
        throw Error('Incomplete ticket submission');
      report.observation.roundDuration = await engine.read.ROUND_DURATION();
      if (report.observation.roundDuration !== 60) throw Error('Round duration changed');
      const activeFunder = await viem.getContractAt('BRBJackpotFunder', funder);
      report.observation.fundingAccount = await activeFunder.read.fundingAccounts([3]);
      const names = [
        'VrfRequested',
        'VRFResult',
        'PayoutProgress',
        'RoundResolved',
        'JackpotFunded',
        'InfrastructureFeePaid',
      ] as const;
      const groups = await Promise.all(
        names.map((eventName) =>
          pc.getContractEvents({
            address: engine.address,
            abi: engine.abi,
            eventName,
            fromBlock: BigInt(report.startBlock),
            toBlock: report.observation.block,
          }),
        ),
      );
      const relevant = groups
        .flat()
        .filter((e: any) => BigInt(e.args.roundId ?? e.args.newRoundId ?? e.args.globalRoundId ?? 0) === rid);
      report.observation.events = relevant.map((e: any) => ({
        name: e.eventName,
        args: e.args,
        hash: e.transactionHash,
        block: e.blockNumber,
      }));
      const hashes = [...new Set(relevant.map((e) => e.transactionHash))];
      report.observation.automationTransactions = await Promise.all(
        hashes.map(async (hash) => {
          const [receipt, tx] = await Promise.all([pc.getTransactionReceipt({ hash }), pc.getTransaction({ hash })]);
          return {
            hash,
            from: tx.from,
            to: tx.to,
            gasLimit: tx.gas,
            gasUsed: receipt.gasUsed,
            status: receipt.status,
            block: receipt.blockNumber,
          };
        }),
      );
      report.observation.walletBalancesAfter = after;
      report.status = 'settled';
      report.observation.bankAssets = await bank.read.totalAssets();
      report.observation.bankShares = await bank.read.totalSupply();
    }
    save();
    console.log(stringify({ status: report.status, ...report.observation }));
    return;
  }
  if (mode === 'cleanup') {
    if (report.status !== 'settled' && report.status !== 'cleaning' && report.status !== 'cleaned')
      throw Error('Cleanup requires settled evidence');
    report.status = 'cleaning';
    save();
    for (let i = 0; i < walletCount; i++) {
      const balance = await brb.read.balanceOf([accounts[i].address]);
      if (balance > 0n) {
        const hash = await clients[i].writeContract({
          address: brb.address,
          abi: brb.abi,
          functionName: 'transfer',
          args: [admin.address, balance],
        });
        report.transactions.push({ label: `recover BRB wallet ${i}`, hash });
        save();
        await wait(hash);
      }
      if ((await brb.read.allowance([accounts[i].address, bank.address])) > 0n) {
        const hash = await clients[i].writeContract({
          address: brb.address,
          abi: brb.abi,
          functionName: 'approve',
          args: [bank.address, 0n],
        });
        report.transactions.push({ label: `revoke wallet ${i}`, hash });
        save();
        await wait(hash);
      }
      // Recover ETH with a conservative L2/L1 fee reserve; never expose derived keys.
      const eth = await pc.getBalance({ address: accounts[i].address });
      if (eth > parseEther('0.0001')) {
        const hash = await clients[i].sendTransaction({
          to: admin.address,
          value: eth - parseEther('0.0001'),
          gas: 100000n,
        });
        report.transactions.push({ label: `recover ETH wallet ${i}`, hash });
        save();
        await wait(hash);
      }
    }
    report.status = 'cleaned';
    save();
    console.log('Recovered wallet BRB and excess test ETH; evidence retained.');
  }
}
main().catch((e: any) => {
  console.error(
    String(e.shortMessage || e.message)
      .split('\n')[0]
      .replace(/https?:\/\/\S+/g, '[RPC redacted]'),
  );
  process.exitCode = 1;
});
