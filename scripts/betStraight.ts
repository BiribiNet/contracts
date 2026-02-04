import { viem } from "hardhat";

import { encodeAbiParameters, parseEther, parseSignature, zeroAddress, type WalletClient } from "viem";

const main = async () => {
    const brb = await viem.getContractAt("BRB", "0x653cb144e4e3507755a722d9b8e4ff7354762e86");
    const stakedBrbProxy = await viem.getContractAt("StakedBRB", "0x2C163D1de7ED3E5cF8AdFdF56C59b6Ac299fE0eA");
    const [player1] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
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
    const depositAmount = parseEther("100"); // Above minimum
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      
      // Create permit signature
      const { r, s, v } = await createPermitSignature(
        player1,
        stakedBrbProxy.address,
        depositAmount,
        deadline
      );

    const depositTx = await stakedBrbProxy.write.depositWithPermit([
        depositAmount,
        player1.account.address,
        0n,
        deadline,
        Number(v),
        r,
        s
      ], { account: player1.account });


    await publicClient.waitForTransactionReceipt({ hash: depositTx, confirmations: 10 });
    const betAmount = parseEther("0.0001");
    const totalBetAmount = betAmount * 37n;

    const emptyArray = Array(37).fill(0n);

    const amounts = emptyArray.map(() => betAmount);
    const betTypes = emptyArray.map(() => 1n);
    const numbers = emptyArray.map((_, index) => BigInt(index));

    const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts, betTypes, numbers }] // amounts, betTypes (1=straight), numbers
      );
    const tx = await brb.write.bet([stakedBrbProxy.address, totalBetAmount, betData, zeroAddress]);
    console.log(tx);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});