import { viem } from "hardhat";
import { getAddress, parseAbi, parseUnits } from "viem";

/** Quick read-only checks after deploy on a live/fork RPC. */
async function main() {
    const publicClient = await viem.getPublicClient();

    const factory = process.env.VERIFY_FACTORY as `0x${string}`;
    const router = process.env.VERIFY_ROUTER as `0x${string}`;
    const usdc = process.env.VERIFY_USDC as `0x${string}`;
    const dai = process.env.VERIFY_DAI as `0x${string}`;
    const brb = process.env.VERIFY_BRB as `0x${string}`;
    const funder = process.env.VERIFY_FUNDER as `0x${string}`;
    const registry = process.env.VERIFY_REGISTRY as `0x${string}`;
    const engine = process.env.VERIFY_ENGINE as `0x${string}`;

    for (const [name, addr] of Object.entries({ factory, router, usdc, dai, brb, funder, registry, engine })) {
        if (!addr) throw new Error(`Missing VERIFY_${name.toUpperCase()}`);
    }

    const factoryAbi = parseAbi(["function getPair(address, address) view returns (address)"]);
    const pairAbi = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
    const routerAbi = parseAbi([
        "function factory() view returns (address)",
        "function getAmountsOut(uint256, address[]) view returns (uint256[])",
    ]);
    const registryAbi = parseAbi(["function marketCount() view returns (uint256)"]);
    const funderAbi = parseAbi(["function router() view returns (address)", "function brbToken() view returns (address)"]);

    const [usdcPair, daiPair, marketCount, routerFactory, amountsOut, funderRouter, funderBrb] = await Promise.all([
        publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [usdc, brb] }),
        publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [dai, brb] }),
        publicClient.readContract({ address: registry, abi: registryAbi, functionName: "marketCount" }),
        publicClient.readContract({ address: router, abi: routerAbi, functionName: "factory" }),
        publicClient.readContract({
            address: router,
            abi: routerAbi,
            functionName: "getAmountsOut",
            args: [parseUnits("1", 6), [usdc, brb]],
        }),
        publicClient.readContract({ address: funder, abi: funderAbi, functionName: "router" }),
        publicClient.readContract({ address: funder, abi: funderAbi, functionName: "brbToken" }),
    ]);

    if (usdcPair === "0x0000000000000000000000000000000000000000") throw new Error("USDC/BRB pair missing");
    if (daiPair === "0x0000000000000000000000000000000000000000") throw new Error("DAI/BRB pair missing");
    if (marketCount < 3n) throw new Error(`Expected >= 3 markets, got ${marketCount}`);
    if (getAddress(routerFactory) !== getAddress(factory)) throw new Error("Router factory mismatch");
    if (getAddress(funderRouter) !== getAddress(router)) throw new Error("Funder router mismatch");
    if (getAddress(funderBrb) !== getAddress(brb)) throw new Error("Funder BRB mismatch");
    if (amountsOut[1] === 0n) throw new Error("Router getAmountsOut returned 0 BRB for 1 USDC");

    const [usdcRes, daiRes] = await Promise.all([
        publicClient.readContract({ address: usdcPair, abi: pairAbi, functionName: "getReserves" }),
        publicClient.readContract({ address: daiPair, abi: pairAbi, functionName: "getReserves" }),
    ]);
    if (usdcRes[0] === 0n || usdcRes[1] === 0n) throw new Error("USDC/BRB pool has zero reserves");
    if (daiRes[0] === 0n || daiRes[1] === 0n) throw new Error("DAI/BRB pool has zero reserves");

    const engineCode = await publicClient.getBytecode({ address: engine });
    if (!engineCode || engineCode === "0x") throw new Error("Engine has no bytecode");

    console.log("Fork deployment checks passed");
    console.log(
        JSON.stringify(
            {
                marketCount: marketCount.toString(),
                usdcPair: getAddress(usdcPair),
                daiPair: getAddress(daiPair),
                usdcReserves: usdcRes.map(String),
                daiReserves: daiRes.map(String),
                oneUsdcToBrb: amountsOut[1].toString(),
            },
            null,
            2,
        ),
    );
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
