import { network, viem } from 'hardhat';
import { vars } from 'hardhat/config';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, parseEther, zeroAddress, parseEventLogs } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { encodeMultiBet, straightLegs } from '../test/helpers/multiBetEncode';
import { inBatches, submissionEvidence } from './utils/liveSwarmEvidence';
import { createRpcFallback, resolveSepoliaRpcUrls } from './utils/rpcFallback';

const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const count = Number(process.env.LIVE_SWARM_TICKETS || 250);
const walletCount = Number(process.env.LIVE_SWARM_WALLETS || 25);
if (
  !Number.isSafeInteger(count) ||
  !Number.isSafeInteger(walletCount) ||
  count <= 200 ||
  count > 2000 ||
  walletCount < 25 ||
  walletCount > 200 ||
  count % walletCount !== 0
)
  throw Error('Use 201–2000 tickets, 25–200 wallets, and an equal integer ticket count per wallet');
const perWallet = count / walletCount;
if (perWallet > 10) throw Error('Use at most 10 tickets per wallet for a 60-second campaign');
const path =
  process.env.LIVE_SWARM_JOURNAL ||
  (count === 250 && walletCount === 25
    ? 'reports/swarm/live-sepolia-2026-10-10.json'
    : `reports/swarm/live-sepolia-2026-10-10-${count}x${walletCount}.json`);
const mode = process.env.LIVE_SWARM_MODE || 'preflight';
async function main() {
  if (network.name !== 'arbitrumsepolia') throw Error('Live swarm requires arbitrumsepolia');
  const rpcUrls = resolveSepoliaRpcUrls(process.env, (name) => (vars.has(name) ? vars.get(name) : undefined));
  const transport = createRpcFallback(rpcUrls, arbitrumSepolia.id);
  const pc = createPublicClient({ chain: arbitrumSepolia, transport, pollingInterval: 1500 });
  if ((await pc.getChainId()) !== 421614) throw Error('Wrong chain');
  if (!['preflight', 'prepare', 'run', 'reconcile', 'observe', 'cleanup', 'verify-cleanup'].includes(mode))
    throw Error('Unknown mode');
  if (['prepare', 'run', 'cleanup'].includes(mode) && process.env.CONFIRM_LIVE_SWARM !== `421614:${count}x37x1BRB`)
    throw Error('Explicit live testnet confirmation required');
  const key = vars.get('BRB_KEY');
  const admin = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
  const wallet = createWalletClient({ account: admin, chain: arbitrumSepolia, transport });
  const contractClients = { client: { public: pc, wallet } };
  const deploy = JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json', 'utf8'));
  const engine = await viem.getContractAt('RouletteEngine', deploy.addresses.roulette, contractClients);
  const registry = await viem.getContractAt('MarketRegistry', await engine.read.REGISTRY(), contractClients);
  const market = await registry.read.getMarket([3]);
  const bank = await viem.getContractAt('BankVault4626', market.bank, contractClients);
  const brb = await viem.getContractAt('BRBToken', deploy.addresses.brb, contractClients);
  const scheduler = await viem.getContractAt('UpkeepScheduler', await engine.read.UPKEEP_SCHEDULER(), contractClients);
  const funder = await engine.read.JACKPOT_FUNDER();
  if (
    market.asset.toLowerCase() !== brb.address.toLowerCase() ||
    funder.toLowerCase() !== deploy.addresses.jackpotFunder.toLowerCase()
  )
    throw Error('Deployment wiring mismatch');
  const ticket = parseEther('37');
  const accounts = Array.from({ length: walletCount }, (_, i) =>
    privateKeyToAccount(
      `0x${createHmac('sha256', Buffer.from(key.replace(/^0x/, ''), 'hex'))
        .update(`biribi-live-swarm:421614:2026-10-10:${i}`)
        .digest('hex')}`,
    ),
  );
  const clients = accounts.map((account) => createWalletClient({ account, chain: arbitrumSepolia, transport }));
  const campaignAccount = privateKeyToAccount(
    `0x${createHmac('sha256', Buffer.from(key.replace(/^0x/, ''), 'hex'))
      .update('biribi-live-swarm-funding:421614:2026-10-10')
      .digest('hex')}`,
  );
  const campaignWallet = createWalletClient({ account: campaignAccount, chain: arbitrumSepolia, transport });
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
    report.bank.toLowerCase() !== bank.address.toLowerCase() ||
    report.admin !== admin.address ||
    report.chainId !== 421614 ||
    report.tickets !== count ||
    report.uniqueWallets !== walletCount ||
    report.wallets.length !== walletCount ||
    report.wallets.some((w: any, i: number) => w.address !== accounts[i].address)
  )
    throw Error('Journal identity mismatch');
  const save = () => {
    mkdirSync('reports/swarm', { recursive: true });
    writeFileSync(path, stringify(report) + '\n');
  };
  const wait = async (hash: `0x${string}`) => {
    const r = await pc.waitForTransactionReceipt({ hash, timeout: 120000, pollingInterval: 1500 });
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
  const confirmEntries = async (entries: any[]) => {
    await inBatches(entries, 10, async (entry) => {
      const receipt = await wait(entry.hash);
      entry.gas = receipt.gasUsed.toString();
      entry.block = receipt.blockNumber.toString();
      entry.receiptStatus = receipt.status;
      const events = parseEventLogs({
        abi: bank.abi,
        logs: receipt.logs.filter((log) => log.address.toLowerCase() === bank.address.toLowerCase()),
        eventName: 'BetPlaced',
      });
      const event = events.length === 1 ? events[0] : undefined;
      entry.actualRound = event?.args.roundId.toString();
      entry.confirmed = entry.actualRound === String(report.round);
      const countdown = parseEventLogs({ abi: engine.abi, logs: receipt.logs, eventName: 'RoundCountdownStarted' })[0];
      if (countdown) report.lockAt = countdown.args.lockAt.toString();
      entry.confirmedAt = new Date().toISOString();
      save();
      if (!entry.confirmed) throw Error('Bet receipt round mismatch');
    });
  };
  if (mode === 'reconcile') {
    if (!['running', 'submitted', 'partial-submitted'].includes(report.status))
      throw Error('Reconciliation requires a submitted or interrupted campaign');
    await confirmEntries(report.wallets.flatMap((w: any) => w.bets));
    Object.assign(report, submissionEvidence(report));
    report.status = report.fullSubmission ? 'submitted' : 'partial-submitted';
    report.reconciledAt = new Date().toISOString();
    save();
    console.log(stringify({ status: report.status, confirmedTickets: report.confirmedTickets, target: count }));
    return;
  }
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
    const campaignBrb = report.campaignFundingWallet ? await brb.read.balanceOf([campaignAccount.address]) : 0n;
    if (report.campaignFundingWallet && report.campaignFundingWallet !== campaignAccount.address)
      throw Error('Funding wallet identity mismatch');
    if (campaignBrb !== 0n) throw Error('Funding-wallet BRB recovery incomplete');
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
      campaignFundingBrb: campaignBrb,
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
    if (baseline.adminBrb < ticket * BigInt(count)) throw Error('Insufficient BRB for configured ticket count');
    if (baseline.adminEth < parseEther(String(walletCount * 0.004 + 0.05))) throw Error('Insufficient test ETH budget');
    if (
      (await pc.getTransactionCount({ address: admin.address, blockTag: 'pending' })) !==
      (await pc.getTransactionCount({ address: admin.address, blockTag: 'latest' }))
    )
      throw Error('Admin has pending transactions');
    report.status = 'preparing';
    save();
    // Reconcile earlier preparation hashes before using a separate funding signer.
    await inBatches(report.transactions, 10, async (tx: any) => {
      await wait(tx.hash);
    });
    const states = await Promise.all(
      accounts.map(async (a) => ({
        brb: await brb.read.balanceOf([a.address]),
        eth: await pc.getBalance({ address: a.address }),
      })),
    );
    const target = ticket * BigInt(perWallet);
    const neededBrb = states.reduce((sum, b) => sum + (b.brb < target ? target - b.brb : 0n), 0n);
    const neededEth = states.reduce(
      (sum, b) => sum + (b.eth < parseEther('0.004') ? parseEther('0.004') - b.eth : 0n),
      parseEther('0.01'),
    );
    report.campaignFundingWallet = campaignAccount.address;
    save();
    const fundingBrb = await brb.read.balanceOf([campaignAccount.address]);
    if (fundingBrb < neededBrb)
      await adminTx('seed isolated funding wallet BRB', () =>
        brb.write.transfer([campaignAccount.address, neededBrb - fundingBrb]),
      );
    const fundingEth = await pc.getBalance({ address: campaignAccount.address });
    if (fundingEth < neededEth)
      await adminTx('seed isolated funding wallet ETH', () =>
        wallet.sendTransaction({ to: campaignAccount.address, value: neededEth - fundingEth }),
      );
    if (
      (await pc.getTransactionCount({ address: campaignAccount.address, blockTag: 'pending' })) !==
      (await pc.getTransactionCount({ address: campaignAccount.address, blockTag: 'latest' }))
    )
      throw Error('Funding wallet has pending transactions; reconcile before resuming');
    let nonce = await pc.getTransactionCount({ address: campaignAccount.address });
    const gasPrice = (await pc.getGasPrice()) * 2n;
    for (let group = 0; group < walletCount; group += 20) {
      const hashes: `0x${string}`[] = [];
      for (let i = group; i < Math.min(group + 20, walletCount); i++) {
        const state = states[i],
          a = accounts[i].address;
        if (state.brb < target) {
          const hash = await campaignWallet.writeContract({
            address: brb.address,
            abi: brb.abi,
            functionName: 'transfer',
            args: [a, target - state.brb],
            gas: 120000n,
            gasPrice,
            nonce: nonce++,
            type: 'legacy',
          });
          report.transactions.push({ label: `fund BRB wallet ${i}`, hash });
          save();
          hashes.push(hash);
        }
        if (state.eth < parseEther('0.004')) {
          const hash = await campaignWallet.sendTransaction({
            to: a,
            value: parseEther('0.004') - state.eth,
            gas: 100000n,
            gasPrice,
            nonce: nonce++,
            type: 'legacy',
          });
          report.transactions.push({ label: `fund ETH wallet ${i}`, hash });
          save();
          hashes.push(hash);
        }
      }
      await Promise.all(hashes.map(wait));
      const approvals = await Promise.allSettled(
        accounts.slice(group, group + 20).map(async (a, offset) => {
          const i = group + offset;
          if ((await brb.read.allowance([a.address, bank.address])) < target) {
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
        }),
      );
      const failure = approvals.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      console.log(`Prepared ${Math.min(group + 20, walletCount)}/${walletCount} wallets`);
    }
    report.status = 'prepared';
    save();
    console.log(`Prepared ${walletCount} wallets for ${count} live tickets.`);
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
    for (let wave = 0; wave < perWallet; wave++) {
      if (Date.now() - started > 50_000) throw Error('Admission safety deadline reached; inspect partial journal');
      if ((await engine.read.currentGlobalRound()) !== round) throw Error('Round changed during admission');
      const entries: any[] = [];
      let sendFailure: unknown;
      try {
        await inBatches(accounts, 25, async (_, i) => {
          if (Date.now() - started > 50_000) throw Error('Admission safety deadline reached; inspect partial journal');
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
          entries.push(entry);
          save();
        });
      } catch (error) {
        sendFailure = error;
      }
      await confirmEntries(entries);
      if (sendFailure) throw sendFailure;
      console.log(
        `Confirmed ${(wave + 1) * walletCount}/${count} tickets in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
    report.admissionSeconds = (Date.now() - started) / 1000;
    report.status = 'submitted';
    report.admissionEndBlock = (await pc.getBlockNumber()).toString();
    save();
    console.log(`${count} tickets submitted; observing real VRF and existing automation.`);
    return;
  }
  if (mode === 'observe') {
    if (!['submitted', 'partial-submitted', 'settled', 'partial-settled'].includes(report.status))
      throw Error('Reconcile submitted receipts before observing settlement');
    Object.assign(report, submissionEvidence(report));
    const confirmed = report.confirmedTickets;
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
      if (paid < parseEther(String(confirmed * 36))) throw Error('Ordinary payout total below swarm liability');
      report.observation.externalTickets = report.observation.market.totals.betCount - BigInt(confirmed);
      if (report.observation.externalTickets < 0n) throw Error('Round has fewer tickets than confirmed receipts');
      if (report.observation.externalTickets === 0n && paid !== parseEther(String(confirmed * 36)))
        throw Error('Unexpected ordinary payout total');
      if (!diagnostics.jackpotDistributed && delta !== parseEther(String(-confirmed)))
        throw Error('Unexpected wallet accounting');
      report.observation.roundDuration = await engine.read.ROUND_DURATION();
      if (report.observation.roundDuration !== 60) throw Error('Round duration changed');
      const activeFunder = await viem.getContractAt('BRBJackpotFunder', funder, contractClients);
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
      const hashes = [
        ...new Set(
          relevant.map((e) => {
            if (!e.transactionHash) throw Error('Missing mined automation transaction hash');
            return e.transactionHash;
          }),
        ),
      ];
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
      report.status = report.fullSubmission ? 'settled' : 'partial-settled';
      report.observation.bankAssets = await bank.read.totalAssets();
      report.observation.bankShares = await bank.read.totalSupply();
    }
    save();
    console.log(stringify({ status: report.status, ...report.observation }));
    return;
  }
  if (mode === 'cleanup') {
    if (!['settled', 'partial-settled', 'cleaning', 'cleaned'].includes(report.status))
      throw Error('Cleanup requires settled evidence');
    report.status = 'cleaning';
    save();
    const recover = async (i: number) => {
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
    };
    for (let group = 0; group < walletCount; group += 20) {
      const outcomes = await Promise.allSettled(
        Array.from({ length: Math.min(20, walletCount - group) }, (_, i) => recover(group + i)),
      );
      const failure = outcomes.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
    if (report.campaignFundingWallet) {
      if (report.campaignFundingWallet !== campaignAccount.address) throw Error('Funding wallet identity mismatch');
      const balance = await brb.read.balanceOf([campaignAccount.address]);
      if (balance > 0n) {
        const hash = await campaignWallet.writeContract({
          address: brb.address,
          abi: brb.abi,
          functionName: 'transfer',
          args: [admin.address, balance],
        });
        report.transactions.push({ label: 'recover isolated funding BRB', hash });
        save();
        await wait(hash);
      }
      const eth = await pc.getBalance({ address: campaignAccount.address });
      if (eth > parseEther('0.0001')) {
        const hash = await campaignWallet.sendTransaction({
          to: admin.address,
          value: eth - parseEther('0.0001'),
          gas: 100000n,
        });
        report.transactions.push({ label: 'recover isolated funding ETH', hash });
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
