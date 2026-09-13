import { artifacts, network, viem } from "hardhat";
import { expect } from "chai";
import { createPublicClient, http, encodeFunctionData, encodeAbiParameters, decodeAbiParameters, getAddress, parseEther, zeroHash, type Hex } from "viem";
import { buildCatalogueForMarket, toConfigStruct } from "../scripts/utils/sideBetCatalogue";

// Opt-in simulation ONLY. All writes target Hardhat (31337), never the public RPC.
const run = process.env.SEPOLIA_FORK_URL ? describe : describe.skip;
const PROXY = "0xA0DCb8FCEd50EeD13899Af86DE70FcE42897E8B1" as const;
const ADMIN = "0xbbbbeDc42dC53842141Be8F70Df9EFe4d08538A4" as const;
const ENGINE = "0x7eb8110d9e84d3c32fa6468d13ea2bc81544acf1";
const REGISTRY = "0xbb93ae01f205ba4c9c9b32def71dc8f76c67f672";

run("Arbitrum Sepolia SideBet upgrade rehearsal (local fork)", function () {
  this.timeout(180_000);
  before(async () => {
    if (network.name !== "hardhat") throw new Error("Fork simulation requires the in-memory Hardhat network");
    const source = createPublicClient({ transport: http(process.env.SEPOLIA_FORK_URL) });
    const blockNumber = process.env.SEPOLIA_FORK_BLOCK
      ? Number(process.env.SEPOLIA_FORK_BLOCK)
      : Number(await source.getBlockNumber());
    console.log(`Read-only fork source block: ${blockNumber}`);
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: {
      jsonRpcUrl: process.env.SEPOLIA_FORK_URL,
      blockNumber,
    } }] });
  });
  after(async () => { await network.provider.request({ method: "hardhat_reset", params: [] }); });
  it("upgrades the actual empty proxy while preserving wiring and administrator roles", async () => {
    const client = await viem.getPublicClient();
    expect(await client.getChainId()).to.equal(31337);
    const artifact = await artifacts.readArtifact("SideBet");
    expect((artifact.deployedBytecode.length - 2) / 2, "EIP-170 runtime size").to.be.at.most(24576);
    const sideBet = await viem.getContractAt("SideBet", PROXY);
    expect(await sideBet.read.betCount()).to.equal(0n);
    expect(await sideBet.read.configCount()).to.equal(0n);
    expect(await sideBet.read.hasRole([zeroHash, ADMIN])).to.equal(true);
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [ADMIN] });
    await network.provider.request({ method: "hardhat_setBalance", params: [ADMIN, "0x56bc75e2d63100000"] });
    const implementation = await viem.deployContract("SideBet");
    await sideBet.write.upgradeToAndCall([implementation.address,
      encodeFunctionData({ abi: sideBet.abi, functionName: "initializeReservedAccounting" }),
    ], { account: ADMIN });
    await sideBet.write.setSettleTimeout([2592000n], { account: ADMIN });
    expect(await sideBet.read.settleTimeout()).to.equal(2592000n);
    expect(getAddress(await sideBet.read.ENGINE())).to.equal(getAddress(ENGINE));
    expect(getAddress(await sideBet.read.REGISTRY())).to.equal(getAddress(REGISTRY));
    expect(await sideBet.read.hasRole([zeroHash, ADMIN])).to.equal(true);
    expect(await sideBet.read.betCount()).to.equal(0n);
    expect(await sideBet.read.configCount()).to.equal(0n);
    for (const id of [1, 2, 3]) expect(await sideBet.read.reservedOf([id])).to.equal(0n);
  });
  it("seeds BRB and refunds an expired bet through the actual scheduler and bank", async () => {
    const sideBet = await viem.getContractAt("SideBet", PROXY);
    for (const [id, entry] of buildCatalogueForMarket(3).entries()) {
      await sideBet.write.addConfig([toConfigStruct(entry)], { account: ADMIN });
      await sideBet.write.setConfigStakeLimits([BigInt(id), parseEther("1"), parseEther("100")], { account: ADMIN });
    }
    expect(await sideBet.read.configCount()).to.equal(9n);
    const token = await viem.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", "0xcd97563e22017462f35ba1e266e13f8f756a53c9");
    const bank = "0x1759B09798f3DA7FE0D129E66c0a87722a954030" as const;
    const before = await token.read.balanceOf([ADMIN]);
    await token.write.approve([bank, parseEther("3")], { account: ADMIN });
    for (let i = 0; i < 3; i++) await sideBet.write.placeBet([0n, parseEther("1")], { account: ADMIN });
    expect(await token.read.balanceOf([ADMIN])).to.equal(before - parseEther("3"));
    await network.provider.request({ method: "evm_increaseTime", params: [2592001] });
    await network.provider.request({ method: "evm_mine", params: [] });
    const scheduler = await viem.getContractAt("UpkeepScheduler", "0xad1f181ad88aee13a6643104941ecea2b963c2d7");
    const executor = "0xfda0edcbcf2c6360279cf10ec079d56d43795a86" as const;
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [executor] });
    await network.provider.request({ method: "hardhat_setBalance", params: [executor, "0x56bc75e2d63100000"] });
    const engine = await viem.getContractAt("RouletteEngine", ENGINE);
    const lanes = await engine.read.payoutParallelLaneCount();
    for (let lane = 0; lane < lanes; lane++) {
      const [needed, data] = await scheduler.read.checkUpkeep([encodeAbiParameters([{type:"uint256"}], [BigInt(lane)])]);
      if (needed) {
        await scheduler.write.performUpkeep([data], { account: executor });
        const after = await token.read.balanceOf([ADMIN]);
        await scheduler.write.performUpkeep([data], { account: executor });
        expect(await token.read.balanceOf([ADMIN])).to.equal(after);
      }
    }
    for (const id of [0n, 1n, 2n]) expect((await sideBet.read.getBet([id])).status).to.equal(3);
    expect(await token.read.balanceOf([ADMIN])).to.equal(before);
    expect(await sideBet.read.reservedOf([3])).to.equal(0n);
  });

  it("settles a winner and loser after a locally simulated VRF callback, without double payment", async () => {
    const sideBet = await viem.getContractAt("SideBet", PROXY);
    const engine = await viem.getContractAt("RouletteEngine", ENGINE);
    const scheduler = await viem.getContractAt("UpkeepScheduler", "0xad1f181ad88aee13a6643104941ecea2b963c2d7");
    const token = await viem.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", "0xcd97563e22017462f35ba1e266e13f8f756a53c9");
    const bank = "0x1759B09798f3DA7FE0D129E66c0a87722a954030" as const;
    const executor = "0xfda0edcbcf2c6360279cf10ec079d56d43795a86" as const;
    const coordinator = "0x5CE8D5A2BC84beb22a398CCA51996F7930313D61" as const;
    const current = await engine.read.currentGlobalRound();
    const [fulfilled] = await engine.read.roundOutcome([current]);
    expect(fulfilled, "fork must begin before the pending VRF result").to.equal(false);
    for (const [index, targetNumber] of [7, 13].entries()) {
      const cfg = {...toConfigStruct(buildCatalogueForMarket(3)[0]), betType:1, targetNumber, targetCount:1,
        windowSpins:1, multiplierBps:100000, minStake:0n, maxStake:0n};
      await sideBet.write.addConfig([cfg], {account:ADMIN});
      await sideBet.write.setConfigStakeLimits([BigInt(9+index),parseEther("1"),parseEther("100")], {account:ADMIN});
    }
    // A fresh local player has no historical roulette payout or admin fee entitlement.
    const [, player] = await viem.getWalletClients();
    await token.write.transfer([player.account.address,parseEther("10")], {account:ADMIN});
    const balance = await token.read.balanceOf([player.account.address]);
    await token.write.approve([bank,parseEther("2")], {account:player.account});
    await sideBet.write.placeBet([9n,parseEther("1")], {account:player.account});
    await sideBet.write.placeBet([10n,parseEther("1")], {account:player.account});
    // This callback is simulated ONLY inside Hardhat 31337; it is not a real oracle delivery.
    expect(await (await viem.getPublicClient()).getChainId()).to.equal(31337);
    await network.provider.request({method:"hardhat_impersonateAccount",params:[coordinator]});
    await network.provider.request({method:"hardhat_setBalance",params:[coordinator,"0x56bc75e2d63100000"]});
    await engine.write.rawFulfillRandomWords([
      23155647161934045032884152475848511315856850881693647138995326022165221939723n,
      [7n, 8n],
    ], {account:coordinator});
    expect(await engine.read.roundOutcome([current])).to.deep.equal([true, 7]);
    const lanes = await engine.read.payoutParallelLaneCount();
    const sideBetReports: Hex[] = [];
    for (let pass = 0; pass < 12; pass++) {
      for (let lane = 0; lane < lanes; lane++) {
        const [needed, data] = await scheduler.read.checkUpkeep([encodeAbiParameters([{type:"uint256"}], [BigInt(lane)])]);
        if (needed) {
          if (decodeAbiParameters([{type:"uint8"}],data)[0] === 1) sideBetReports.push(data);
          await scheduler.write.performUpkeep([data], {account:executor});
        }
      }
      if ((await sideBet.read.getBet([3n])).status !== 0 && (await sideBet.read.getBet([4n])).status !== 0) break;
    }
    expect((await sideBet.read.getBet([3n])).status).to.equal(1);
    expect((await sideBet.read.getBet([4n])).status).to.equal(2);
    // The two side bets cost 2 BRB and the winner returns 10 BRB (stake included).
    expect(await token.read.balanceOf([player.account.address])).to.equal(balance + parseEther("8"));
    expect(await sideBet.read.reservedOf([3])).to.equal(0n);
    for (const data of sideBetReports) await scheduler.write.performUpkeep([data], {account:executor});
    expect(await token.read.balanceOf([player.account.address])).to.equal(balance + parseEther("8"));
  });
});
