import { viem } from "hardhat";
import { parseAbi } from "viem";
async function main() {
  const asset = "0xA64617ABdcA4477B17020a763F24bFe27046a752" as const;
  const pc = await viem.getPublicClient();
  const [w] = await viem.getWalletClients();
  const erc20 = parseAbi([
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function mint(address,uint256)",
    "function owner() view returns (address)",
  ]);
  const name = await pc.readContract({ address: asset, abi: erc20, functionName: "name" }).catch(() => null);
  const symbol = await pc.readContract({ address: asset, abi: erc20, functionName: "symbol" }).catch(() => null);
  const decimals = await pc.readContract({ address: asset, abi: erc20, functionName: "decimals" }).catch(() => null);
  const bal = await pc.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [w.account.address] }).catch(() => null);
  let owner = null as string | null;
  try { owner = await pc.readContract({ address: asset, abi: erc20, functionName: "owner" }); } catch {}
  const code = await pc.getBytecode({ address: asset });
  console.log(JSON.stringify({ name, symbol, decimals: decimals?.toString(), balance: bal?.toString(), owner, codeLen: code?.length ?? 0, signer: w.account.address }, null, 2));
}
main();
