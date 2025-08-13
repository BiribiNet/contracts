import hre, { ethers } from "hardhat";

import { config } from 'dotenv';
import { AbiCoder, WebSocketProvider, hashMessage } from "ethers";

import create2Abi, { type DeployConfig } from "./utils/deployUtils";
import { waitForTransaction } from "./utils/waitForTransaction";

config();

async function main() {
    const implementationAddress = "0xb18f11cdf15f8c302cb1505777e6ebcb20748c2a";

    // Vérification des variables d'environnement requises
    const requiredEnvVars = ['CREATE2_ADDRESS', 'SALT_IMPL', 'SALT_PROXY', 'CURRENCY'] as const;
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`La variable d'environnement ${envVar} est requise`);
      }
    }

  const config: DeployConfig = {
    proxyAddress: process.env.PROXY_ADDRESS!,
    CREATE2_ADDRESS: process.env.CREATE2_ADDRESS!,
    CURRENCY: process.env.CURRENCY!,
    SALT_IMPL: `${process.env.SALT_IMPL! ?? 'RE'}${process.env.CURRENCY!}`,
    SALT_PROXY: `${process.env.SALT_PROXY! ?? 'RE'}${process.env.CURRENCY!}`,
    upgradeOnly: false,
    SALT_IMPL_V2: process.env.SALT_IMPL_V2 ?? "",
  };

  const provider = new WebSocketProvider(
    'ws://127.0.0.1:1248', // RPC FRAME
    {
      chainId: hre.network.config.chainId ?? 5,
      name: hre.network.name,
    },
  );

  const signer = await provider.getSigner();
  const signerAddress = await signer.getAddress();

  const ReusdFactory = await ethers.getContractFactory("REUSD");

  const factory = new ethers.Contract(implementationAddress, ReusdFactory.interface);
  const initializeData = factory.interface.encodeFunctionData("initialize", [
    signerAddress,
    config.CURRENCY
  ]);

  const create2Contract = new ethers.Contract(
    config.CREATE2_ADDRESS,
    create2Abi,
  );
  
    // Get proxy bytecode
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxyBytecode = ERC1967Proxy.bytecode;

  console.log("Deploying proxy...");
  const proxyTx = await signer.sendTransaction({
    data: create2Contract.interface.encodeFunctionData('deploy', [
      0, // value
      hashMessage(config.SALT_PROXY), // salt
      proxyBytecode + AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes"],
        [implementationAddress, "0x"]
      ).slice(2),
      initializeData
    ]),
    to: config.CREATE2_ADDRESS
  });
  
  const proxyReceipt = await waitForTransaction(signer.provider, proxyTx)
  
  if (proxyReceipt && proxyReceipt.logs && proxyReceipt.logs.length > 0) {
    const proxyDeployedLog = proxyReceipt.logs.find((val) => val.topics[0] === "0x9f9c566772ebd31147263ece7c6da0220df641c474d0fb11b7691471022ca1f9") // Deployed topic0
    if (!proxyDeployedLog) throw new Error("Deployed event not found");
    
    const proxyDeployedEvent = create2Contract.interface.parseLog(proxyDeployedLog);
    if (!proxyDeployedEvent) throw new Error("proxyDeployedEvent not found");
    
    const proxyAddress = proxyDeployedEvent.args[0];
    console.log("Proxy deployed at:", proxyAddress);
    return { proxyAddress, implementation: implementationAddress };
  }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  