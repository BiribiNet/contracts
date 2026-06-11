import hre from "hardhat";
import { viem } from "hardhat";

import { expect } from "chai";
import { getAddress, keccak256 } from "viem";

import { deployUniswapV2Local } from "../scripts/utils/deployUniswapV2Local";
import {
    UNISWAP_V2_CANONICAL_PAIR_INIT_CODE_HASH,
    UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH,
    uniswapV2PairAddress,
} from "./helpers/uniswapV2PairAddress";

describe("UniswapV2TwapLib", function () {
    it("uses canonical pair init code hash for production Uniswap V2", async function () {
        const harness = await viem.deployContract("UniswapV2TwapLibHarness");
        const [deployer] = await viem.getWalletClients();
        const { factory } = await deployUniswapV2Local(deployer);
        const tokenA = await viem.deployContract("MockUSDC");
        const tokenB = await viem.deployContract("MockUSDC");

        const canonicalPredicted = await harness.read.pairFor([factory, tokenA.address, tokenB.address]);
        const vendoredPredicted = uniswapV2PairAddress(factory, tokenA.address, tokenB.address);

        expect(canonicalPredicted).not.to.equal(vendoredPredicted);
    });

    it("vendored Sepolia factory: init code hash matches compiled UniswapV2Pair", async function () {
        const artifact = await hre.artifacts.readArtifact(
            "contracts/vendor/uniswap-v2-core/UniswapV2Pair.sol:UniswapV2Pair",
        );
        const initCodeHash = keccak256(artifact.bytecode as `0x${string}`);
        expect(initCodeHash).to.equal(UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH);
        expect(initCodeHash).not.to.equal(UNISWAP_V2_CANONICAL_PAIR_INIT_CODE_HASH);
    });

    it("vendored Sepolia factory: pair address helper matches createPair", async function () {
        const [deployer] = await viem.getWalletClients();
        const { factory } = await deployUniswapV2Local(deployer);
        const tokenA = await viem.deployContract("MockUSDC");
        const tokenB = await viem.deployContract("MockUSDC");
        const factoryContract = await viem.getContractAt("UniswapV2Factory", factory);

        const predictedAB = uniswapV2PairAddress(factory, tokenA.address, tokenB.address);
        const predictedBA = uniswapV2PairAddress(factory, tokenB.address, tokenA.address);
        expect(getAddress(predictedAB)).to.equal(getAddress(predictedBA));

        await factoryContract.write.createPair([tokenA.address, tokenB.address]);
        const pairFromFactory = await factoryContract.read.getPair([tokenA.address, tokenB.address]);
        expect(getAddress(pairFromFactory)).to.equal(getAddress(predictedAB));
    });
});
