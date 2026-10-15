import { readFileSync } from "node:fs";
import { join } from "node:path";

import hre from "hardhat";
import { viem } from "hardhat";

import { expect } from "chai";
import { getAddress, keccak256 } from "viem";

import { deployUniswapV2Local } from "../scripts/utils/deployUniswapV2Local";
import {
    UNISWAP_V2_CANONICAL_PAIR_INIT_CODE_HASH,
    uniswapV2PairAddress,
    uniswapV2PairAddressVendored,
} from "./helpers/uniswapV2PairAddress";
import { vendoredUniswapV2PairInitCodeHash } from "./helpers/vendoredUniswapV2PairInitCodeHash";

describe("UniswapV2TwapLib", function () {
    it("uses canonical pair init code hash for production Uniswap V2", async function () {
        const harness = await viem.deployContract("UniswapV2TwapLibHarness");
        const [deployer] = await viem.getWalletClients();
        const { factory } = await deployUniswapV2Local(deployer);
        const tokenA = await viem.deployContract("MockUSDC");
        const tokenB = await viem.deployContract("MockUSDC");

        const canonicalPredicted = await harness.read.pairFor([factory, tokenA.address, tokenB.address]);
        const vendoredPredicted = await uniswapV2PairAddressVendored(factory, tokenA.address, tokenB.address);

        expect(canonicalPredicted).not.to.equal(vendoredPredicted);
    });

    it("vendored Sepolia factory: init code hash matches compiled UniswapV2Pair", async function () {
        const artifact = await hre.artifacts.readArtifact(
            "contracts/vendor/uniswap-v2-core/UniswapV2Pair.sol:UniswapV2Pair",
        );
        const fromArtifact = keccak256(artifact.bytecode as `0x${string}`);
        const fromHelper = await vendoredUniswapV2PairInitCodeHash();

        expect(fromHelper).to.equal(fromArtifact);
        expect(fromArtifact).not.to.equal(UNISWAP_V2_CANONICAL_PAIR_INIT_CODE_HASH);
    });

    it("vendored Sepolia factory: UniswapV2Library init code hash matches compiled pair", async function () {
        const initCodeHash = await vendoredUniswapV2PairInitCodeHash();
        const librarySource = readFileSync(
            join(__dirname, "../contracts/vendor/uniswap-v2-periphery/libraries/UniswapV2Library.sol"),
            "utf8",
        );
        expect(librarySource.toLowerCase()).to.include(initCodeHash.slice(2).toLowerCase());
    });

    it("vendored Sepolia factory: pair address helper matches createPair", async function () {
        const [deployer] = await viem.getWalletClients();
        const { factory } = await deployUniswapV2Local(deployer);
        const tokenA = await viem.deployContract("MockUSDC");
        const tokenB = await viem.deployContract("MockUSDC");
        const factoryContract = await viem.getContractAt("UniswapV2Factory", factory);
        const initCodeHash = await vendoredUniswapV2PairInitCodeHash();

        const predictedAB = uniswapV2PairAddress(factory, tokenA.address, tokenB.address, initCodeHash);
        const predictedBA = uniswapV2PairAddress(factory, tokenB.address, tokenA.address, initCodeHash);
        expect(getAddress(predictedAB)).to.equal(getAddress(predictedBA));

        await factoryContract.write.createPair([tokenA.address, tokenB.address]);
        const pairFromFactory = await factoryContract.read.getPair([tokenA.address, tokenB.address]);
        expect(getAddress(pairFromFactory)).to.equal(getAddress(predictedAB));
    });
});
