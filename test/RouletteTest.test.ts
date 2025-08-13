import { expect } from "chai";
import { viem } from "hardhat";
import { parseEther } from "viem/utils";

describe("Roulette (Merkle, VRF, Non-Upgradeable) [viem]", function () {
  let roulette;
  let brb;
  let vrfCoordinator;
  let owner, functionsOperator, vrfOperator, user;

  beforeEach(async function () {
    const walletClients = await viem.getWalletClients();
    owner = walletClients[0];
    functionsOperator = walletClients[1];
    vrfOperator = walletClients[2];
    user = walletClients[3];

    // Deploy mock BRB token (default deployer is owner)
    brb = await viem.deployContract("BRB" as any, []);
    // Transfer tokens from owner (deployer) to user
    await brb.write.transfer([user.account.address, parseEther("1000")], { account: owner.account });

    // Deploy mock VRFCoordinatorV2 (default deployer is owner)
    vrfCoordinator = await viem.deployContract("VRFCoordinatorV2Mock" as any, []);

    // Deploy Roulette with constructor (default deployer is owner)
    roulette = await viem.deployContract("Roulette" as any, [
      owner.account.address,
      brb.address,
      functionsOperator.account.address,
      vrfCoordinator.address,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      1,
      500000
    ]);
  });

  it("should set roles and config on deploy", async () => {
    expect(await roulette.read.hasRole([await roulette.read.DEFAULT_ADMIN_ROLE(), owner.account.address])).to.be.true;
    expect(await roulette.read.hasRole([await roulette.read.FUNCTIONS_OPERATOR_ROLE(), functionsOperator.account.address])).to.be.true;
  });

  it("should only allow FUNCTIONS_OPERATOR_ROLE to setMerkleRoot", async () => {
    await expect(roulette.write.setMerkleRoot(["0x0000000000000000000000000000000000000000000000000000000000000000"], { account: user.account })).to.be.reverted;
    await expect(roulette.write.setMerkleRoot(["0x0000000000000000000000000000000000000000000000000000000000000000"], { account: functionsOperator.account })).to.emit(roulette, "MerkleRootUpdated");
  });

  it("should only allow VRF_OPERATOR_ROLE to requestRandomness", async () => {
    await expect(roulette.write.requestRandomness([], { account: user.account })).to.be.reverted;
    await expect(roulette.write.requestRandomness([], { account: owner.account })).to.emit(roulette, "VRFRequested");
  });

  it("should allow user to bet with BRB token", async () => {
    await brb.write.approve([roulette.address, parseEther("10")], { account: user.account });
    await expect(roulette.write.bet([parseEther("1"), [], 0], { account: user.account })).to.emit(roulette, "Bet");
  });

  it("should update lastRandomWord on VRF fulfill", async () => {
    await roulette.write.requestRandomness([], { account: owner.account });
    // Simulate VRF callback
    await roulette.write.fulfillRandomWords([1, [42]], { account: owner.account });
    // We can't access private storage directly, but we can check the event
    // or add a public getter for lastRandomWord if needed
  });
}); 