import { fallback, http, type Transport } from 'viem';

/** JSON arrays or comma/newline-separated HTTP URLs, in operator-specified order. */
export function parseRpcUrls(value: string): string[] {
  let entries: unknown;
  try {
    entries = value.trim().startsWith('[') ? JSON.parse(value) : value.split(/[,\s]+/).filter(Boolean);
  } catch {
    throw Error('RPC URLs must be a JSON array or comma/newline-separated HTTP URLs');
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((url) => typeof url !== 'string'))
    throw Error('Configure at least one HTTP RPC URL');
  const urls = [...new Set((entries as string[]).map((url) => url.trim()))];
  for (const url of urls) {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw Error();
    } catch {
      throw Error('RPC URLs must use HTTP or HTTPS');
    }
  }
  return urls;
}

export function resolveSepoliaRpcUrls(
  env: Record<string, string | undefined>,
  saved: (key: string) => string | undefined,
): string[] {
  const value =
    env.ARBITRUM_SEPOLIA_RPC_URLS?.trim() ||
    env.ARBITRUM_SEPOLIA_RPC_URL?.trim() ||
    saved('ARBITRUM_SEPOLIA_RPC_URLS')?.trim() ||
    saved('ARBITRUM_SEPOLIA_RPC_URL')?.trim();
  if (!value) throw Error('Set ARBITRUM_SEPOLIA_RPC_URLS or ARBITRUM_SEPOLIA_RPC_URL');
  return parseRpcUrls(value);
}

/** Verify each endpoint's chain before using it; share the check across public and signing clients. */
export function createRpcFallback(urls: string[], chainId: number): Transport {
  if (urls.length === 0) throw Error('Configure at least one HTTP RPC URL');
  return fallback(
    urls.map((url) => {
      let verified: Promise<void> | undefined;
      const endpoint = http(url, { timeout: 5000, retryCount: 0 });
      return ((options) => {
        const transport = endpoint(options);
        const check = (id: string) => {
          if (Number(BigInt(id)) !== chainId) throw Error('RPC endpoint chain mismatch');
        };
        const request = (async (args: Parameters<typeof transport.request>[0]) => {
          if (args.method === 'eth_chainId') {
            const id = await transport.request({ method: 'eth_chainId' });
            check(id as string);
            verified = Promise.resolve();
            return id;
          }
          verified ??= transport
            .request({ method: 'eth_chainId' })
            .then((id) => check(id as string))
            .catch((error) => {
              verified = undefined;
              throw error;
            });
          await verified;
          return transport.request(args);
        }) as typeof transport.request;
        return { ...transport, request };
      }) satisfies Transport;
    }),
    { rank: false, retryCount: 1, retryDelay: 250 },
  );
}
