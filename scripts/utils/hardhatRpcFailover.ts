import type { EIP1193Provider } from "hardhat/types";

import { createPublicClient, type Chain, type PublicClient } from "viem";
import { arbitrum } from "viem/chains";

import { createRpcFallback, resolveArbitrumRpcUrls } from "./rpcFallback";

type JsonRpcRequest = { method: string; params?: unknown[] };

function isRetriableRpcError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|502|503|504|429|rate limit|gateway|fetch failed|network|server error|internal error|missing response|could not detect network/i.test(
        message,
    );
}

async function jsonRpcFetch(url: string, args: JsonRpcRequest): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                method: args.method,
                params: args.params ?? [],
            }),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`RPC HTTP ${response.status} from fallback`);
        const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
        if (body.error) throw new Error(body.error.message ?? "RPC error from fallback");
        return body.result;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Wraps Hardhat's EIP-1193 provider so failed / timed-out requests retry on the
 * remaining Arbitrum One public RPCs. Install once at the start of a long deploy.
 */
export function installHardhatRpcFailover(
    provider: EIP1193Provider,
    urls: string[] = resolveArbitrumRpcUrls(),
): void {
    if (urls.length < 2) return;
    const tagged = provider as EIP1193Provider & { __biribiRpcFailover?: boolean };
    if (tagged.__biribiRpcFailover) return;
    tagged.__biribiRpcFailover = true;

    const originalRequest = provider.request.bind(provider);
    provider.request = (async (args: JsonRpcRequest) => {
        try {
            return await originalRequest(args);
        } catch (primaryError) {
            if (!isRetriableRpcError(primaryError)) throw primaryError;
            let lastError: unknown = primaryError;
            for (const url of urls.slice(1)) {
                try {
                    console.warn(`Hardhat RPC failover → ${new URL(url).host} for ${args.method}`);
                    return await jsonRpcFetch(url, args);
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError;
        }
    }) as EIP1193Provider["request"];
}

/** Dedicated viem public client with the same failover list (receipts / reads). */
export function createArbitrumFallbackPublicClient(chain: Chain = arbitrum): PublicClient {
    return createPublicClient({
        chain,
        transport: createRpcFallback(resolveArbitrumRpcUrls(), chain.id),
    });
}
