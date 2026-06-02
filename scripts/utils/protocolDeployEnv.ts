import { isAddress } from "viem";

export function optionalAddressEnv(name: string, raw: string | undefined): `0x${string}` | undefined {
    if (raw === undefined) return undefined;
    const v = raw.trim();
    if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "undefined") return undefined;
    if (!isAddress(v)) throw new Error(`${name} must be a valid 0x address or empty: ${raw}`);
    return v;
}

export function envAddressOrDefault(name: string, fallback: `0x${string}`): `0x${string}` {
    return optionalAddressEnv(name, process.env[name]) ?? fallback;
}

export function envBigIntOr(name: string, fallback: bigint): bigint {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    try {
        return BigInt(raw);
    } catch {
        throw new Error(`${name} must be an integer decimal string: ${raw}`);
    }
}

export function envBytes32Or(name: string, fallback: `0x${string}`): `0x${string}` {
    const raw = process.env[name]?.trim();
    if (!raw || raw.toLowerCase() === "null") return fallback;
    if (!raw.startsWith("0x") || raw.length !== 66) {
        throw new Error(`${name} must be a bytes32 hex string: 0x followed by 64 hex characters`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(`${name} must be hex: ${raw}`);
    }
    return raw as `0x${string}`;
}

export function envBool(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === "") return defaultValue;
    if (raw === "1" || raw === "true" || raw === "yes") return true;
    if (raw === "0" || raw === "false" || raw === "no") return false;
    throw new Error(`${name} must be true/false (got ${process.env[name]})`);
}

export function vrfKeyHashTriple(defaultLane: `0x${string}`): readonly [`0x${string}`, `0x${string}`, `0x${string}`] {
    return [
        envBytes32Or("VRF_KEY_HASH_2_GWEI", defaultLane),
        envBytes32Or("VRF_KEY_HASH_30_GWEI", defaultLane),
        envBytes32Or("VRF_KEY_HASH_150_GWEI", defaultLane),
    ] as const;
}
