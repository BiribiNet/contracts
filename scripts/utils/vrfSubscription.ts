import {
    decodeEventLog,
    encodeAbiParameters,
    keccak256,
    toBytes,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { parseAbi } from "viem";

/** Topic0 varies by coordinator build: Arbitrum Sepolia uses uint64; some L1s use uint256. */
const SUBSCRIPTION_CREATED_TOPIC_UINT256 = keccak256(toBytes("SubscriptionCreated(uint256,address)"));
const SUBSCRIPTION_CREATED_TOPIC_UINT64 = keccak256(toBytes("SubscriptionCreated(uint64,address)"));

const vrfCoordinatorCreateAbi = parseAbi(["function createSubscription() external returns (uint256 subId)"]);

const vrfCoordinatorSubscriptionAbiU64 = parseAbi([
    "function getSubscription(uint64 subId) external view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] consumers)",
    "function addConsumer(uint64 subId, address consumer) external",
]);

const vrfCoordinatorSubscriptionAbiU256 = parseAbi([
    "function getSubscription(uint256 subId) external view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] consumers)",
    "function addConsumer(uint256 subId, address consumer) external",
]);

const vrfSubscriptionCreatedEventAbi = parseAbi([
    "event SubscriptionCreated(uint64 indexed subId, address owner)",
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

const linkBalanceAbi = parseAbi(["function balanceOf(address account) external view returns (uint256)"]);

/** Default Juels (18 decimals) when a deploy script creates a new VRF subscription. Override with `VRF_INITIAL_LINK_JUELS`. */
export const DEFAULT_VRF_INITIAL_LINK_JUELS = 5n * 10n ** 18n;

/**
 * Resolves LINK to fund a VRF subscription during deploy.
 * When the script creates the subscription and `VRF_INITIAL_LINK_JUELS` is unset, funds {@link DEFAULT_VRF_INITIAL_LINK_JUELS}.
 * Set `VRF_INITIAL_LINK_JUELS=0` to skip funding even for a new subscription.
 */
export function resolveVrfInitialLinkJuels(
    envValue: string | undefined,
    subscriptionCreatedByScript: boolean,
): bigint {
    const raw = envValue?.trim();
    if (raw !== undefined && raw !== "") {
        return BigInt(raw);
    }
    return subscriptionCreatedByScript ? DEFAULT_VRF_INITIAL_LINK_JUELS : 0n;
}

async function coordinatorUsesUint64SubscriptionId(
    publicClient: PublicClient,
    coordinator: Address,
    subId: bigint,
): Promise<boolean> {
    try {
        await publicClient.readContract({
            address: coordinator,
            abi: vrfCoordinatorSubscriptionAbiU64,
            functionName: "getSubscription",
            args: [subId],
        });
        return true;
    } catch {
        await publicClient.readContract({
            address: coordinator,
            abi: vrfCoordinatorSubscriptionAbiU256,
            functionName: "getSubscription",
            args: [subId],
        });
        return false;
    }
}

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
        abi: vrfCoordinatorCreateAbi,
        functionName: "createSubscription",
        account: walletClient.account,
        chain: walletClient.chain,
        gas: GAS_CREATE_SUBSCRIPTION,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== coordinator.toLowerCase()) continue;
        const topic0 = log.topics[0];
        if (
            topic0 === SUBSCRIPTION_CREATED_TOPIC_UINT64 ||
            topic0 === SUBSCRIPTION_CREATED_TOPIC_UINT256
        ) {
            const subTopic = log.topics[1];
            if (!subTopic) throw new Error(`createSubscription: missing indexed subId in tx ${hash}`);
            return BigInt(subTopic);
        }
        try {
            const decoded = decodeEventLog({
                abi: vrfSubscriptionCreatedEventAbi,
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
    const useU64 = await coordinatorUsesUint64SubscriptionId(publicClient, coordinator, subId);
    const subAbi = useU64 ? vrfCoordinatorSubscriptionAbiU64 : vrfCoordinatorSubscriptionAbiU256;

    const subscription = await publicClient.readContract({
        address: coordinator,
        abi: subAbi,
        functionName: "getSubscription",
        args: [subId],
    });
    const consumers = subscription[4] as Address[];

    if (consumers.some((c) => c.toLowerCase() === consumer.toLowerCase())) {
        return;
    }

    const hash = await walletClient.writeContract({
        address: coordinator,
        abi: subAbi,
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

    const linkBalance = await publicClient.readContract({
        address: linkToken,
        abi: linkBalanceAbi,
        functionName: "balanceOf",
        args: [walletClient.account.address],
    });
    if (linkBalance < amountJuels) {
        throw new Error(
            `Deployer LINK balance ${linkBalance.toString()} Juels is below VRF_INITIAL_LINK_JUELS ${amountJuels.toString()} — fund ${walletClient.account.address} with testnet LINK.`,
        );
    }

    const useU64 = await coordinatorUsesUint64SubscriptionId(publicClient, coordinator, subId);
    const data = encodeAbiParameters([{ type: useU64 ? "uint64" : "uint256" }], [subId]);

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
