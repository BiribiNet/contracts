import { expect } from "chai";
import { viem } from "hardhat";
import { parseEther } from "viem/utils";
import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

describe("Roulette (Merkle, VRF, Non-Upgradeable) [viem]", function () {
  // Use the shared fixture from deployWithCreate script

  beforeEach(async function () {
    const { rouletteProxy, brb, vrfCoordinator } = await useDeployWithCreateFixture();
    const walletClients = await viem.getWalletClients();
    const owner = walletClients[0];
    const functionsOperator = walletClients[1];
    const vrfOperator = walletClients[2];
    const user = walletClients[3];

    // Transfer tokens from owner (deployer) to user
    await brb.write.transfer([user.account.address, parseEther("1000")], { account: owner.account });
  });

  it("should deploy RouletteClean successfully", async () => {
    const { rouletteProxy } = await useDeployWithCreateFixture();
    // Test that the contract deployed successfully
    expect(rouletteProxy.address).to.be.a("string");
    expect(rouletteProxy.address).to.not.equal("0x0000000000000000000000000000000000000000");
  });

  // TODO: The following tests need to be updated for RouletteClean's upgradeable architecture
  // RouletteClean uses an initializer pattern and has different functions than the original Roulette contract

  /*
  it("should set roles and config on deploy", async () => {
    expect(await roulette.read.hasRole([await roulette.read.DEFAULT_ADMIN_ROLE(), owner.account.address])).to.be.true;
    expect(await roulette.read.hasRole([await roulette.read.FUNCTIONS_OPERATOR_ROLE(), functionsOperator.account.address])).to.be.true;
  });

  it("should only allow FUNCTIONS_OPERATOR_ROLE to setMerkleRoot", async () => {
    await expect(roulette.write.setMerkleRoot(["0x0000000000000000000000000000000000000000000000000000000000000000"], { account: user.account })).to.be.rejected;
    await expect(roulette.write.setMerkleRoot(["0x0000000000000000000000000000000000000000000000000000000000000000"], { account: functionsOperator.account })).to.emit(roulette, "MerkleRootUpdated");
  });

  it("should only allow VRF_OPERATOR_ROLE to requestRandomness", async () => {
    await expect(roulette.write.requestRandomness([], { account: user.account })).to.be.rejected;
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
  */
}); 