/**
 * Generate a new Ethereum EOA using OS CSPRNG entropy + viem.
 *
 * Entropy source: Node `crypto.randomBytes` → kernel CSPRNG
 * (getrandom / SecRandomCopyBytes). 32 bytes = 256-bit private key space,
 * which is not practically brute-forceable.
 *
 * Does not write anything to disk. Copy the output to a password manager /
 * air-gapped backup, then clear your terminal scrollback.
 *
 * Usage:
 *   yarn wallet:generate
 */

import { randomBytes } from "node:crypto";

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** secp256k1 curve order n (private keys must be in [1, n-1]). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function generatePrivateKeyFromOsCsprng(): Hex {
  // Retry is only for the astronomically rare case of an out-of-range scalar.
  for (;;) {
    const bytes = randomBytes(32);
    const asInt = BigInt(`0x${bytes.toString("hex")}`);
    if (asInt > 0n && asInt < SECP256K1_N) {
      return `0x${bytes.toString("hex")}` as Hex;
    }
  }
}

const privateKey = generatePrivateKeyFromOsCsprng();
const account = privateKeyToAccount(privateKey);

console.log("");
console.log("=== New Ethereum wallet (OS CSPRNG + viem) ===");
console.log("");
console.log(`Address:     ${account.address}`);
console.log(`Private key: ${privateKey}`);
console.log("");
console.log("Security notes:");
console.log("- Entropy is 256 bits from the OS CSPRNG (not Math.random).");
console.log("- Anyone with the private key controls the address forever.");
console.log("- Do not commit, paste into chat, or store in .env / cloud notes.");
console.log("- Prefer a hardware wallet or Safe for mainnet deployer / admin keys.");
console.log("");