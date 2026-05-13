import {
    decodeEventLog,
    encodeAbiParameters,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { parseAbi } from "viem";

/** Chainlink VRF v2.5 coordinator subscription API (Ethereum Sepolia and other v2.5 networks). */
const vrfSubscriptionCoordinatorAbi = parseAbi([
    "function createSubscription() external returns (uint256 subId)",
    "function addConsumer(uint256 subId, address consumer) external",
    "function getSubscription(uint256 subId) external view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] consumers)",
    "event SubscriptionCreated(uint256 indexed subId, address owner)",
]);

const linkTransferAndCallAbi = parseAbi([
    "function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool)",
]);

/**
 * Explicit gas limits so Hardhat’s `AutomaticGasProvider` does not run `eth_estimateGas`
 * (many Sepolia RPCs return `gas required exceeds allowance (0)` when estimation fails).
 */
const GAS_CREATE_SUBSCRIPTION = 450_000n;
const GAS_ADD_CONSUMER = 350_000n;
const GAS_LINK_TRANSFER_AND_CALL = 550_000n;

/**
 * Creates a new VRF subscription; `msg.sender` becomes the owner (typical: deployer EOA).
 * @returns On-chain subscription id (`uint256`, including hashed-style ids on v2.5 coordinators).
 */
export async function vrfCreateSubscription(
    walletClient: WalletClient,
    publicClient: PublicClient,
    coordinator: Address,
): Promise<bigint> {
    if (!walletClient.account) throw new Error("WalletClient must have an account");
    const hash = await walletClient.writeContract({
        address: coordinator,
        abi: vrfSubscriptionCoordinatorAbi,
        functionName: "createSubscription",
        account: walletClient.account,
        chain: walletClient.chain,
        gas: GAS_CREATE_SUBSCRIPTION,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== coordinator.toLowerCase()) continue;
        try {
            const decoded = decodeEventLog({
                abi: vrfSubscriptionCoordinatorAbi,
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            if (decoded.eventName === "SubscriptionCreated") {
                return decoded.args.subId as bigint;
            }
        } catch {
            /* wrong log shape */
        }
    }
    throw new Error(`createSubscription: SubscriptionCreated not found in tx ${hash}`);
}

/** Registers `consumer` on the subscription if not already present. */
export async function vrfAddConsumerIfNeeded(
    walletClient: WalletClient,
    publicClient: PublicClient,
    coordinator: Address,
    subId: bigint,
    consumer: Address,
): Promise<void> {
    if (!walletClient.account) throw new Error("WalletClient must have an account");
    const subscription = await publicClient.readContract({
        address: coordinator,
        abi: vrfSubscriptionCoordinatorAbi,
        functionName: "getSubscription",
        args: [subId],
    });
    const consumers = subscription[4] as Address[];

    if (consumers.some((c) => c.toLowerCase() === consumer.toLowerCase())) {
        return;
    }

    const hash = await walletClient.writeContract({
        address: coordinator,
        abi: vrfSubscriptionCoordinatorAbi,
        functionName: "addConsumer",
        args: [subId, consumer],
        account: walletClient.account,
        chain: walletClient.chain,
        gas: GAS_ADD_CONSUMER,
    });
    await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Funds a subscription with test LINK via ERC-677 `transferAndCall`.
 * Coordinator must implement `onTokenTransfer` for the encoded `subId`.
 */
export async function vrfFundSubscriptionWithLink(
    walletClient: WalletClient,
    publicClient: PublicClient,
    linkToken: Address,
    coordinator: Address,
    subId: bigint,
    amountJuels: bigint,
): Promise<void> {
    if (!walletClient.account) throw new Error("WalletClient must have an account");
    if (amountJuels <= 0n) return;

    const data = encodeAbiParameters([{ type: "uint256" }], [subId]);

    const hash = await walletClient.writeContract({
        address: linkToken,
        abi: linkTransferAndCallAbi,
        functionName: "transferAndCall",
        args: [coordinator, amountJuels, data],
        account: walletClient.account,
        chain: walletClient.chain,
        gas: GAS_LINK_TRANSFER_AND_CALL,
    });
    await publicClient.waitForTransactionReceipt({ hash });
}
