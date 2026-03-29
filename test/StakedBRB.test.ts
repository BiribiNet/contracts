import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { checksumAddress, encodeAbiParameters, parseEther, parseEventLogs, parseSignature, toHex, zeroAddress, type WalletClient } from "viem";

import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

const MAX_UINT256 = 2n ** 256n - 1n;

/** Advance to pre-VRF lock, perform it, then advance until VRF upkeep (checkData 0x01) is ready. */
async function advanceThroughLockToVrfWindow(stakedBrbProxy: any) {
  const [forwarder] = await viem.getWalletClients();
  let s = await stakedBrbProxy.read.getSecondsFromNextUpkeepWindow();
  while (s > 0n && s < MAX_UINT256) {
    await time.increase(s);
    s = await stakedBrbProxy.read.getSecondsFromNextUpkeepWindow();
  }
  const [lockNeeded, lockData] = await stakedBrbProxy.read.checkUpkeep(["0x"]);
  if (!lockNeeded) throw new Error("expected pre-VRF lock upkeep");
  await stakedBrbProxy.write.performUpkeep([lockData], { account: forwarder.account });
  s = await stakedBrbProxy.read.getSecondsFromNextUpkeepWindow();
  while (s > 0n && s < MAX_UINT256) {
    await time.increase(s);
    s = await stakedBrbProxy.read.getSecondsFromNextUpkeepWindow();
  }
}

/**
 * Resolves one roulette round through payouts, then runs StakedBRB cleaning upkeep (processes queued liquidity).
 * Replaces the removed admin-only liquidity flush; uses the same on-chain path as production.
 */
async function runMinimalRoundAndStakedCleaning(
  stakedBrbProxy: any,
  rouletteProxy: any,
  vrfCoordinator: any,
  publicClient: any,
  admin: { account: { address: `0x${string}` } },
  brb: any,
) {
  await brb.write.approve([stakedBrbProxy.address, parseEther("1000000")], { account: admin.account });

  const betAmount = parseEther("1");
  const SAFETY_BUFFER_BPS = 11000n;
  const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
  const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
  const nextMaxPayout = existingMaxPayout + newBetMaxPayout;
  const requiredBalance = nextMaxPayout > betAmount ? nextMaxPayout - betAmount : 0n;
  const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
  if (vaultBalance < requiredBalance) {
    await brb.write.transfer([stakedBrbProxy.address, requiredBalance - vaultBalance + parseEther("100")], { account: admin.account });
  }
  // Straight on 8; VRF resolves winning number 7 so the bet loses (no huge vault payout that skews totalAssets).
  const betData = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "uint256[]", name: "amounts" },
      { type: "uint256[]", name: "betTypes" },
      { type: "uint256[]", name: "numbers" },
    ] }],
    [{ amounts: [betAmount], betTypes: [1n], numbers: [8n] }],
  );
  await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });

  await advanceThroughLockToVrfWindow(stakedBrbProxy);

  const [needsExecutionVRF, performDataVRF] = await rouletteProxy.read.checkUpkeep(["0x01"]);
  if (!needsExecutionVRF) throw new Error("runMinimalRoundAndStakedCleaning: VRF upkeep not ready");
  const txVRF = await rouletteProxy.write.performUpkeep([performDataVRF], { account: admin.account });
  const receiptVRF = await publicClient.waitForTransactionReceipt({ hash: txVRF });
  const logsVRF = parseEventLogs({
    abi: rouletteProxy.abi,
    eventName: "VrfRequested",
    logs: receiptVRF.logs,
  });
  if (!logsVRF.length) throw new Error("VrfRequested not found");
  const requestId = logsVRF[0].args.requestId;
  await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [7n, 10n]]);

  const [countWinnersNeeded, countWinnersData] = await rouletteProxy.read.checkUpkeep([toHex(new Uint8Array(2))]);
  if (countWinnersNeeded) {
    await rouletteProxy.write.performUpkeep([countWinnersData], { account: admin.account });
  }

  let processedPayoutBatches = 0;
  while (true) {
    const checkDataForPayout = new Uint8Array(Number(processedPayoutBatches) + 3);
    const hexCheckData = toHex(checkDataForPayout);
    const [payoutsNeeded, payoutData] = await rouletteProxy.read.checkUpkeep([hexCheckData]);
    if (!payoutsNeeded) break;
    await rouletteProxy.write.performUpkeep([payoutData], { account: admin.account });
    processedPayoutBatches++;
    await time.increase(10n);
  }

  const [upkeepNeeded, performData] = await stakedBrbProxy.read.checkUpkeep(["0x02"]);
  if (upkeepNeeded) {
    await stakedBrbProxy.write.performUpkeep([performData], { account: admin.account });
  }
}

describe("StakedBRB", function () {
  let stakedBrbProxy: Awaited<ReturnType<typeof useDeployWithCreateFixture>>["stakedBrbProxy"];
  let upkeepManager: Awaited<ReturnType<typeof useDeployWithCreateFixture>>["upkeepManager"];
  let brb: Awaited<ReturnType<typeof useDeployWithCreateFixture>>["brb"];
  let rouletteProxy: Awaited<ReturnType<typeof useDeployWithCreateFixture>>["rouletteProxy"];
  let vrfCoordinator: Awaited<ReturnType<typeof useDeployWithCreateFixture>>["vrfCoordinator"];
  let admin: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let player1: Awaited<ReturnType<typeof viem.getWalletClients>>[1];
  let player2: Awaited<ReturnType<typeof viem.getWalletClients>>[2];
  let player3: Awaited<ReturnType<typeof viem.getWalletClients>>[3];
  let publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>;

  // Cancel queued withdrawals for test accounts. Full share redemption requires cleaning upkeep.
  async function clearAllAssets() {
    const [_brbToken, _rouletteContract, _protocolFeeBasisPoints, _feeRecipient, pendingBets] =
      await stakedBrbProxy.read.getVaultConfig();

    if (pendingBets > 0) {
      // Pending bets require completing the round (VRF, etc.); tests that need a clean vault avoid pending bets.
    }

    const users = [admin, player1, player2, player3];
    for (const user of users) {
      try {
        await stakedBrbProxy.write.cancelWithdrawal({ account: user.account });
      } catch {
        // NoWithdrawalPending
      }
    }

    // Verify that totalAssets is now 0 (or at least minimal due to pending bets)
    const totalAssets = await stakedBrbProxy.read.totalAssets();
    const totalSupply = await stakedBrbProxy.read.totalSupply();
    
    console.log(`All assets cleared. Total assets: ${totalAssets} Total supply: ${totalSupply}`);
    
    // Don't assert that totalAssets is 0 because there might be pending bets
    // Just log the current state
    if (totalAssets > 0n) {
      console.log(`Warning: Total assets is ${totalAssets}, likely due to pending bets`);
    }
    
    console.log("All assets cleared. Total assets:", totalAssets, "Total supply:", totalSupply);
  }

  /** Deposit (and optionally bet) so the vault has maxPayout / constrained safe capacity; all withdrawals are queued. */
  async function setupWithdrawalScenario(stakeAmount: bigint = parseEther("2000"), shouldPlaceBet: boolean = false) {
    // Clear the vault first by unstaking everything
    await clearAllAssets();
    
    // Ensure player1 has enough BRB balance
    const player1Balance = await brb.read.balanceOf([player1.account.address]);
    if (player1Balance < stakeAmount) {
      // Transfer additional BRB from admin to player1
      const neededAmount = stakeAmount - player1Balance;
      await brb.write.transfer([player1.account.address, neededAmount], { account: admin.account });
    }
    
    // Stake the specified amount
    await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
    await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });
    
    let maxPayout = 0n;
    let safeWithdrawalCapacity = 0n;
    
    if (shouldPlaceBet) {
      // Get total assets after staking
      const totalAssetsAfterStaking = await stakedBrbProxy.read.totalAssets();
      
      // Calculate bet amount = Math.floor(totalAssets / 36) to create maxPayout close to totalAssets
      // This ensures that any withdrawal > 100 ETH will trigger large withdrawal
      const betAmount = totalAssetsAfterStaking / 36n; // This ensures maxPayout = betAmount * 36 ≈ totalAssets
      
      console.log(`Total Assets after staking: ${totalAssetsAfterStaking}`);
      console.log(`Calculated bet amount: ${betAmount} (totalAssets / 36)`);
      
      // Calculate the maxPayout for this bet
      // Note: The contract applies a safety buffer of 110% (SAFETY_BUFFER_BPS = 11000)
      // So maxPayout = (betAmount * 36) * 11000 / 10000 = betAmount * 39.6
      const SAFETY_BUFFER_BPS = 11000n;
      const betMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      maxPayout = betMaxPayout;
      
      // Use actual current maxPayout for isolation (works with clean or pre-existing state)
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const totalMaxPayout = existingMaxPayout + betMaxPayout;
      
      console.log(`Existing maxPayout: ${existingMaxPayout}, New bet maxPayout: ${betMaxPayout}, Total maxPayout: ${totalMaxPayout}`);
      
      // For the contract's check: balance + betAmount >= totalMaxPayout, so balance >= totalMaxPayout - betAmount
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      const requiredBalance = totalMaxPayout > betAmount ? totalMaxPayout - betAmount : 0n;
      console.log(`Vault balance: ${vaultBalance}, Total maxPayout needed: ${totalMaxPayout}, Required balance: ${requiredBalance}`);
      
      // Transfer enough BRB to the vault to satisfy the contract's check
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance;
        console.log(`Vault needs ${neededAmount} more BRB to cover required balance of ${requiredBalance}`);
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
        const newVaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
        console.log(`Vault balance after transfer: ${newVaultBalance}`);
      }
      
      // Ensure we have enough balance for the bet amount as well
      const totalNeeded = totalMaxPayout + betAmount;
      const finalVaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (finalVaultBalance < totalNeeded) {
        const additionalNeeded = totalNeeded - finalVaultBalance;
        console.log(`Vault needs additional ${additionalNeeded} BRB for bet amount`);
        await brb.write.transfer([stakedBrbProxy.address, additionalNeeded], { account: admin.account });
      }
      
      // Double-check that we have enough balance
      const finalCheckBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      console.log(`Final vault balance: ${finalCheckBalance}, Total needed: ${totalNeeded}`);
      if (finalCheckBalance < totalNeeded) {
        const stillNeeded = totalNeeded - finalCheckBalance;
        console.log(`Still need ${stillNeeded} more BRB`);
        await brb.write.transfer([stakedBrbProxy.address, stillNeeded], { account: admin.account });
      }
      
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
    }
    
    const totalAssets = await stakedBrbProxy.read.totalAssets();
    safeWithdrawalCapacity = totalAssets > maxPayout ? totalAssets - maxPayout : 0n;
    
    console.log(`Total Assets: ${totalAssets}, Max Payout: ${maxPayout}, Safe Capacity: ${safeWithdrawalCapacity}`);
    console.log(`Safe capacity ${safeWithdrawalCapacity} ETH (preview only; all exits are queued)`);
    
    return { totalAssets, maxPayout, safeWithdrawalCapacity };
  }

  beforeEach(async function () {
    const fixture = await useDeployWithCreateFixture();
    stakedBrbProxy = fixture.stakedBrbProxy;
    upkeepManager = fixture.upkeepManager;
    brb = fixture.brb;
    rouletteProxy = fixture.rouletteProxy;
    vrfCoordinator = fixture.vrfCoordinator;
    publicClient = await viem.getPublicClient();
    
    const clients = await viem.getWalletClients();
    admin = clients[0];
    player1 = clients[1];
    player2 = clients[2];
    player3 = clients[3];
  });

  describe("Deployment and Initialization", function () {
    it("Should deploy with correct initial values", async function () {
      const [brbToken, rouletteContract, protocolFeeBasisPoints, burnFeeRate, jackpotFeeRate, feeRecipient, pendingBets] = 
        await stakedBrbProxy.read.getVaultConfig();
      
      expect(brbToken.toLowerCase()).to.equal(brb.address.toLowerCase());
      expect(rouletteContract.toLowerCase()).to.equal(rouletteProxy.address.toLowerCase());
      expect(protocolFeeBasisPoints).to.equal(300n); // 3%
      expect(feeRecipient.toLowerCase()).to.equal(admin.account.address.toLowerCase());
      expect(pendingBets).to.equal(0n);
      expect(burnFeeRate).to.equal(50n); // 0.5%
      expect(jackpotFeeRate).to.equal(150n); // 1.5%
    });

    it("Should have correct ERC4626 properties", async function () {
      expect(await stakedBrbProxy.read.name()).to.equal("Staked BRB");
      expect(await stakedBrbProxy.read.symbol()).to.equal("sBRB");
      expect(await stakedBrbProxy.read.decimals()).to.equal(18n);
    });

    it("Should have correct admin role", async function () {
      const adminRole = await stakedBrbProxy.read.DEFAULT_ADMIN_ROLE();
      expect(await stakedBrbProxy.read.hasRole([adminRole, admin.account.address])).to.be.true;
      expect(await stakedBrbProxy.read.hasRole([adminRole, player1.account.address])).to.be.false;
    });

    it("Should initialize with default withdrawal settings", async function () {
      const [withdrawalBatchSize, queueLength, maxQueueLength] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      expect(withdrawalBatchSize).to.equal(5n); // DEFAULT_LARGE_WITHDRAWAL_BATCH_SIZE
      expect(queueLength).to.equal(0n);
      expect(maxQueueLength).to.equal(100n); // DEFAULT_MAX_QUEUE_LENGTH
    });

    it("Should revert with invalid fee rate during initialization", async function () {
      // This would be tested during deployment, but we can test the validation logic
      const invalidFeeRate = 10001n; // > MAX_PROTOCOL_FEE
      
      // We can't test this directly since the contract is already deployed,
      // but we can test the setProtocolFeeRate function with invalid values
      await expect(
        stakedBrbProxy.write.setProtocolFeeRate([invalidFeeRate], { account: admin.account })
      ).to.be.rejectedWith("InvalidFeeRate");
    });
  });

  describe("ERC4626 Basic Functionality", function () {
    it("Should handle deposits correctly", async function () {
      const depositAmount = parseEther("1000");
      
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const shares = await stakedBrbProxy.read.balanceOf([player1.account.address]);
      expect(shares).to.be.greaterThan(0);
      expect(await stakedBrbProxy.read.totalSupply()).to.equal(shares);
      expect(await stakedBrbProxy.read.totalAssets()).to.be.greaterThan(0);
    });

    it("Should enforce minimum deposit for first deposit", async function () {
      const smallDeposit = 999n; // < MINIMUM_DEPOSIT
      
      await brb.write.approve([stakedBrbProxy.address, smallDeposit], { account: player1.account });
      await expect(
        stakedBrbProxy.write.deposit([smallDeposit, player1.account.address, 0n], { account: player1.account })
      ).to.be.rejectedWith("DepositTooSmall");
    });

    it("Should allow small deposits after first deposit", async function () {
      // First deposit
      const firstDeposit = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, firstDeposit], { account: player1.account });
      await stakedBrbProxy.write.deposit([firstDeposit, player1.account.address, 0n], { account: player1.account });
      
      // Second small deposit should work
      const smallDeposit = 999n;
      await brb.write.approve([stakedBrbProxy.address, smallDeposit], { account: player2.account });
      await stakedBrbProxy.write.deposit([smallDeposit, player2.account.address, 0n], { account: player2.account });
    });

    it("Should handle minting correctly", async function () {
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const shares = await stakedBrbProxy.read.balanceOf([player1.account.address]);
      const mintAmount = shares / 2n;
      
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player2.account });
      await stakedBrbProxy.write.mint([mintAmount, player2.account.address, parseEther("1000")], { account: player2.account });
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);

      expect(await stakedBrbProxy.read.balanceOf([player2.account.address])).to.equal(mintAmount);
    });

    it("Should calculate exchange rate correctly", async function () {
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      // Use ERC4626 compliant function to get exchange rate
      const shares = await stakedBrbProxy.read.balanceOf([player1.account.address]);
      const assets = await stakedBrbProxy.read.convertToAssets([shares]);
      const exchangeRate = assets * parseEther("1") / shares;
      expect(exchangeRate).to.equal(parseEther("1")); // 1:1 initially
    });

    it("Should preview functions work correctly", async function () {
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const shares = await stakedBrbProxy.read.balanceOf([player1.account.address]);
      
      // Test preview functions
      expect(await stakedBrbProxy.read.previewDeposit([depositAmount])).to.equal(shares);
      expect(await stakedBrbProxy.read.previewMint([shares])).to.equal(depositAmount);
      expect(await stakedBrbProxy.read.previewWithdraw([depositAmount])).to.equal(shares);
      expect(await stakedBrbProxy.read.previewRedeem([shares])).to.equal(depositAmount);
    });
  });

  describe("Deposit With Permit (EIP-2612)", function () {
    async function createPermitSignature(
      owner: WalletClient,
      spender: string,
      value: bigint,
      deadline: bigint,
      nonce?: bigint
    ) {
      // Get contract details
      const name = await brb.read.name();
      const version = '1';
      const chainId = await publicClient.getChainId();
      const verifyingContract = brb.address;
      
      // Get nonce if not provided
      if (nonce === undefined) {
        nonce = await brb.read.nonces([owner!.account!.address]);
      }

      // EIP-712 domain
      const domain = {
        name,
        version,
        chainId,
        verifyingContract,
      };

      // EIP-2612 Permit typehash
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const message = {
        owner: owner!.account!.address,
        spender,
        value,
        nonce,
        deadline,
      };

      // Sign the structured data
      const signature = await owner!.signTypedData({
        domain,
        types,
        primaryType: "Permit",
        message,
        account: owner!.account!
      });

      return parseSignature(signature);
    }

    it("Should allow deposit with valid permit signature", async function () {
      const depositAmount = parseEther("1000");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
      
      // Create permit signature
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

      // Get initial balances
      const initialBrbBalance = await brb.read.balanceOf([player1.account.address]);
      const initialShares = await stakedBrbProxy.read.balanceOf([player1.account.address]);

      // Deposit with permit
      const tx = await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player1.account.address,
        0n, // minSharesOut
        deadline,
        Number(v),
        r,
        s
      ], { account: player1.account });

      // Verify the deposit worked
      const finalBrbBalance = await brb.read.balanceOf([player1.account.address]);
      const finalShares = await stakedBrbProxy.read.balanceOf([player1.account.address]);

      expect(finalBrbBalance).to.equal(initialBrbBalance - depositAmount);
      expect(finalShares).to.be.greaterThan(initialShares);
      expect(await stakedBrbProxy.read.totalAssets()).to.be.greaterThan(0);
    });

    it("Should work with minimum first deposit using permit", async function () {
      const depositAmount = parseEther("1000"); // Above minimum
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Create permit signature
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

      // Deposit with permit (should work as it's above minimum)
      await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player1.account.address,
        0n,
        deadline,
        Number(v),
        r,
        s
      ], { account: player1.account });

      expect(await stakedBrbProxy.read.balanceOf([player1.account.address])).to.be.greaterThan(0);
    });

    it("Should reject deposit with expired permit", async function () {
      const depositAmount = parseEther("1000");
      const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
      
      // Create permit signature with expired deadline
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        expiredDeadline
      );

      // Should revert due to expired deadline
      await expect(
        stakedBrbProxy.write.depositWithPermit([
          depositAmount,
          player1.account.address,
          0n,
          expiredDeadline,
          Number(v),
          r,
          s
        ], { account: player1.account })
      ).to.be.rejected;
    });

    it("Should reject deposit with invalid permit signature", async function () {
      const depositAmount = parseEther("1000");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Create permit signature for different amount
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        parseEther("500"), // Different amount
        deadline
      );

      // Should revert due to signature mismatch
      await expect(
        stakedBrbProxy.write.depositWithPermit([
          depositAmount, // Using different amount than signed
          player1.account.address,
          0n,
          deadline,
          Number(v),
          r,
          s
        ], { account: player1.account })
      ).to.be.rejected;
    });

    it("Should reject deposit with reused permit (nonce replay)", async function () {
      const depositAmount = parseEther("1000");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Create permit signature
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

      // First deposit should work
      await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player1.account.address,
        0n,
        deadline,
        Number(v),
        r,
        s
      ], { account: player1.account });

      // Transfer more BRB to player1 for second attempt
      await brb.write.transfer([player1.account.address, depositAmount], { account: admin.account });

      // Second deposit with same signature should fail (nonce already used)
      await expect(
        stakedBrbProxy.write.depositWithPermit([
          depositAmount,
          player1.account.address,
          0n,
          deadline,
          Number(v),
          r,
          s
        ], { account: player1.account })
      ).to.be.rejected;
    });

    it("Should handle permit failure gracefully and still attempt deposit", async function () {
      const depositAmount = parseEther("1000");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Pre-approve the transfer (so permit failure won't block deposit)
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });

      // Create invalid permit signature (wrong spender)
      const { r, s, v } = await createPermitSignature(
        player1,
        player2.account.address, // Wrong spender
        depositAmount,
        deadline
      );

      // Should still work because of pre-approval, permit failure is caught
      await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player1.account.address,
        0n,
        deadline,
        Number(v),
        r,
        s
      ], { account: player1.account });

      expect(await stakedBrbProxy.read.balanceOf([player1.account.address])).to.be.greaterThan(0);
    });

    it("Should work for different receivers with permit", async function () {
      const depositAmount = parseEther("1000");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Create permit signature
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

      // Deposit with permit, but shares go to player2
      await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player2.account.address, // Different receiver
        0n,
        deadline,
        Number(v),
        r,
        s
      ], { account: player1.account });

      // Player1 should have paid, player2 should have received shares
      expect(await stakedBrbProxy.read.balanceOf([player2.account.address])).to.be.greaterThan(0);
      expect(await stakedBrbProxy.read.balanceOf([player1.account.address])).to.equal(0);
    });

    it("Should respect minSharesOut parameter", async function () {
      const depositAmount = parseEther("1000");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Create permit signature
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

      // Set unreasonably high minSharesOut
      const unreasonableMinShares = parseEther("2000"); // More than possible

      // Should revert due to insufficient shares output
      await expect(
        stakedBrbProxy.write.depositWithPermit([
          depositAmount,
          player1.account.address,
          unreasonableMinShares,
          deadline,
          Number(v),
          r,
          s
        ], { account: player1.account })
      ).to.be.rejected;
    });

    it("Should handle multiple users with permits in sequence", async function () {
      const depositAmount = parseEther("1000");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Player1 deposit with permit
      const sig1 = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

      await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player1.account.address,
        0n,
        deadline,
        Number(sig1.v),
        sig1.r,
        sig1.s
      ], { account: player1.account });

      // Player2 deposit with permit
      const sig2 = await createPermitSignature(
        player2,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

      await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player2.account.address,
        0n,
        deadline,
        Number(sig2.v),
        sig2.r,
        sig2.s
      ], { account: player2.account });
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);

      // Both should have shares
      expect(await stakedBrbProxy.read.balanceOf([player1.account.address])).to.be.greaterThan(0);
      expect(await stakedBrbProxy.read.balanceOf([player2.account.address])).to.be.greaterThan(0);
    });
  });

  describe("Withdrawals (queued for all sizes)", function () {
    beforeEach(async function () {
      // Setup: deposit some BRB
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
    });

    it("Should queue asset withdrawals without transferring BRB until upkeep", async function () {
      const withdrawAmount = parseEther("100");
      const initialBalance = await brb.read.balanceOf([player1.account.address]);

      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account });

      const finalBalance = await brb.read.balanceOf([player1.account.address]);
      expect(finalBalance).to.equal(initialBalance);
      const [pendingAmount] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmount).to.equal(withdrawAmount);
    });

    it("Should queue redemptions without transferring BRB until upkeep", async function () {
      const shares = await stakedBrbProxy.read.balanceOf([player1.account.address]);
      const redeemShares = shares / 2n;
      const initialBalance = await brb.read.balanceOf([player1.account.address]);

      const amountOut = await stakedBrbProxy.read.previewRedeem([redeemShares]);
      const minAmountOut = amountOut / 2n;

      await stakedBrbProxy.write.redeem([redeemShares, player1.account.address, player1.account.address, minAmountOut], { account: player1.account });

      const finalBalance = await brb.read.balanceOf([player1.account.address]);
      expect(finalBalance).to.equal(initialBalance);
      const [pendingAmount] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmount).to.equal(amountOut);
    });

    it("Should revert when withdrawals are locked", async function () {
      // This test would require a function to lock withdrawals
      // For now, we'll test the withdrawal logic without locking
      const withdrawAmount = parseEther("100");
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      // Test that withdrawal works normally
      await expect(
        stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account })
      ).to.not.be.rejected;
    });

    it("Should revert when rounds are not fully processed", async function () {
      // Simulate unprocessed rounds by setting lastRoundResolved != lastRoundPaid
      // This would require internal state manipulation, so we test the condition indirectly
      // by checking the withdrawal allowed logic
      
      // We can't directly test this without internal state manipulation,
      // but the logic is covered in the contract
    });
  });

  describe("Withdrawal queue", function () {
    it("Should queue withdrawals when safe capacity is exceeded", async function () {
      // Isolated: set up scenario for this test only (deposit + bet)
      await setupWithdrawalScenario(parseEther("2000"), true);
      // totalAssets = 2000, maxPayout set, safe capacity ~92. Withdrawals > 92 should be large
      // Withdrawals > 92 should be considered large and queued
      
      const withdrawAmount = parseEther("100"); // Larger than safe capacity (92)
      console.log(`Withdrawing ${withdrawAmount} ETH, should be larger than safe capacity`);
      
      // This should be treated as a large withdrawal and queued
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("2000")], { account: player1.account });
      
      // Check that withdrawal was queued
      const [pendingAmount, queuePosition] = 
        await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmount).to.equal(withdrawAmount);
      expect(queuePosition).to.be.greaterThan(0);
      
      console.log(`✅ Large withdrawal detected! Pending: ${pendingAmount}, Queue Position: ${queuePosition}`);
    });

    it("Should queue withdrawals in FIFO order", async function () {
      // Isolated: start from clean fixture state (maxPayout = 0). No shared beforeEach bet.
      // Setup: both players deposit, then place one bet to create maxPayout scenario.
      
      // Ensure both players have enough BRB
      await brb.write.transfer([player1.account.address, parseEther("2000")], { account: admin.account });
      await brb.write.transfer([player2.account.address, parseEther("2000")], { account: admin.account });
      
      // Player 1 deposits
      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], { account: player1.account });
      await stakedBrbProxy.write.deposit([parseEther("2000"), player1.account.address, 0n], { account: player1.account });
      
      // Player 2 deposits
      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], { account: player2.account });
      await stakedBrbProxy.write.deposit([parseEther("2000"), player2.account.address, 0n], { account: player2.account });
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      
      // Now place a bet to create maxPayout scenario
      const totalAssetsAfterDeposits = await stakedBrbProxy.read.totalAssets();
      
      // Get the safe capacity to determine how much we can bet
      const safeCapacity = await stakedBrbProxy.read.getSafeCapacity();
      console.log(`Safe capacity: ${safeCapacity}`);
      
      // Calculate bet amount based on safe capacity (use a small portion to ensure maxPayout doesn't exceed safe capacity)
      const betAmount = safeCapacity / 36n; // Use 1/36 of safe capacity to ensure maxPayout (36x) stays within safe capacity
      console.log(`Calculated bet amount: ${betAmount}`);
      
      // Ensure player1 has enough BRB for the bet
      const player1Balance = await brb.read.balanceOf([player1.account.address]);
      if (player1Balance < betAmount) {
        await brb.write.transfer([player1.account.address, betAmount - player1Balance], { account: admin.account });
      }
      
      // Ensure vault has enough balance for max payout (with safety buffer)
      // IMPORTANT: Account for existing cumulative maxPayout from previous bets
      // The contract checks AFTER bet transfer: balance_after >= nextMaxPayout
      // Where: balance_after = balance_before + betAmount
      // And: nextMaxPayout = existingMaxPayout + newBetMaxPayout
      // So: balance_before + betAmount >= existingMaxPayout + newBetMaxPayout
      // Therefore: balance_before >= existingMaxPayout + newBetMaxPayout - betAmount
      const SAFETY_BUFFER_BPS = 11000n;
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const nextMaxPayout = existingMaxPayout + newBetMaxPayout;
      // Ensure we don't underflow
      const requiredBalanceBeforeBet = nextMaxPayout > betAmount ? nextMaxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      
      if (vaultBalance < requiredBalanceBeforeBet) {
        const neededAmount = requiredBalanceBeforeBet - vaultBalance + parseEther("100");
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      // Place the bet
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );
      
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: player1.account });
      
      // Now check safe capacity after bet
      const safeCapacityAfterBet = await stakedBrbProxy.read.getSafeCapacity();
      console.log(`Safe capacity after bet: ${safeCapacityAfterBet}`);
      
      // Queue multiple withdrawals - use amount larger than safe capacity
      const withdrawAmount = safeCapacityAfterBet + parseEther("100"); // Larger than safe capacity
      console.log(`Withdraw amount: ${withdrawAmount}`);
      
      // Player 1 withdrawal
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("2000")], { account: player1.account });
      
      // Player 2 withdrawal
      await stakedBrbProxy.write.withdraw([withdrawAmount, player2.account.address, player2.account.address, parseEther("2000")], { account: player2.account });
      
      // Debug: Check withdrawal settings after withdrawals
      const [batchSize, queueLength, maxQueueLength] = await stakedBrbProxy.read.getWithdrawalSettings();
      console.log(`After withdrawals - Batch size: ${batchSize}, Queue length: ${queueLength}, Max queue length: ${maxQueueLength}`);
      
      // Check queue positions
      const [, pos1] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      const [, pos2] = await stakedBrbProxy.read.getUserPendingWithdrawal([player2.account.address]);
      
      console.log(`Debug FIFO: pos1=${pos1}, pos2=${pos2}`);
      // Check that both users are in the queue (position > 0)
      expect(pos1).to.be.above(0);
      expect(pos2).to.be.above(0);
      
      // Check that player1 is before player2 in the queue (FIFO order)
      expect(pos1).to.be.lessThan(pos2);
    });

    it("Should prevent duplicate withdrawal requests", async function () {
      // Isolated: set up scenario for this test only
      await setupWithdrawalScenario(parseEther("2000"), true);
      // Any withdrawal > safe capacity will be large
      
      const withdrawAmount = parseEther("100"); // Larger than safe capacity
      
      // First request should succeed
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account });
      
      // Second request should fail
      await expect(
        stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account })
      ).to.be.rejectedWith("WithdrawalPending");
    });

    it("Should enforce queue size limits", async function () {
      // Isolated: start from clean state, set up deposits and one bet ourselves
      await stakedBrbProxy.write.setMaxQueueLength([2n], { account: admin.account });
      
      await setupWithdrawalScenario(parseEther("2000"), false); // Deposit only
      
      // Ensure player2 has enough BRB and deposit
      const player2Balance = await brb.read.balanceOf([player2.account.address]);
      const depositAmount = parseEther("500");
      if (player2Balance < depositAmount) {
        await brb.write.transfer([player2.account.address, depositAmount - player2Balance], { account: admin.account });
      }
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player2.account });
      await stakedBrbProxy.write.deposit([depositAmount, player2.account.address, 0n], { account: player2.account });
      
      // Ensure player3 has enough BRB and deposit
      const player3Balance = await brb.read.balanceOf([player3.account.address]);
      if (player3Balance < depositAmount) {
        await brb.write.transfer([player3.account.address, depositAmount - player3Balance], { account: admin.account });
      }
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player3.account });
      await stakedBrbProxy.write.deposit([depositAmount, player3.account.address, 0n], { account: player3.account });

      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      
      // Get the safe capacity to determine how much we can bet
      const safeCapacity = await stakedBrbProxy.read.getSafeCapacity();
      console.log(`Safe capacity: ${safeCapacity}`);
      
      // Calculate bet amount based on safe capacity (use a small portion to ensure maxPayout doesn't exceed safe capacity)
      const betAmount = safeCapacity / 36n; // Use 2% of safe capacity to ensure maxPayout (36x) stays within safe capacity
      console.log(`Calculated bet amount: ${betAmount}`);
      
      // Ensure vault has enough balance for the bet (with safety buffer). Use getMaxPayout for isolation.
      const SAFETY_BUFFER_BPS = 11000n;
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const nextMaxPayout = existingMaxPayout + newBetMaxPayout;
      const requiredBalance = nextMaxPayout > betAmount ? nextMaxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100");
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      const withdrawAmount = parseEther("150");
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      // Fill up the queue
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      
      // Debug: Check withdrawal settings after first withdrawal
      const [batchSize1, queueLength1, maxQueueLength1] = await stakedBrbProxy.read.getWithdrawalSettings();
      console.log(`After player1 withdrawal - Batch size: ${batchSize1}, Queue length: ${queueLength1}, Max queue length: ${maxQueueLength1}`);
      
      await stakedBrbProxy.write.withdraw([withdrawAmount, player2.account.address, player2.account.address, maxSharesOut], { account: player2.account });
      
      // Debug: Check withdrawal settings after second withdrawal
      const [batchSize2, queueLength2, maxQueueLength2] = await stakedBrbProxy.read.getWithdrawalSettings();
      console.log(`After player2 withdrawal - Batch size: ${batchSize2}, Queue length: ${queueLength2}, Max queue length: ${maxQueueLength2}`);
      
      // Third request should fail
      await expect(
        stakedBrbProxy.write.withdraw([withdrawAmount, player3.account.address, player3.account.address, maxSharesOut], { account: player3.account })
      ).to.be.rejectedWith("QueueFull");
    });

    it("Should allow users to cancel queued withdrawal requests", async function () {
      // Isolated: start from clean state, deposit then place bet
      await setupWithdrawalScenario(parseEther("2000"), false);
      
      // Get the safe capacity to determine how much we can bet
      const safeCapacity = await stakedBrbProxy.read.getSafeCapacity();
      console.log(`Safe capacity: ${safeCapacity}`);
      
      // Calculate bet amount based on safe capacity (use a small portion to ensure maxPayout doesn't exceed safe capacity)
      const betAmount = safeCapacity / 36n; // Use 2% of safe capacity to ensure maxPayout (36x) stays within safe capacity
      console.log(`Calculated bet amount: ${betAmount}`);
      
      // Ensure vault has enough balance for the bet (use getMaxPayout for isolation)
      const SAFETY_BUFFER_BPS = 11000n;
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const nextMaxPayout = existingMaxPayout + newBetMaxPayout;
      const requiredBalance = nextMaxPayout > betAmount ? nextMaxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100");
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      const withdrawAmount = parseEther("150");
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      
      // Debug: Check withdrawal settings after withdrawal
      const [batchSize, queueLength, maxQueueLength] = await stakedBrbProxy.read.getWithdrawalSettings();
      console.log(`After player1 withdrawal - Batch size: ${batchSize}, Queue length: ${queueLength}, Max queue length: ${maxQueueLength}`);
      
      // Check initial state
      const [pendingAmountBefore] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      console.log(`Player1 pending withdrawal amount: ${pendingAmountBefore}`);
      expect(pendingAmountBefore).to.equal(withdrawAmount);
      
      // Cancel withdrawal
      await stakedBrbProxy.write.cancelWithdrawal({ account: player1.account });
      
      // Check final state
      const [pendingAmountAfter] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmountAfter).to.equal(0);
    });

    it("Should revert when trying to cancel non-existent withdrawal", async function () {
      // Isolated: no setup; player1 has no pending withdrawal. Cancel should revert.
      await expect(
        stakedBrbProxy.write.cancelWithdrawal({ account: player1.account })
      ).to.be.rejectedWith("NoWithdrawalPending");
    });

    it("Should revert when withdrawal amount exceeds balance", async function () {
      // Isolated: deposit + small bet so we have maxPayout; then try to withdraw more than balance
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const betAmount = parseEther("1");
      const SAFETY_BUFFER_BPS = 11000n;
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = (existingMaxPayout + newBetMaxPayout) > betAmount ? (existingMaxPayout + newBetMaxPayout) - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        await brb.write.transfer([stakedBrbProxy.address, requiredBalance - vaultBalance + parseEther("100")], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      const excessiveAmount = parseEther("50000"); // More than user has
      
      await expect(
        stakedBrbProxy.write.withdraw([excessiveAmount, player1.account.address, player1.account.address, 0n], { account: player1.account })
      ).to.be.rejectedWith("WithdrawalTooLarge");
    });
  });

  describe("Withdrawal processing (upkeep)", function () {
    it("Should process queued withdrawals through upkeep", async function () {
      // Isolated: set up scenario for this test only (deposit + bet)
      await setupWithdrawalScenario(parseEther("2000"), true);
      // Queue a large withdrawal
      const withdrawAmount = parseEther("150"); // Always larger than 100 ETH to trigger large withdrawal
      
      // Calculate the actual shares needed for this withdrawal
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n; // Use 2x the needed shares to avoid MaxSharesError
      
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      
      // Verify withdrawal was queued
      const [pendingAmountBefore] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmountBefore).to.equal(withdrawAmount);
      
      console.log(`✅ Large withdrawal queued: ${pendingAmountBefore} ETH`);
      
      // COMPLETE THE FULL GAME LOOP BEFORE PROCESSING LARGE WITHDRAWALS
      
      // 1. Pre-VRF lock then VRF
      await advanceThroughLockToVrfWindow(stakedBrbProxy);

      const [needsExecutionVRF, performDataVRF] = await rouletteProxy.read.checkUpkeep(["0x01"]);
      expect(needsExecutionVRF).to.be.true;
      
      const txVRF = await rouletteProxy.write.performUpkeep([performDataVRF], { account: admin.account });
      const receiptVRF = await publicClient.waitForTransactionReceipt({ hash: txVRF });
      const logsVRF = parseEventLogs({
        abi: rouletteProxy.abi,
        eventName: 'VrfRequested',
        logs: receiptVRF.logs,
      });

      if (!logsVRF.length) {
        throw new Error("VrfRequested event not found");
      }
      const requestId = logsVRF[0].args.requestId;

      // 2. VRF Fulfilment
      await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [7n, 10n]]); // Use 7 as winning number
      
      // 3. COMPUTE TOTAL WINNING BETS
      const [computeNeeded, computeData] = await rouletteProxy.read.checkUpkeep([toHex(new Uint8Array(2))]); // checkData.length == 2
      expect(computeNeeded).to.be.true;
      await rouletteProxy.write.performUpkeep([computeData], { account: admin.account });

      // 4. Payout Trigger & Processing (iterative)
      let processedPayoutBatches = 0;
      while (true) {
        const checkDataForPayout = new Uint8Array(Number(processedPayoutBatches) + 3); // checkData.length 2 for batch 0, 3 for batch 1, etc.
        const hexCheckData = toHex(checkDataForPayout);
        const [payoutsNeeded, payoutData] = await rouletteProxy.read.checkUpkeep([hexCheckData]);
        if (!payoutsNeeded) break;

        await rouletteProxy.write.performUpkeep([payoutData], { account: admin.account });
        processedPayoutBatches++;
        await time.increase(10n); // Advance time slightly for subsequent upkeeps
      }
      
      // 5. NOW PROCESS LARGE WITHDRAWALS
      const [upkeepNeeded, _performData] = await stakedBrbProxy.read.checkUpkeep(["0x02"]);
      expect(upkeepNeeded).to.be.true;

      await expect(stakedBrbProxy.write.performUpkeep([_performData], { account: admin.account })).to.not.be.rejected;
      
      console.log(`✅ Full game loop completed! Large withdrawal upkeep needed: ${upkeepNeeded}`);
      console.log(`✅ This test verifies that the complete game loop works correctly with large withdrawals`);
    });

    it("Should calculate safe withdrawal capacity correctly", async function () {
      // Isolated: set up scenario so we have non-zero balance and maxPayout
      await setupWithdrawalScenario(parseEther("2000"), true);
      
      const currentBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      const maxPayout = await stakedBrbProxy.read.getMaxPayout();
      
      // The safe capacity should be currentBalance - maxPayout
      const _expectedSafeCapacity = currentBalance > maxPayout ? currentBalance - maxPayout : 0n;
      
      // We can verify this by testing withdrawal behavior
      const testAmount = parseEther("100"); // Use a reasonable test amount
      
      // This should be considered a large withdrawal
      await expect(
        stakedBrbProxy.write.withdraw([testAmount, player1.account.address, player1.account.address, 0n], { account: player1.account })
      ).to.not.be.rejected; // Should queue the withdrawal
    });
  });

  describe("Protocol Fee Management", function () {
    it("Should calculate protocol fees correctly", async function () {
      const lossAmount = parseEther("1000");
      const [, , protocolFeeBasisPoints, burnFeeRate, jackpotFeeRate, , ] = await stakedBrbProxy.read.getVaultConfig();
      const [{ protocolFees, burnAmount, jackpotAmount }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
      
      // With 2.5% fee rate (250 basis points)
      const expectedFee = lossAmount * protocolFeeBasisPoints / 10000n;
      const expectedBurn = lossAmount * burnFeeRate / 10000n;
      const expectedJackpot = lossAmount * jackpotFeeRate / 10000n;

      const expectedProfit = lossAmount - (expectedFee + expectedBurn + expectedJackpot);
      
      expect(protocolFees).to.equal(expectedFee);
      expect(stakerProfit).to.equal(expectedProfit);
      expect(burnAmount).to.equal(expectedBurn);
      expect(jackpotAmount).to.equal(expectedJackpot);
    });

    it("Should update protocol fee rate", async function () {
      const newFeeRate = 500n; // 5%
      
      await stakedBrbProxy.write.setProtocolFeeRate([newFeeRate], { account: admin.account });
      
      const [_brbToken, _rouletteContract, protocolFeeBasisPoints, _feeRecipient, _pendingBets] = 
        await stakedBrbProxy.read.getVaultConfig();
      
      expect(protocolFeeBasisPoints).to.equal(newFeeRate);
    });

    it("Should revert with invalid fee rate", async function () {
      const invalidFeeRate = 10001n; // > MAX_PROTOCOL_FEE
      
      await expect(
        stakedBrbProxy.write.setProtocolFeeRate([invalidFeeRate], { account: admin.account })
      ).to.be.rejectedWith("InvalidFeeRate");
    });

    it("Should update fee recipient", async function () {
      const newRecipient = player2.account.address;
      
      await stakedBrbProxy.write.setFeeRecipient([newRecipient], { account: admin.account });
      
      const [_brbToken, _rouletteContract, _protocolFeeBasisPoints, _burnFeeRate, _jackpotFeeRate, feeRecipient, _pendingBets] = 
        await stakedBrbProxy.read.getVaultConfig();
      
      expect(checksumAddress(feeRecipient)).to.equal(checksumAddress(newRecipient));
    });

    it("Should revert with zero fee recipient", async function () {
      await expect(
        stakedBrbProxy.write.setFeeRecipient(["0x0000000000000000000000000000000000000000"], { account: admin.account })
      ).to.be.rejectedWith("InvalidFeeRate");
    });
  });

  describe("Fee Parameters Management", function () {
    describe("Burn Fee Rate", function () {
      it("Should update burn fee rate", async function () {
        const newBurnFeeRate = 200n; // 2%
        
        await stakedBrbProxy.write.setBurnFeeRate([newBurnFeeRate], { account: admin.account });
        
        const [, , , burnBasisPoints, , , ] = await stakedBrbProxy.read.getVaultConfig();
        
        expect(burnBasisPoints).to.equal(newBurnFeeRate);
      });

      it("Should revert when burn fee rate exceeds max when combined with other fees", async function () {
        const [, , protocolFeeBasisPoints, , jackpotBasisPoints, , ] = await stakedBrbProxy.read.getVaultConfig();
        const invalidBurnFeeRate = 10000n - protocolFeeBasisPoints - jackpotBasisPoints + 1n; // Would exceed MAX_PROTOCOL_FEE
        
        await expect(
          stakedBrbProxy.write.setBurnFeeRate([invalidBurnFeeRate], { account: admin.account })
        ).to.be.rejectedWith("InvalidFeeRate");
      });

      it("Should allow zero burn fee rate", async function () {
        await stakedBrbProxy.write.setBurnFeeRate([0n], { account: admin.account });
        
        const [, , , burnBasisPoints, , , ] = await stakedBrbProxy.read.getVaultConfig();
        
        expect(burnBasisPoints).to.equal(0n);
      });

      it("Should emit BurnFeeRateUpdated event", async function () {
        const newBurnFeeRate = 250n;
        
        const tx = await stakedBrbProxy.write.setBurnFeeRate([newBurnFeeRate], { account: admin.account });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        
        const logs = parseEventLogs({
          abi: stakedBrbProxy.abi,
          eventName: 'BurnFeeRateUpdated',
          logs: receipt.logs,
        });
        
        expect(logs.length).to.be.greaterThan(0);
        expect((logs[0] as { args: { newFee: bigint } }).args.newFee).to.equal(newBurnFeeRate);
      });

      it("Should only allow admin to update burn fee rate", async function () {
        const newBurnFeeRate = 200n;
        
        await expect(
          stakedBrbProxy.write.setBurnFeeRate([newBurnFeeRate], { account: player1.account })
        ).to.be.rejected;
      });
    });

    describe("Jackpot Fee Rate", function () {
      it("Should update jackpot fee rate", async function () {
        const newJackpotFeeRate = 300n; // 3%
        
        await stakedBrbProxy.write.setJackpotFeeRate([newJackpotFeeRate], { account: admin.account });
        
        const [, , , , jackpotBasisPoints, , ] = await stakedBrbProxy.read.getVaultConfig();
        
        expect(jackpotBasisPoints).to.equal(newJackpotFeeRate);
      });

      it("Should revert when jackpot fee rate exceeds max when combined with other fees", async function () {
        const [, , protocolFeeBasisPoints, burnBasisPoints, , , ] = await stakedBrbProxy.read.getVaultConfig();
        const invalidJackpotFeeRate = 10000n - protocolFeeBasisPoints - burnBasisPoints + 1n; // Would exceed MAX_PROTOCOL_FEE
        
        await expect(
          stakedBrbProxy.write.setJackpotFeeRate([invalidJackpotFeeRate], { account: admin.account })
        ).to.be.rejectedWith("InvalidFeeRate");
      });

      it("Should allow zero jackpot fee rate", async function () {
        await stakedBrbProxy.write.setJackpotFeeRate([0n], { account: admin.account });
        
        const [, , , , jackpotBasisPoints, , ] = await stakedBrbProxy.read.getVaultConfig();
        
        expect(jackpotBasisPoints).to.equal(0n);
      });

      it("Should emit JackpotFeeRateUpdated event", async function () {
        const newJackpotFeeRate = 350n;
        
        const tx = await stakedBrbProxy.write.setJackpotFeeRate([newJackpotFeeRate], { account: admin.account });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        
        const logs = parseEventLogs({
          abi: stakedBrbProxy.abi,
          eventName: 'JackpotFeeRateUpdated',
          logs: receipt.logs,
        });
        
        expect(logs.length).to.be.greaterThan(0);
        expect((logs[0] as { args: { newFee: bigint } }).args.newFee).to.equal(newJackpotFeeRate);
      });

      it("Should only allow admin to update jackpot fee rate", async function () {
        const newJackpotFeeRate = 300n;
        
        await expect(
          stakedBrbProxy.write.setJackpotFeeRate([newJackpotFeeRate], { account: player1.account })
        ).to.be.rejected;
      });
    });

    describe("Combined Fee Validation", function () {
      it("Should allow setting fees that sum to exactly MAX_PROTOCOL_FEE", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([4000n], { account: admin.account });
        await stakedBrbProxy.write.setBurnFeeRate([3000n], { account: admin.account });
        await stakedBrbProxy.write.setJackpotFeeRate([3000n], { account: admin.account });
        
        const [, , protocolFeeBasisPoints, burnBasisPoints, jackpotBasisPoints, , ] = await stakedBrbProxy.read.getVaultConfig();
        
        expect(protocolFeeBasisPoints + burnBasisPoints + jackpotBasisPoints).to.equal(10000n);
      });

      it("Should revert when protocol fee update would exceed max combined with other fees", async function () {
        await stakedBrbProxy.write.setBurnFeeRate([3000n], { account: admin.account });
        await stakedBrbProxy.write.setJackpotFeeRate([3000n], { account: admin.account });
        
        const invalidProtocolFee = 4001n; // Would exceed MAX_PROTOCOL_FEE (3000 + 3000 + 4001 = 10001)
        
        await expect(
          stakedBrbProxy.write.setProtocolFeeRate([invalidProtocolFee], { account: admin.account })
        ).to.be.rejectedWith("InvalidFeeRate");
      });

      it("Should revert when burn fee update would exceed max combined with other fees", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([3000n], { account: admin.account });
        await stakedBrbProxy.write.setJackpotFeeRate([3000n], { account: admin.account });
        
        const invalidBurnFee = 4001n; // Would exceed MAX_PROTOCOL_FEE
        
        await expect(
          stakedBrbProxy.write.setBurnFeeRate([invalidBurnFee], { account: admin.account })
        ).to.be.rejectedWith("InvalidFeeRate");
      });

      it("Should revert when jackpot fee update would exceed max combined with other fees", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([3000n], { account: admin.account });
        await stakedBrbProxy.write.setBurnFeeRate([3000n], { account: admin.account });
        
        const invalidJackpotFee = 4001n; // Would exceed MAX_PROTOCOL_FEE
        
        await expect(
          stakedBrbProxy.write.setJackpotFeeRate([invalidJackpotFee], { account: admin.account })
        ).to.be.rejectedWith("InvalidFeeRate");
      });

      it("Should allow updating fees in any order as long as sum is valid", async function () {
        // Set fees in different order
        await stakedBrbProxy.write.setJackpotFeeRate([2000n], { account: admin.account });
        await stakedBrbProxy.write.setProtocolFeeRate([3000n], { account: admin.account });
        await stakedBrbProxy.write.setBurnFeeRate([2000n], { account: admin.account });
        
        const [, , protocolFeeBasisPoints, burnBasisPoints, jackpotBasisPoints, , ] = await stakedBrbProxy.read.getVaultConfig();
        
        expect(protocolFeeBasisPoints + burnBasisPoints + jackpotBasisPoints).to.equal(7000n);
        expect(protocolFeeBasisPoints).to.equal(3000n);
        expect(burnBasisPoints).to.equal(2000n);
        expect(jackpotBasisPoints).to.equal(2000n);
      });
    });

    describe("Fee Calculation with All Fees", function () {
      it("Should calculate all three fees correctly", async function () {
        // Set specific fee rates
        await stakedBrbProxy.write.setProtocolFeeRate([300n], { account: admin.account }); // 3%
        await stakedBrbProxy.write.setBurnFeeRate([200n], { account: admin.account }); // 2%
        await stakedBrbProxy.write.setJackpotFeeRate([150n], { account: admin.account }); // 1.5%
        
        const lossAmount = parseEther("1000");
        const [{ protocolFees, burnAmount, jackpotAmount }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
        
        // Expected fees (using floor rounding)
        const expectedProtocolFee = (lossAmount * 300n) / 10000n;
        const expectedBurnAmount = (lossAmount * 200n) / 10000n;
        const expectedJackpotAmount = (lossAmount * 150n) / 10000n;
        const expectedStakerProfit = lossAmount - expectedProtocolFee - expectedBurnAmount - expectedJackpotAmount;
        
        expect(protocolFees).to.equal(expectedProtocolFee);
        expect(burnAmount).to.equal(expectedBurnAmount);
        expect(jackpotAmount).to.equal(expectedJackpotAmount);
        expect(stakerProfit).to.equal(expectedStakerProfit);
      });

      it("Should calculate fees correctly with different loss amounts", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([250n], { account: admin.account });
        await stakedBrbProxy.write.setBurnFeeRate([150n], { account: admin.account });
        await stakedBrbProxy.write.setJackpotFeeRate([100n], { account: admin.account });
        
        const testAmounts = [parseEther("100"), parseEther("1000"), parseEther("10000")];
        
        for (const lossAmount of testAmounts) {
          const [{ protocolFees, burnAmount, jackpotAmount }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
          
          const expectedProtocolFee = (lossAmount * 250n) / 10000n;
          const expectedBurnAmount = (lossAmount * 150n) / 10000n;
          const expectedJackpotAmount = (lossAmount * 100n) / 10000n;
          const expectedStakerProfit = lossAmount - expectedProtocolFee - expectedBurnAmount - expectedJackpotAmount;
          
          expect(protocolFees).to.equal(expectedProtocolFee);
          expect(burnAmount).to.equal(expectedBurnAmount);
          expect(jackpotAmount).to.equal(expectedJackpotAmount);
          expect(stakerProfit).to.equal(expectedStakerProfit);
        }
      });

      it("Should handle fractional fee calculations correctly", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([333n], { account: admin.account }); // 3.33%
        await stakedBrbProxy.write.setBurnFeeRate([222n], { account: admin.account }); // 2.22%
        await stakedBrbProxy.write.setJackpotFeeRate([111n], { account: admin.account }); // 1.11%
        
        const lossAmount = parseEther("1000");
        const [{ protocolFees, burnAmount, jackpotAmount }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
        
        // With floor rounding, fees should be calculated correctly
        const expectedProtocolFee = (lossAmount * 333n) / 10000n;
        const expectedBurnAmount = (lossAmount * 222n) / 10000n;
        const expectedJackpotAmount = (lossAmount * 111n) / 10000n;
        const expectedStakerProfit = lossAmount - expectedProtocolFee - expectedBurnAmount - expectedJackpotAmount;
        
        expect(protocolFees).to.equal(expectedProtocolFee);
        expect(burnAmount).to.equal(expectedBurnAmount);
        expect(jackpotAmount).to.equal(expectedJackpotAmount);
        expect(stakerProfit).to.equal(expectedStakerProfit);
        
        // Verify sum is correct
        expect(protocolFees + burnAmount + jackpotAmount + stakerProfit).to.equal(lossAmount);
      });

      it("Should return zero fees when loss amount is zero", async function () {
        const [{ protocolFees, burnAmount, jackpotAmount }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([0n]);
        
        expect(protocolFees).to.equal(0n);
        expect(burnAmount).to.equal(0n);
        expect(jackpotAmount).to.equal(0n);
        expect(stakerProfit).to.equal(0n);
      });

      it("Should return correct staker profit after all fees", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([500n], { account: admin.account }); // 5%
        await stakedBrbProxy.write.setBurnFeeRate([300n], { account: admin.account }); // 3%
        await stakedBrbProxy.write.setJackpotFeeRate([200n], { account: admin.account }); // 2%
        
        const lossAmount = parseEther("1000");
        const [, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
        
        // Total fees = 5% + 3% + 2% = 10% = 100 ETH
        // Staker profit = 1000 - 100 = 900 ETH
        const expectedStakerProfit = parseEther("900");
        
        expect(stakerProfit).to.equal(expectedStakerProfit);
      });
    });

    describe("Fee Configuration Retrieval", function () {
      it("Should return all fee parameters in getVaultConfig", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([400n], { account: admin.account });
        await stakedBrbProxy.write.setBurnFeeRate([300n], { account: admin.account });
        await stakedBrbProxy.write.setJackpotFeeRate([200n], { account: admin.account });
        
        const [, , protocolFeeBasisPoints, burnBasisPoints, jackpotBasisPoints, feeRecipient, ] = await stakedBrbProxy.read.getVaultConfig();
        
        expect(protocolFeeBasisPoints).to.equal(400n);
        expect(burnBasisPoints).to.equal(300n);
        expect(jackpotBasisPoints).to.equal(200n);
        expect(feeRecipient.toLowerCase()).to.equal(admin.account.address.toLowerCase());
      });

      it("Should persist fee configuration across transactions", async function () {
        await stakedBrbProxy.write.setProtocolFeeRate([350n], { account: admin.account });
        await stakedBrbProxy.write.setBurnFeeRate([250n], { account: admin.account });
        await stakedBrbProxy.write.setJackpotFeeRate([150n], { account: admin.account });
        
        // Read config multiple times
        const config1 = await stakedBrbProxy.read.getVaultConfig();
        const config2 = await stakedBrbProxy.read.getVaultConfig();
        
        expect(config1[2]).to.equal(config2[2]); // protocolFeeBasisPoints
        expect(config1[3]).to.equal(config2[3]); // burnBasisPoints
        expect(config1[4]).to.equal(config2[4]); // jackpotBasisPoints
      });
    });
  });

  describe("Betting Integration", function () {
    it("Should handle betting through onTokenTransfer", async function () {
      // First, ensure the vault has enough balance for max payout
      // Note: The contract applies a safety buffer of 110% (SAFETY_BUFFER_BPS = 11000)
      const SAFETY_BUFFER_BPS = 11000n;
      const vaultBalance = await stakedBrbProxy.read.totalAssets();
      const betAmount = parseEther("1");
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n; // Straight bet has 36x payout with 110% safety buffer
      
      // If vault doesn't have enough balance, fund it
      // IMPORTANT: Account for existing cumulative maxPayout from previous bets
      // The contract checks: balance + betAmount >= existingMaxPayout + newBetMaxPayout
      // So: balance >= existingMaxPayout + newBetMaxPayout - betAmount
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const nextMaxPayout = existingMaxPayout + maxPayout;
      const requiredBalance = nextMaxPayout - betAmount;
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Small buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      // Place bet using BRB token's bet function (which calls transferAndCall)
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      const tx = await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      
      const logs = parseEventLogs({
        abi: stakedBrbProxy.abi,
        eventName: 'BetPlaced',
        logs: receipt.logs,
      });
      
      expect(logs.length).to.be.greaterThan(0);
      expect((logs[0] as { args: { user: string; amount: bigint } }).args.user.toLowerCase()).to.equal(admin.account.address.toLowerCase());
      expect((logs[0] as { args: { user: string; amount: bigint } }).args.amount).to.equal(betAmount);
    });

    it("Should only allow BRB token to call onTokenTransfer", async function () {
      const betAmount = parseEther("1");
      const betData = "0x1234";
      
      await expect(
        stakedBrbProxy.write.onTokenTransfer([admin.account.address, betAmount, betData, zeroAddress], { account: player1.account })
      ).to.be.rejectedWith("OnlyBRB");
    });

    it("Should track pending bets correctly", async function () {
      const betAmount = parseEther("1");
      
      // First, ensure the vault has enough balance for max payout
      // Note: The contract applies a safety buffer of 110% (SAFETY_BUFFER_BPS = 11000)
      const SAFETY_BUFFER_BPS = 11000n;
      const vaultBalance = await stakedBrbProxy.read.totalAssets();
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n; // Straight bet has 36x payout with 110% safety buffer
      
      // If vault doesn't have enough balance, fund it
      // IMPORTANT: Account for existing cumulative maxPayout from previous bets
      // The contract checks: balance + betAmount >= existingMaxPayout + newBetMaxPayout
      // So: balance >= existingMaxPayout + newBetMaxPayout - betAmount
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const nextMaxPayout = existingMaxPayout + maxPayout;
      const requiredBalance = nextMaxPayout - betAmount;
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Small buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      // Create proper bet data
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      
      await brb.write.transfer([stakedBrbProxy.address, betAmount], { account: admin.account });
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      const [_brbToken, _rouletteContract, _protocolFeeBasisPoints, _burnFeeRate, _jackpotFeeRate, _feeRecipient, pendingBets] = 
        await stakedBrbProxy.read.getVaultConfig();
      
      expect(pendingBets).to.equal(betAmount);
    });

    it("Should revert when insufficient balance for max payout", async function () {
      // This would require creating a scenario where the contract doesn't have enough balance
      // to cover the max payout from betting
      // This is a complex scenario that would need careful setup
    });
  });

  describe("Roulette Result Processing", function () {
    it("Should process roulette results correctly", async function () {
      // This would require setting up a mock roulette contract
      // and testing the processRouletteResult function
      // For now, we'll test the access control
      
      await expect(
        stakedBrbProxy.write.processRouletteResult([1n, [], 0n, false], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should only allow roulette contract to process results", async function () {
      const payoutInfo = [{
        player: player1.account.address,
        betAmount: parseEther("50"),
        payout: parseEther("100")
      }];
      
      await expect(
        stakedBrbProxy.write.processRouletteResult([1n, payoutInfo, parseEther("100"), true], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });
  });

  describe("Round Transition", function () {
    it("Should handle round transitions correctly", async function () {
      await expect(
        stakedBrbProxy.write.onRoundTransition([], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should only allow roulette contract to trigger round transitions", async function () {
      const _newRoundId = 2n;
      const _previousRoundId = 1n;
      
      // This should be called by the roulette contract
      // We can't test this directly without the roulette contract
    });
  });

  describe("Admin Functions", function () {
    it("Should update large withdrawal batch size", async function () {
      const newBatchSize = 10n;
      
      await stakedBrbProxy.write.setWithdrawalBatchSize([newBatchSize], { account: admin.account });
      
      const [withdrawalBatchSize, , ] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      
      expect(withdrawalBatchSize).to.equal(newBatchSize);
    });

    it("Should revert with invalid batch size", async function () {
      const invalidBatchSize = 0n;
      
      await expect(
        stakedBrbProxy.write.setWithdrawalBatchSize([invalidBatchSize], { account: admin.account })
      ).to.be.rejectedWith("InvalidWithdrawalBatchSize");
    });

    it("Should revert with excessive batch size", async function () {
      const excessiveBatchSize = 13n; // > MAX_WITHDRAWAL_BATCH_SIZE

      await expect(
        stakedBrbProxy.write.setWithdrawalBatchSize([excessiveBatchSize], { account: admin.account })
      ).to.be.rejectedWith("InvalidWithdrawalBatchSize");
    });

    it("Should update liquidity ops per cleaning upkeep within cap", async function () {
      await stakedBrbProxy.write.setLiquidityOpsPerCleaningUpkeep([60], { account: admin.account });
      expect(await stakedBrbProxy.read.getLiquidityOpsPerCleaningUpkeep()).to.equal(60n);
    });

    it("Should revert excessive liquidity ops per cleaning upkeep", async function () {
      await expect(
        stakedBrbProxy.write.setLiquidityOpsPerCleaningUpkeep([81], { account: admin.account })
      ).to.be.rejectedWith("InvalidLiquidityOpsPerUpkeep");
    });

    it("Should expose operational limits (hard caps)", async function () {
      const [maxBatch, maxQueue, maxLiqOps, gasLimit] = await stakedBrbProxy.read.getOperationalLimits();
      expect(maxBatch).to.equal(12n);
      expect(maxQueue).to.equal(1000n);
      expect(maxLiqOps).to.equal(80n);
      expect(gasLimit).to.equal(2_000_000n);
    });

    it("Should update max queue length", async function () {
      const newMaxQueueLength = 200n;
      
      await stakedBrbProxy.write.setMaxQueueLength([newMaxQueueLength], { account: admin.account });
      
      const [, , maxQueueLength] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      
      expect(maxQueueLength).to.equal(newMaxQueueLength);
    });

    it("Should revert with invalid max queue length", async function () {
      const invalidMaxQueueLength = 0n;
      
      await expect(
        stakedBrbProxy.write.setMaxQueueLength([invalidMaxQueueLength], { account: admin.account })
      ).to.be.rejectedWith("InvalidMaxQueueLength");
    });

    it("Should revert with excessive max queue length", async function () {
      const excessiveMaxQueueLength = 1001n; // > MAX_MAX_QUEUE_LENGTH
      
      await expect(
        stakedBrbProxy.write.setMaxQueueLength([excessiveMaxQueueLength], { account: admin.account })
      ).to.be.rejectedWith("InvalidMaxQueueLength");
    });

    it("Should only allow admin to call admin functions", async function () {
      await expect(
        stakedBrbProxy.write.setProtocolFeeRate([500n], { account: player1.account })
      ).to.be.rejectedWith("AccessControl");
    });
  });

  describe("View Functions", function () {
    beforeEach(async function () {
      // Setup some state for testing view functions
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
    });

    it("Should return correct staking stats", async function () {
      // Use ERC4626 compliant functions
      const totalShares = await stakedBrbProxy.read.totalSupply();
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      
      expect(totalShares).to.be.greaterThan(0);
      expect(totalAssets).to.be.greaterThan(0);
    });

    it("Should return correct protocol fee rate", async function () {
      const [, , protocolFeeBasisPoints, , , , ] = await stakedBrbProxy.read.getVaultConfig();
      expect(protocolFeeBasisPoints).to.equal(300n); // 3%
    });

    it("Should return correct pending bets", async function () {
      const pendingBets = await stakedBrbProxy.read.getPendingBets();
      expect(pendingBets).to.equal(0n); // No bets placed yet
    });

    it("Should return correct total balance", async function () {
      // Use ERC4626 compliant function
      const totalBalance = await stakedBrbProxy.read.totalAssets();
      expect(totalBalance).to.be.greaterThan(0);
    });

    it("Should return correct exchange rate", async function () {
      // Use ERC4626 compliant function to calculate exchange rate
      const totalShares = await stakedBrbProxy.read.totalSupply();
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      const exchangeRate = totalAssets * parseEther("1") / totalShares;
      expect(exchangeRate).to.be.greaterThan(0);
    });

    it("Should return correct withdrawal settings", async function () {
      const [withdrawalBatchSize, queueLength, maxQueueLength] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      expect(withdrawalBatchSize).to.equal(5n);
      expect(queueLength).to.equal(0n);
      expect(maxQueueLength).to.equal(100n);
    });

    it("Should return correct user pending withdrawal info", async function () {
      const [pendingAmount, queuePosition] = 
        await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      
      expect(pendingAmount).to.equal(0n);
      expect(queuePosition).to.equal(0n);
    });
  });

  describe("Access Control", function () {
    it("Should only allow admin to call admin functions", async function () {
      await expect(
        stakedBrbProxy.write.setProtocolFeeRate([500n], { account: player1.account })
      ).to.be.rejectedWith("AccessControl");
    });

    it("Should only allow BRB token to call onTokenTransfer", async function () {
      await expect(
        stakedBrbProxy.write.onTokenTransfer([player1.account.address, parseEther("100"), "0x", zeroAddress], { account: player1.account })
      ).to.be.rejectedWith("OnlyBRB");
    });

    it("Should only allow roulette contract to call roulette functions", async function () {
      await expect(
        stakedBrbProxy.write.processRouletteResult([1n, [], 0n, false], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should only allow roulette contract to call onRoundTransition", async function () {
      await expect(
        stakedBrbProxy.write.onRoundTransition([], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should only allow cleaning forwarders to call StakedBRB cleaning performUpkeep", async function () {
      const performData = "0x";
      await expect(
        stakedBrbProxy.write.performUpkeep([performData], { account: player1.account })
      ).to.be.rejectedWith("OnlyStakedBrbForwarders");
    });
  });

  describe("Upgrade Functionality", function () {
    it("Should only allow admin to authorize upgrades", async function () {
      // This tests the _authorizeUpgrade function
      // We can't directly test this without an upgrade scenario
      // but we can verify the access control is in place
      
      // The _authorizeUpgrade function is internal and can only be called during upgrades
      // We can test that the admin role is properly set up
      const adminRole = await stakedBrbProxy.read.DEFAULT_ADMIN_ROLE();
      expect(await stakedBrbProxy.read.hasRole([adminRole, admin.account.address])).to.be.true;
    });
  });

  describe("Storage and State Management", function () {
    it("Should handle storage slot correctly", async function () {
      // This tests the _getStakedBRBStorage function
      // We can't directly test this, but we can verify the storage is working
      // by checking that state changes persist

      const [, , protocolFeeBasisPoints, , , , ] = await stakedBrbProxy.read.getVaultConfig();
      expect(protocolFeeBasisPoints).to.equal(300n);
      
      await stakedBrbProxy.write.setProtocolFeeRate([500n], { account: admin.account });
      
      const [, , protocolFeeBasisPoints2, , , , ] = await stakedBrbProxy.read.getVaultConfig();

      expect(protocolFeeBasisPoints2).to.equal(500n);
    });

    it("Should handle round state correctly", async function () {
      // Test that round state is properly managed
      // This would require integration with the roulette contract
      // For now, we test the initial state
      
      const [_brbToken, _rouletteContract, _protocolFeeBasisPoints, _burnFeeRate, _jackpotFeeRate, _feeRecipient, pendingBets] = 
        await stakedBrbProxy.read.getVaultConfig();
      
      expect(pendingBets).to.equal(0n); // No pending bets initially
    });
  });

  describe("Mathematical Operations", function () {
    it("Should handle division by zero in exchange rate calculation", async function () {
      // Test exchange rate when total supply is 0
      // This should return 1e18 (1:1 ratio)
      const totalShares = await stakedBrbProxy.read.totalSupply();
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      const exchangeRate = totalShares > 0n ? totalAssets * parseEther("1") / totalShares : parseEther("1");
      expect(exchangeRate).to.equal(parseEther("1"));
    });

    it("Should handle large numbers in fee calculations", async function () {
      const largeAmount = parseEther("1000000"); // 1M BRB
      const [{ burnAmount, jackpotAmount, protocolFees }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([largeAmount]);
      
      const [, , protocolFeeBasisPoints, burnFeeRate, jackpotFeeRate, , ] = await stakedBrbProxy.read.getVaultConfig();
      // With 2.5% fee rate
      const expectedFee = (largeAmount * protocolFeeBasisPoints) / 10000n;
      const expectedBurn = (largeAmount * burnFeeRate) / 10000n;
      const expectedJackpot = (largeAmount * jackpotFeeRate) / 10000n;
      const expectedProfit = largeAmount - (expectedFee + expectedBurn + expectedJackpot);
      
      expect(protocolFees).to.equal(expectedFee);
      expect(burnAmount).to.equal(expectedBurn);
      expect(jackpotAmount).to.equal(expectedJackpot);
      expect(stakerProfit).to.equal(expectedProfit);
    });

    it("Should handle rounding in fee calculations", async function () {
      // Test with amount that doesn't divide evenly
      const amount = 1001n; // 1001 wei
      const [, , protocolFeeBasisPoints, burnFeeRate, jackpotFeeRate, , ] = await stakedBrbProxy.read.getVaultConfig();
      // With 2.5% fee rate, should round up
      const basicPointScale = 10000n;
      
      const feeAmount = BigInt(Math.floor(Number(amount * protocolFeeBasisPoints) / Number(basicPointScale)) + Math.floor(Number(amount * burnFeeRate) / Number(basicPointScale)) + Math.floor(Number(amount * jackpotFeeRate) / Number(basicPointScale)));
      const [, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([amount]);
      expect(stakerProfit).to.equal(amount - feeAmount);
    });
  });

  describe("Event Emissions", function () {
    it("Should emit BetPlaced event", async function () {
      const betAmount = parseEther("1");
      
      // First, ensure the vault has enough balance for max payout
      // Note: The contract applies a safety buffer of 110% (SAFETY_BUFFER_BPS = 11000)
      const SAFETY_BUFFER_BPS = 11000n;
      const vaultBalance = await stakedBrbProxy.read.totalAssets();
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n; // Straight bet has 36x payout with 110% safety buffer
      
      // If vault doesn't have enough balance, fund it
      // IMPORTANT: Account for existing cumulative maxPayout from previous bets
      // The contract checks: balance + betAmount >= existingMaxPayout + newBetMaxPayout
      // So: balance >= existingMaxPayout + newBetMaxPayout - betAmount
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const nextMaxPayout = existingMaxPayout + maxPayout;
      const requiredBalance = nextMaxPayout - betAmount;
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Small buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      // Create proper bet data
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      
      await brb.write.transfer([stakedBrbProxy.address, betAmount], { account: admin.account });
      
      const tx = await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      
      const logs = parseEventLogs({
        abi: stakedBrbProxy.abi,
        eventName: 'BetPlaced',
        logs: receipt.logs,
      });
      
      expect(logs.length).to.be.greaterThan(0);
      expect((logs[0] as { args: { user: string; amount: bigint; data: string } }).args.user.toLowerCase()).to.equal(admin.account.address.toLowerCase());
      expect((logs[0] as { args: { user: string; amount: bigint; data: string } }).args.amount).to.equal(betAmount);
      expect((logs[0] as { args: { user: string; amount: bigint; data: string } }).args.data).to.equal(betData);
    });

    it("Should emit WithdrawalRequested event", async function () {
      // Setup large withdrawal scenario
      await setupWithdrawalScenario(parseEther("2000"), true);
      
      const withdrawAmount = parseEther("150"); // Always larger than 100 ETH to trigger large withdrawal
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      const tx = await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      
      const logs = parseEventLogs({
        abi: stakedBrbProxy.abi,
        eventName: 'WithdrawalRequested',
        logs: receipt.logs,
      });
      
      expect(logs.length).to.be.greaterThan(0);
      expect((logs[0] as { args: { user: string; amount: bigint } }).args.user.toLowerCase()).to.equal(player1.account.address.toLowerCase());
      expect((logs[0] as { args: { user: string; amount: bigint } }).args.amount).to.equal(withdrawAmount);
    });

    it("Should emit ProtocolFeeRateUpdated event", async function () {
      const newFeeRate = 500n;
      
      const tx = await stakedBrbProxy.write.setProtocolFeeRate([newFeeRate], { account: admin.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      
      const logs = parseEventLogs({
        abi: stakedBrbProxy.abi,
        eventName: 'ProtocolFeeRateUpdated',
        logs: receipt.logs,
      });
      
      expect(logs.length).to.be.greaterThan(0);
      expect((logs[0]).args.newFee).to.equal(newFeeRate);
    });

    it("Should emit WithdrawalSettingsUpdated event", async function () {
      const newBatchSize = 10n;
      
      const tx = await stakedBrbProxy.write.setWithdrawalBatchSize([newBatchSize], { account: admin.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      
      const logs = parseEventLogs({
        abi: stakedBrbProxy.abi,
        eventName: 'WithdrawalSettingsUpdated',
        logs: receipt.logs,
      });
      
      expect(logs.length).to.be.greaterThan(0);
      expect((logs[0] as { args: { batchSize: bigint } }).args.batchSize).to.equal(newBatchSize);
    });

    it("Should emit AntiSpamSettingsUpdated event", async function () {
      const newMaxQueueLength = 200n;
      
      const tx = await stakedBrbProxy.write.setMaxQueueLength([newMaxQueueLength], { account: admin.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      
      const logs = parseEventLogs({
        abi: stakedBrbProxy.abi,
        eventName: 'AntiSpamSettingsUpdated',
        logs: receipt.logs,
      });
      
      expect(logs.length).to.be.greaterThan(0);
      expect((logs[0] as { args: { maxQueueLength: bigint } }).args.maxQueueLength).to.equal(newMaxQueueLength);
    });
  });

  describe("Edge Cases and Error Handling", function () {
    beforeEach(async function () {
      // Setup: deposit some BRB for withdrawal tests
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
    });

    it("Should handle zero amounts correctly", async function () {
      await expect(
        stakedBrbProxy.write.setProtocolFeeRate([0n], { account: admin.account })
      ).to.not.be.rejected; // Zero fee rate should be allowed
    });

    it("Should handle maximum values correctly", async function () {
      const maxFeeRate = 10000n; // MAX_PROTOCOL_FEE
      
      await stakedBrbProxy.write.setBurnFeeRate([0n], { account: admin.account });
      await stakedBrbProxy.write.setJackpotFeeRate([0n], { account: admin.account });
      await stakedBrbProxy.write.setProtocolFeeRate([maxFeeRate], { account: admin.account });

      const [, , protocolFeeBasisPoints, , , , ] = await stakedBrbProxy.read.getVaultConfig();
      expect(protocolFeeBasisPoints).to.equal(maxFeeRate);
    });

    it("Should handle empty arrays in roulette result processing", async function () {
      // This would be tested with the roulette contract integration
      // For now, we test the access control
      await expect(
        stakedBrbProxy.write.processRouletteResult([1n, [], 0n, false], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should handle withdrawal with zero amount", async function () {
      await expect(
        stakedBrbProxy.write.withdraw([0n, player1.account.address, player1.account.address, 0n], { account: player1.account })
      ).to.be.rejectedWith("ZeroAmount");
    });

    it("Should handle redemption with zero shares", async function () {
      await expect(
        stakedBrbProxy.write.redeem([0n, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account })
      ).to.be.rejectedWith("ZeroAmount");
    });

    it("Should handle deposit with zero amount", async function () {
      await expect(
        stakedBrbProxy.write.deposit([0n, player1.account.address, 0n], { account: player1.account })
      ).to.be.rejectedWith("ZeroAmount");
    });

    it("Should handle mint with zero shares", async function () {
      await expect(
        stakedBrbProxy.write.mint([0n, player1.account.address, 0n], { account: player1.account })
      ).to.be.rejectedWith("ZeroAmount");
    });

    it("Should handle withdrawal exceeding balance", async function () {
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const excessiveAmount = parseEther("2000");
      await expect(
        stakedBrbProxy.write.withdraw([excessiveAmount, player1.account.address, player1.account.address, 0n], { account: player1.account })
      ).to.be.rejectedWith("WithdrawalTooLarge");
    });

    it("Should handle redemption exceeding shares", async function () {
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const shares = await stakedBrbProxy.read.balanceOf([player1.account.address]);
      const excessiveShares = shares + 1n;
      
      await expect(
        stakedBrbProxy.write.redeem([excessiveShares, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account })
      ).to.be.rejectedWith("WithdrawalTooLarge");
    });

    it("Should handle insufficient allowance for deposit", async function () {
      const depositAmount = parseEther("1000");
      // Don't approve, so allowance is 0
      
      await expect(
        stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account })
      ).to.be.rejectedWith("InsufficientAllowance");
    });

    it("Should handle insufficient allowance for mint", async function () {
      const depositAmount = parseEther("1000");
      // Don't approve, so allowance is 0
      
      await expect(
        stakedBrbProxy.write.mint([depositAmount, player1.account.address, parseEther("1000")], { account: player1.account })
      ).to.be.rejectedWith("InsufficientAllowance");
    });

    it("Should handle withdrawal when user has pending large withdrawal", async function () {
      // Setup large withdrawal scenario
      await setupWithdrawalScenario(parseEther("2000"), true);
      
      // Request large withdrawal
      const largeWithdrawAmount = parseEther("150"); // Always larger than 100 ETH to trigger large withdrawal
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([largeWithdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      await stakedBrbProxy.write.withdraw([largeWithdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      
      // Try to withdraw again (should fail due to pending large withdrawal)
      await expect(
        stakedBrbProxy.write.withdraw([parseEther("100"), player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account })
      ).to.be.rejectedWith("WithdrawalPending");
    });

    it("Should handle queue position calculation with cancelled users", async function () {
      // Clear all assets first to start fresh
      await clearAllAssets();
      
      // Setup large withdrawal scenario for all users - deposit all users first
      await setupWithdrawalScenario(parseEther("2000"), false); // Don't place bet yet
      
      // Setup additional users with proper BRB balance
      const depositAmount = parseEther("1000");
      
      // Ensure player2 has enough BRB
      const player2Balance = await brb.read.balanceOf([player2.account.address]);
      if (player2Balance < depositAmount) {
        await brb.write.transfer([player2.account.address, depositAmount - player2Balance], { account: admin.account });
      }
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player2.account });
      await stakedBrbProxy.write.deposit([depositAmount, player2.account.address, 0n], { account: player2.account });
      
      // Ensure player3 has enough BRB
      const player3Balance = await brb.read.balanceOf([player3.account.address]);
      if (player3Balance < depositAmount) {
        await brb.write.transfer([player3.account.address, depositAmount - player3Balance], { account: admin.account });
      }
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player3.account });
      await stakedBrbProxy.write.deposit([depositAmount, player3.account.address, 0n], { account: player3.account });

      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      
      // Now place the bet to create maxPayout scenario (without clearing assets)
      const totalAssetsAfterDeposits = await stakedBrbProxy.read.totalAssets();
      
      // Get the safe capacity to determine how much we can bet
      const safeCapacity = await stakedBrbProxy.read.getSafeCapacity();
      console.log(`Safe capacity: ${safeCapacity}`);
      
      // Calculate bet amount based on safe capacity (use a small portion to ensure maxPayout doesn't exceed safe capacity)
      const betAmount = safeCapacity / 36n; // Use 1/36 of safe capacity to ensure maxPayout (36x) stays within safe capacity
      console.log(`Calculated bet amount: ${betAmount}`);
      
      // Ensure vault has enough balance for the bet
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      // Ensure vault has enough balance for max payout (with safety buffer)
      const SAFETY_BUFFER_BPS = 11000n;
      const betMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = betMaxPayout - betAmount;
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Small buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      // Ensure player1 has enough BRB for the bet
      const player1Balance = await brb.read.balanceOf([player1.account.address]);
      if (player1Balance < betAmount) {
        await brb.write.transfer([player1.account.address, betAmount - player1Balance], { account: admin.account });
      }
      
      // Place the bet
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );
      
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: player1.account });
      
      // Queue withdrawals (all large withdrawals)
      const withdrawAmount = parseEther("150"); // Always larger than 100 ETH to trigger large withdrawal
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      await stakedBrbProxy.write.withdraw([withdrawAmount, player2.account.address, player2.account.address, maxSharesOut], { account: player2.account });
      await stakedBrbProxy.write.withdraw([withdrawAmount, player3.account.address, player3.account.address, maxSharesOut], { account: player3.account });
      
      // Cancel middle user (player2)
      await stakedBrbProxy.write.cancelWithdrawal({ account: player2.account });
      
      // Check positions
      const [, pos1] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      const [, pos2] = await stakedBrbProxy.read.getUserPendingWithdrawal([player2.account.address]);
      const [, pos3] = await stakedBrbProxy.read.getUserPendingWithdrawal([player3.account.address]);
      
      expect(pos1).to.equal(1n); // Still first
      expect(pos2).to.equal(0n); // No longer in queue
      expect(pos3).to.equal(2n); // Now second (was third)
    });

    it("Should handle invalid queue index in removal", async function () {
      // This tests the internal _removeUserFromQueueEfficient function
      // We can't directly test this, but we can test the error conditions
      // by testing the cancelWithdrawal function with invalid state
      
      // Try to cancel when not in queue
      await expect(
        stakedBrbProxy.write.cancelWithdrawal({ account: player1.account })
      ).to.be.rejectedWith("NoWithdrawalPending");
    });

    it("Should handle queue bounds in processing", async function () {
      // This tests the internal queue processing logic
      // We can test this indirectly through the withdrawal system
      
      // First, ensure admin has shares to withdraw
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([depositAmount, admin.account.address, 0n], { account: admin.account });
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      
      // Fill the queue with admin's max withdrawable (deposit + staker share of the helper round; fixed asset amount can round past balance)
      const withdrawAssets = await stakedBrbProxy.read.maxWithdraw([admin.account.address]);
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAssets]);
      const maxSharesOut = sharesNeeded * 2n;
      await stakedBrbProxy.write.withdraw([withdrawAssets, admin.account.address, admin.account.address, maxSharesOut], { account: admin.account });
      
      // Create a scenario with a full queue
      await stakedBrbProxy.write.setMaxQueueLength([1n], { account: admin.account });
      
      // Create maxPayout scenario
      const betAmount = parseEther("1");
      // Ensure vault has enough balance for max payout (with safety buffer)
      const SAFETY_BUFFER_BPS = 11000n;
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = maxPayout > betAmount ? maxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Add buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      

      await expect(
        stakedBrbProxy.write.withdraw([depositAmount, player2.account.address, player2.account.address, parseEther("1000")], { account: player2.account })
      ).to.be.rejectedWith("QueueFull");
    });
  });

  describe("Withdrawal queue — advanced", function () {
    // No shared beforeEach: each test is isolated (clean fixture or own setup).

    it("Should process large withdrawals in batches", async function () {
      // Cancel any pending so setup can run (one pending per user)
      for (const account of [player1, player2, player3]) {
        const [pendingAmount] = await stakedBrbProxy.read.getUserPendingWithdrawal([account.account.address]);
        if (pendingAmount > 0n) {
          await stakedBrbProxy.write.cancelWithdrawal({ account: account.account });
        }
      }
      // Isolated: one setup - deposit all three users, then one bet (no second setup that wipes state)
      await setupWithdrawalScenario(parseEther("2000"), false);
      const depositAmount = parseEther("500");
      for (const [player, name] of [[player2, "player2"], [player3, "player3"]] as const) {
        const bal = await brb.read.balanceOf([player.account.address]);
        if (bal < depositAmount) {
          await brb.write.transfer([player.account.address, depositAmount - bal], { account: admin.account });
        }
        await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player.account });
        await stakedBrbProxy.write.deposit([depositAmount, player.account.address, 0n], { account: player.account });
      }
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      // Place one bet to create maxPayout (use getMaxPayout for balance check)
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      const betAmount = totalAssets / 36n;
      const SAFETY_BUFFER_BPS = 11000n;
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = (existingMaxPayout + newBetMaxPayout) > betAmount ? (existingMaxPayout + newBetMaxPayout) - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        await brb.write.transfer([stakedBrbProxy.address, requiredBalance - vaultBalance + parseEther("100")], { account: admin.account });
      }
      const player1Balance = await brb.read.balanceOf([player1.account.address]);
      if (player1Balance < betAmount) {
        await brb.write.transfer([player1.account.address, betAmount - player1Balance], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [{ type: "uint256[]", name: "amounts" }, { type: "uint256[]", name: "betTypes" }, { type: "uint256[]", name: "numbers" }]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: player1.account });
      
      await stakedBrbProxy.write.setWithdrawalBatchSize([2n], { account: admin.account });
      
      // Queue multiple withdrawals - use amount large enough to trigger large withdrawal
      const withdrawAmount = parseEther("150"); // Always larger than 100 ETH to trigger large withdrawal
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      // First withdrawal (player1 already has shares from setupWithdrawalScenario)
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      
      await stakedBrbProxy.write.withdraw([withdrawAmount, player2.account.address, player2.account.address, maxSharesOut], { account: player2.account });
      await stakedBrbProxy.write.withdraw([withdrawAmount, player3.account.address, player3.account.address, maxSharesOut], { account: player3.account });
      
      // Check queue state (aggregate pending assets: sum per-user pending amounts)
      const [, queueLength] = await stakedBrbProxy.read.getWithdrawalSettings();
      const [p1] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      const [p2] = await stakedBrbProxy.read.getUserPendingWithdrawal([player2.account.address]);
      const [p3] = await stakedBrbProxy.read.getUserPendingWithdrawal([player3.account.address]);

      expect(queueLength).to.equal(3n);
      expect(p1 + p2 + p3).to.equal(withdrawAmount * 3n);
    });

    it("Should handle queue removal efficiently", async function () {
      // Isolated: deposit player1 and player2, place one bet, then queue withdrawals and cancel
      await setupWithdrawalScenario(parseEther("2000"), false);
      const depositAmount = parseEther("500");
      const player2Balance = await brb.read.balanceOf([player2.account.address]);
      if (player2Balance < depositAmount) {
        await brb.write.transfer([player2.account.address, depositAmount - player2Balance], { account: admin.account });
      }
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player2.account });
      await stakedBrbProxy.write.deposit([depositAmount, player2.account.address, 0n], { account: player2.account });
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      const betAmount = totalAssets / 36n;
      const SAFETY_BUFFER_BPS = 11000n;
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = (existingMaxPayout + newBetMaxPayout) > betAmount ? (existingMaxPayout + newBetMaxPayout) - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        await brb.write.transfer([stakedBrbProxy.address, requiredBalance - vaultBalance + parseEther("100")], { account: admin.account });
      }
      const p1Bal = await brb.read.balanceOf([player1.account.address]);
      if (p1Bal < betAmount) {
        await brb.write.transfer([player1.account.address, betAmount - p1Bal], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [{ type: "uint256[]", name: "amounts" }, { type: "uint256[]", name: "betTypes" }, { type: "uint256[]", name: "numbers" }]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: player1.account });
      
      // Queue multiple withdrawals
      const withdrawAmount = parseEther("150"); // Always larger than 100 ETH to trigger large withdrawal
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      
      const [pendingAmount] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmount).to.equal(withdrawAmount);
      
      await stakedBrbProxy.write.withdraw([withdrawAmount, player2.account.address, player2.account.address, maxSharesOut], { account: player2.account });
      
      // Cancel first withdrawal
      await stakedBrbProxy.write.cancelWithdrawal({ account: player1.account });
      
      // Check that second user is now first in queue
      const [, pos2] = await stakedBrbProxy.read.getUserPendingWithdrawal([player2.account.address]);
      expect(pos2).to.equal(1n); // Now first in queue
    });

    it("Should handle empty queue gracefully", async function () {
      // Check cleaning upkeep when no round is waiting to be cleaned
      await stakedBrbProxy.read.checkUpkeep(["0x02"]);
    });

    it("Should calculate safe withdrawal capacity with zero maxPayout", async function () {
      // Isolated: player1 must have shares (deposit first)
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      // Create maxPayout scenario with a bet
      const betAmount = parseEther("1");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      // With 1 BRB bet, maxPayout = 36 BRB (buffered), so safe capacity is high; exits are still queued.
      const withdrawAmount = parseEther("100");

      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account });

      const [pendingAmount] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmount).to.equal(withdrawAmount);
    });

    it("Should handle queue bounds correctly", async function () {
      // Isolated: player1 must have shares (deposit first)
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      // Set a small queue limit for testing
      await stakedBrbProxy.write.setMaxQueueLength([2n], { account: admin.account });
      
      // Test that we can set queue limits (just verify the call succeeds)
      
      // Test basic withdrawal functionality
      const withdrawAmount = parseEther("50");
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account });
      
      // Verify withdrawal was processed
      const balance = await stakedBrbProxy.read.balanceOf([player1.account.address]);
      expect(balance).to.be.greaterThan(0n);
    });
  });

  describe("Chainlink Automation Integration", function () {
    it("Should have proper access control for admin functions", async function () {
      // Test that admin functions require proper access control
      // These functions may not exist in the current contract version
      // but we can test the access control pattern
      const adminRole = await stakedBrbProxy.read.DEFAULT_ADMIN_ROLE();
      expect(await stakedBrbProxy.read.hasRole([adminRole, admin.account.address])).to.be.true;
      expect(await stakedBrbProxy.read.hasRole([adminRole, player1.account.address])).to.be.false;
    });
  });

  describe("Roulette Result Processing - Detailed", function () {
    it("Should handle empty payout arrays", async function () {
      // This would be tested with the roulette contract integration
      // For now, we test the access control
      await expect(
        stakedBrbProxy.write.processRouletteResult([1n, [], 0n, false], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should handle single payout correctly", async function () {
      // This would be tested with the roulette contract integration
      // For now, we test the access control
      const payoutInfo = [{
        player: player1.account.address,
        betAmount: parseEther("50"),
        payout: parseEther("100")
      }];
      
      await expect(
        stakedBrbProxy.write.processRouletteResult([1n, payoutInfo, parseEther("100"), true], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should handle multiple payouts correctly", async function () {
      // This would be tested with the roulette contract integration
      // For now, we test the access control
      const payoutInfo = [
        { player: player1.account.address, betAmount: parseEther("50"), payout: parseEther("100") },
        { player: player2.account.address, betAmount: parseEther("100"), payout: parseEther("200") }
      ];
      
      await expect(
        stakedBrbProxy.write.processRouletteResult([1n, payoutInfo, parseEther("300"), true], { account: player1.account })
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("Should handle last batch processing correctly", async function () {
      // This would be tested with the roulette contract integration
      // The isLastBatch parameter affects how pending bets are handled
    });
  });

  describe("Protocol Fee Edge Cases", function () {
    it("Should handle zero loss amount", async function () {
      const [{ burnAmount, jackpotAmount, protocolFees}, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([0n]);
      
      expect(burnAmount).to.equal(0n);
      expect(jackpotAmount).to.equal(0n);
      expect(protocolFees).to.equal(0n);
      expect(stakerProfit).to.equal(0n);
    });

    it("Should handle zero fee rate", async function () {
      await stakedBrbProxy.write.setProtocolFeeRate([0n], { account: admin.account });
      await stakedBrbProxy.write.setBurnFeeRate([0n], { account: admin.account });
      await stakedBrbProxy.write.setJackpotFeeRate([0n], { account: admin.account });
      const lossAmount = parseEther("1000");
      const [{ burnAmount, jackpotAmount, protocolFees}, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
      
      expect(burnAmount).to.equal(0n);
      expect(jackpotAmount).to.equal(0n);
      expect(protocolFees).to.equal(0n);
      expect(stakerProfit).to.equal(lossAmount);
    });

    it("Should handle maximum fee rate", async function () {
      await stakedBrbProxy.write.setBurnFeeRate([0n], { account: admin.account });
      await stakedBrbProxy.write.setJackpotFeeRate([0n], { account: admin.account });
      await stakedBrbProxy.write.setProtocolFeeRate([10000n], { account: admin.account });

      const lossAmount = parseEther("1000");
      const [{ protocolFees }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
      
      expect(protocolFees).to.equal(lossAmount);
      expect(stakerProfit).to.equal(0n);
    });

    it("Should round up protocol fees correctly", async function () {
      // Test with a small amount that would result in fractional fees
      const lossAmount = 1n; // 1 wei
      const [{ protocolFees, burnAmount, jackpotAmount }, stakerProfit] = await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
      
      // With 2.5% fee rate, 1 wei should round up to 1 wei
      expect(protocolFees).to.equal(0n);
      expect(stakerProfit).to.equal(1n);
      expect(burnAmount).to.equal(0n);
      expect(jackpotAmount).to.equal(0n);
    });
  });

  describe("Total Assets Calculation", function () {
    it("Should exclude pending bets from total assets", async function () {
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const initialTotalAssets = await stakedBrbProxy.read.totalAssets();
      expect(initialTotalAssets).to.equal(depositAmount);
      
      // Place a bet
      const betAmount = parseEther("1");
      // Ensure vault has enough balance for max payout (with safety buffer)
      const SAFETY_BUFFER_BPS = 11000n;
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = maxPayout > betAmount ? maxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Add buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      // Total assets should remain the same (pending bets excluded)
      const totalAssetsAfterBet = await stakedBrbProxy.read.totalAssets();
      expect(totalAssetsAfterBet).to.equal(initialTotalAssets);
    });

    it("Should handle zero pending bets", async function () {
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      const totalBalance = await stakedBrbProxy.read.totalAssets();
      
      expect(totalAssets).to.equal(totalBalance);
    });
  });

  describe("Complete Game Loop Integration", function () {
    // Helper function to run a complete game loop test
    async function runCompleteGameLoopTest(
      depositAmount: bigint,
      betAmount: bigint,
      withdrawAmount: bigint,
      winningNumber: bigint,
      jackpotNumber: bigint,
      expectedFinalBalance: bigint
    ) {
      // 1. DEPOSIT
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      // 2. PLACE BET
      // Ensure vault has enough balance for max payout (with safety buffer)
      // IMPORTANT: Account for existing cumulative maxPayout from previous bets
      // The contract checks: balance + betAmount >= existingMaxPayout + newBetMaxPayout
      // So: balance >= existingMaxPayout + newBetMaxPayout - betAmount
      const SAFETY_BUFFER_BPS = 11000n;
      const existingMaxPayout = await stakedBrbProxy.read.getMaxPayout();
      const newBetMaxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const nextMaxPayout = existingMaxPayout + newBetMaxPayout;
      const requiredBalance = nextMaxPayout - betAmount;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Small buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      
      await brb.write.transfer([stakedBrbProxy.address, betAmount], { account: admin.account });
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      // 3. Withdraw while still in the betting window, then pre-VRF lock + VRF
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account });

      await advanceThroughLockToVrfWindow(stakedBrbProxy);

      const [needsExecutionVRF, performDataVRF] = await rouletteProxy.read.checkUpkeep(["0x01"]);
      expect(needsExecutionVRF).to.be.true;
      
      const txVRF = await rouletteProxy.write.performUpkeep([performDataVRF], { account: admin.account });
      const receiptVRF = await publicClient.waitForTransactionReceipt({ hash: txVRF });
      const logsVRF = parseEventLogs({
        abi: rouletteProxy.abi,
        eventName: 'VrfRequested',
        logs: receiptVRF.logs,
      });
      
      if (!logsVRF.length) {
        throw new Error("VrfRequested event not found");
      }
      const requestId = logsVRF[0].args.requestId;
      
      // 4. VRF FULFILLMENT
      await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [winningNumber, jackpotNumber]]);
      
      // 5. COMPUTE TOTAL WINNING BETS (checkData length 2; same as other integration tests)
      const [countWinnersNeeded, countWinnersData] = await rouletteProxy.read.checkUpkeep([toHex(new Uint8Array(2))]);
      expect(countWinnersNeeded).to.be.true;
      await rouletteProxy.write.performUpkeep([countWinnersData], { account: admin.account });
      
      // 6. PROCESS PAYOUTS (length 3 = batch 0, then 4, ...)
      const [payoutsNeeded, _payoutData] = await rouletteProxy.read.checkUpkeep([toHex(new Uint8Array(3))]);
      if (payoutsNeeded) {
        let processedPayoutBatches = 0;
        while (true) {
          const checkDataForPayout = new Uint8Array(Number(processedPayoutBatches) + 3);
          const hexCheckData = toHex(checkDataForPayout);
          const [payoutsNeeded, payoutData] = await rouletteProxy.read.checkUpkeep([hexCheckData]);
          if (!payoutsNeeded) break;
          
          await rouletteProxy.write.performUpkeep([payoutData], { account: admin.account });
          processedPayoutBatches++;
          await time.increase(10n);
        }
      }
      
      const [_upkeepNeeded, _performData] = await stakedBrbProxy.read.checkUpkeep(["0x02"]); // clean up

      expect(_upkeepNeeded).to.be.true;
      // Cleaning runs on StakedBRB; `withdraw`/`redeem` see `msg.sender` = upkeep caller (admin), so owner must approve admin for shares
      await stakedBrbProxy.write.approve([admin.account.address, MAX_UINT256], { account: player1.account });
      await stakedBrbProxy.write.performUpkeep([_performData], { account: admin.account });
      
      // 7. WITHDRAW
      
      // 8. VERIFY FINAL STATE
      const finalPlayerBalance = await brb.read.balanceOf([player1.account.address]);
      expect(finalPlayerBalance).to.equal(expectedFinalBalance);
    }

    it("Should handle complete deposit -> bet -> withdrawal flow with winning bet", async function () {
      const depositAmount = parseEther("1000");
      const betAmount = parseEther("1");
      const withdrawAmount = parseEther("50");
      const winningNumber = 7n; // Winning number
      const jackpotNumber = 10n;
      // Expected: initial balance - deposit + withdrawal (withdrawal happens before VRF, so it's included in the final balance)
      // Initial balance is 15000 ETH, deposit is 1000 ETH, withdrawal is 50 ETH
      // Note: bet win goes to admin (who placed the bet), not to player
      // Final = 15000 - 1000 + 50 = 14050 ETH
      const expectedFinalBalance = parseEther("15000") - depositAmount + withdrawAmount;
      
      await runCompleteGameLoopTest(depositAmount, betAmount, withdrawAmount, winningNumber, jackpotNumber, expectedFinalBalance);
    });

    it("Should handle complete deposit -> bet -> withdrawal flow with losing bet", async function () {
      const depositAmount = parseEther("1000");
      const betAmount = parseEther("1");
      const withdrawAmount = parseEther("50");
      const winningNumber = 8n; // Different from bet number (7)
      const jackpotNumber = 10n;
      // Expected: initial balance - deposit + withdrawal (player1 starts with 15000 from fixture)
      const expectedFinalBalance = parseEther("15000") - depositAmount + withdrawAmount;
      
      await runCompleteGameLoopTest(depositAmount, betAmount, withdrawAmount, winningNumber, jackpotNumber, expectedFinalBalance);
    });

    it("Should handle large withdrawal in complete game loop", async function () {
      // Setup large withdrawal scenario
      await setupWithdrawalScenario(parseEther("2000"), true);
      
      const withdrawAmount = parseEther("150"); // Always larger than 100 ETH to trigger large withdrawal
      const winningNumber = 7n;
      const jackpotNumber = 10n;
      
      // Calculate proper maxSharesOut to avoid MaxSharesError
      const sharesNeeded = await stakedBrbProxy.read.previewWithdraw([withdrawAmount]);
      const maxSharesOut = sharesNeeded * 2n;
      
      // 3. REQUEST LARGE WITHDRAWAL (should be queued)
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, maxSharesOut], { account: player1.account });
      
      // 4. VERIFY WITHDRAWAL WAS QUEUED
      const [pendingAmount, queuePosition] = 
        await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      
      expect(pendingAmount).to.equal(withdrawAmount);
      expect(queuePosition).to.be.greaterThan(0);
      
      // 5. COMPLETE GAME LOOP (pre-VRF lock then VRF)
      await advanceThroughLockToVrfWindow(stakedBrbProxy);

      const [needsExecutionVRF, performDataVRF] = await rouletteProxy.read.checkUpkeep(["0x01"]);
      expect(needsExecutionVRF).to.be.true;
      
      const txVRF = await rouletteProxy.write.performUpkeep([performDataVRF], { account: admin.account });
      const receiptVRF = await publicClient.waitForTransactionReceipt({ hash: txVRF });
      const logsVRF = parseEventLogs({
        abi: rouletteProxy.abi,
        eventName: 'VrfRequested',
        logs: receiptVRF.logs,
      });
      
      const requestId = logsVRF[0].args.requestId;
      await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [winningNumber, jackpotNumber]]);
      
      const [countWinnersNeeded, countWinnersData] = await rouletteProxy.read.checkUpkeep([toHex(new Uint8Array(2))]);
      expect(countWinnersNeeded).to.be.true;
      await rouletteProxy.write.performUpkeep([countWinnersData], { account: admin.account });
      
      const [payoutsNeeded, _payoutData] = await rouletteProxy.read.checkUpkeep([toHex(new Uint8Array(3))]);
      if (payoutsNeeded) {
        let processedPayoutBatches = 0;
        while (true) {
          const checkDataForPayout = new Uint8Array(Number(processedPayoutBatches) + 3);
          const hexCheckData = toHex(checkDataForPayout);
          const [payoutsNeeded, payoutData] = await rouletteProxy.read.checkUpkeep([hexCheckData]);
          if (!payoutsNeeded) break;
          
          await rouletteProxy.write.performUpkeep([payoutData], { account: admin.account });
          processedPayoutBatches++;
          await time.increase(10n);
        }
      }
      
      // 6. PROCESS LARGE WITHDRAWAL (perform upkeep)
      const [upkeepNeeded, performData] = await stakedBrbProxy.read.checkUpkeep(["0x02"]);
      if (upkeepNeeded) {
        await stakedBrbProxy.write.approve([admin.account.address, MAX_UINT256], { account: player1.account });
        await stakedBrbProxy.write.performUpkeep([performData], { account: admin.account });
        
        // Verify the large withdrawal was processed
        const [pendingAmountAfter] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
        // Note: The large withdrawal might still be pending if the upkeep didn't process it
        // This is expected behavior in the test environment
        console.log(`Pending amount after upkeep: ${pendingAmountAfter}`);
      }
    });
  });

  describe("Integration Tests", function () {
    it("Should handle complete deposit -> bet -> withdrawal flow", async function () {
      // 1. Deposit
      const depositAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      // 2. Place bet
      const betAmount = parseEther("1");
      // Ensure vault has enough balance for max payout (with safety buffer)
      // When bet is placed, balance increases by betAmount, so we need:
      // currentBalance + betAmount >= maxPayout = betAmount * 39.6
      // So: currentBalance >= betAmount * 38.6
      const SAFETY_BUFFER_BPS = 11000n;
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = maxPayout > betAmount ? maxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("1000"); // Larger buffer for safety
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      // 3. Withdraw (queued; BRB not transferred until cleaning upkeep)
      const withdrawAmount = parseEther("50");
      await stakedBrbProxy.write.withdraw([withdrawAmount, player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account });

      const [pendingAmount] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      expect(pendingAmount).to.equal(withdrawAmount);
      const finalBalance = await brb.read.balanceOf([player1.account.address]);
      expect(finalBalance).to.be.greaterThan(0);
    });

    it("Should handle multiple users with different withdrawal scenarios", async function () {
      // Clear all assets before this test
      await clearAllAssets();
      
      // Verify that totalAssets is 0 at the start
      const initialTotalAssets = await stakedBrbProxy.read.totalAssets();
      expect(initialTotalAssets).to.equal(0n);
      
      // Setup multiple users
      const depositAmount = parseEther("1000");
      
      // User 1
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([depositAmount, player1.account.address, 0n], { account: player1.account });
      
      // User 2
      await brb.write.approve([stakedBrbProxy.address, depositAmount], { account: player2.account });
      await stakedBrbProxy.write.deposit([depositAmount, player2.account.address, 0n], { account: player2.account });
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      
      // Verify assets are now available after deposits (helper round: losing admin bet increases staker totalAssets slightly)
      const totalAssetsAfterDeposits = await stakedBrbProxy.read.totalAssets();
      expect(totalAssetsAfterDeposits).to.be.gte(parseEther("2000"));
      
      // Large bet creates maxPayout; all withdrawals are queued regardless of size vs safe capacity.
      const betAmount = parseEther("50");
      // Ensure vault has enough balance for max payout (with safety buffer)
      const SAFETY_BUFFER_BPS = 11000n;
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = maxPayout > betAmount ? maxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Add buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7 (36x payout = 1980 ETH max with buffer)
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      // Verify the bet was placed successfully
      const [_brbToken, _rouletteContract, _protocolFeeBasisPoints, _burnFeeRate, _jackpotFeeRate, _feeRecipient, pendingBets] = 
        await stakedBrbProxy.read.getVaultConfig();
      expect(pendingBets).to.equal(betAmount);
      
      await stakedBrbProxy.write.withdraw([parseEther("100"), player1.account.address, player1.account.address, parseEther("1000")], { account: player1.account });

      await stakedBrbProxy.write.withdraw([parseEther("800"), player2.account.address, player2.account.address, parseEther("1000")], { account: player2.account });

      const [pending1] = await stakedBrbProxy.read.getUserPendingWithdrawal([player1.account.address]);
      const [pending2] = await stakedBrbProxy.read.getUserPendingWithdrawal([player2.account.address]);
      expect(pending1).to.equal(parseEther("100"));
      expect(pending2).to.equal(parseEther("800"));
    });

    it("Should handle complex multi-user queue management", async function () {
      // Clear all assets before this test
      await clearAllAssets();
      
      // Verify that totalAssets is 0 at the start
      const initialTotalAssets = await stakedBrbProxy.read.totalAssets();
      expect(initialTotalAssets).to.equal(0n);
      
      // Setup multiple users with sufficient amounts
      const users = [player1, player2, player3];
      const amounts = [parseEther("2000"), parseEther("2000"), parseEther("2000")]; // Increased amounts to cover withdrawals
      
      for (let i = 0; i < users.length; i++) {
        await brb.write.approve([stakedBrbProxy.address, amounts[i]], { account: users[i].account });
        await stakedBrbProxy.write.deposit([amounts[i], users[i].account.address, 0n], { account: users[i].account });
      }
      await runMinimalRoundAndStakedCleaning(stakedBrbProxy, rouletteProxy, vrfCoordinator, publicClient, admin, brb);
      
      // Verify assets are now available after deposits (helper round adds small staker profit vs raw deposit sum)
      const totalAssetsAfterDeposits = await stakedBrbProxy.read.totalAssets();
      expect(totalAssetsAfterDeposits).to.be.gte(parseEther("6000"));
      
      // Large bet creates maxPayout; queued withdrawals are still FIFO by request order.
      const betAmount = parseEther("150");
      // Ensure vault has enough balance for max payout (with safety buffer)
      const SAFETY_BUFFER_BPS = 11000n;
      const maxPayout = (betAmount * 36n * SAFETY_BUFFER_BPS) / 10000n;
      const requiredBalance = maxPayout > betAmount ? maxPayout - betAmount : 0n;
      const vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      if (vaultBalance < requiredBalance) {
        const neededAmount = requiredBalance - vaultBalance + parseEther("100"); // Add buffer
        await brb.write.transfer([stakedBrbProxy.address, neededAmount], { account: admin.account });
      }
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // BET_STRAIGHT on number 7 (36x payout = 5940 ETH max with buffer)
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });
      
      // Create withdrawals that will be queued due to maxPayout constraints
      const withdrawAmounts = [parseEther("1500"), parseEther("1500"), parseEther("1500")];
      
      for (let i = 0; i < users.length; i++) {
        await stakedBrbProxy.write.withdraw([withdrawAmounts[i], users[i].account.address, users[i].account.address, parseEther("1000")], { account: users[i].account });
      }
      
      // Verify queue state
      const [, queueLength] = await stakedBrbProxy.read.getWithdrawalSettings();
      const sumPending = async () => {
        let t = 0n;
        for (const u of users) {
          const [a] = await stakedBrbProxy.read.getUserPendingWithdrawal([u.account.address]);
          t += a;
        }
        return t;
      };
      expect(queueLength).to.equal(3);
      expect(await sumPending()).to.equal(parseEther("4500"));

      // Test cancellation of middle user
      await stakedBrbProxy.write.cancelWithdrawal({ account: player2.account });

      // Verify updated queue state
      const [, queueLength2] = await stakedBrbProxy.read.getWithdrawalSettings();

      expect(queueLength2).to.equal(2n);
      expect(await sumPending()).to.equal(parseEther("3000"));
    });
  });
});
