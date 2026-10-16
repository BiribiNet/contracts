import { viem } from "hardhat";
import { parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import { USDC, DAI, MIN_BET_USDC, MIN_BET_DAI } from "../constants/arbitrumOne";

/** Adds USDC then DAI to the existing BRB-first registry. Creates vaults without moving any tokens. */
export async function deployStablecoinMarkets(params: {
    wallet: WalletClient; client: PublicClient; registry: Address; engine: Address; sideBet: Address;
    beacon: Address; brb: Address; admin: Address;
    waitWrite: (hash: Promise<`0x${string}`>) => Promise<void>;
}) {
    const account = params.wallet.account;
    if (!account || account.address.toLowerCase() !== params.admin.toLowerCase()) throw new Error("Expected protocol administrator signer");
    const registry = await viem.getContractAt("MarketRegistry", params.registry);
    const brbMarket = await registry.read.getMarket([1]);
    if (await registry.read.marketCount() !== 1 || brbMarket.asset.toLowerCase() !== params.brb.toLowerCase()) throw new Error("Expected only existing BRB market 1; inspect state before recovery");
    if (!await registry.read.hasRole([await registry.read.MARKET_FACTORY_ROLE(), account.address])) throw new Error("Signer lacks market factory role");
    for (const [actual, expected] of [[await registry.read.ENGINE(), params.engine], [await registry.read.SIDE_BET(), params.sideBet], [await registry.read.vaultBeacon(), params.beacon]]) {
        if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error("Existing registry wiring mismatch");
    }
    const tokenAbi = parseAbi(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]);
    const readBalances = () => Promise.all([USDC, DAI, params.brb].map(address => params.client.readContract({ address, abi: tokenAbi, functionName: "balanceOf", args: [account.address] })));
    const before = await readBalances();
    const brbBank = await viem.getContractAt("BankVault4626", brbMarket.bank);
    const brbAssetsBefore = await brbBank.read.totalAssets();
    for (const [asset, decimals] of [[USDC, 6], [DAI, 18]] as const) {
        if (await registry.read.assetToMarket([asset]) !== 0 || await params.client.readContract({ address: asset, abi: tokenAbi, functionName: "decimals" }) !== decimals) throw new Error("Stablecoin already registered or unexpected token decimals");
    }
    const markets: Record<string, { marketId: number; asset: Address; bank: Address; minBet: string; creationHash: `0x${string}` }> = {};
    for (const [name, marketId, asset, minBet] of [["usdc", 2, USDC, MIN_BET_USDC], ["dai", 3, DAI, MIN_BET_DAI]] as const) {
        if (await registry.read.previewNextMarketId() !== marketId) throw new Error("Market order changed before broadcast");
        const args = [{ asset, bankAdmin: params.admin, minBet }] as const;
        const hash = await params.wallet.writeContract({ account, chain: params.client.chain, address: params.registry,
            abi: registry.abi, functionName: "createMarket", args,
            gas: await params.client.estimateContractGas({ account, address: params.registry, abi: registry.abi, functionName: "createMarket", args }) });
        await params.waitWrite(Promise.resolve(hash));
        const market = await registry.read.getMarket([marketId]);
        const bank = await viem.getContractAt("BankVault4626", market.bank);
        const code = await params.client.getBytecode({ address: market.bank });
        if (!code || code === "0x" || market.asset.toLowerCase() !== asset.toLowerCase() ||
            await registry.read.assetToMarket([asset]) !== marketId || await bank.read.marketId() !== marketId ||
            (await bank.read.asset()).toLowerCase() !== asset.toLowerCase() || (await bank.read.ENGINE()).toLowerCase() !== params.engine.toLowerCase() ||
            (await bank.read.sideBetController()).toLowerCase() !== params.sideBet.toLowerCase() || await bank.read.minBet() !== minBet ||
            await bank.read.flatWithdrawFee() !== minBet || await bank.read.totalAssets() !== 0n || await bank.read.totalSupply() !== 0n ||
            !await bank.read.hasRole([await bank.read.BANK_ADMIN_ROLE(), params.admin])) throw new Error(`New ${name} bank initialization read-back failed`);
        markets[name] = { marketId, asset, bank: market.bank, minBet: minBet.toString(), creationHash: hash };
        console.log(`${name.toUpperCase()} market ${marketId}: ${market.bank}`);
    }
    const after = await readBalances();
    if (before.some((value, index) => value !== after[index]) || await brbBank.read.totalAssets() !== brbAssetsBefore || await registry.read.marketCount() !== 3) throw new Error("Unexpected token movement or final market count");
    return { markets, brbBankUnchanged: true, tokenBalancesUnchanged: true };
}
