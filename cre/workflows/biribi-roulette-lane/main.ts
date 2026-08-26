import {
  EVMClient,
  HTTPCapability,
  getNetwork,
  handler,
  hexToBase64,
  bytesToHex,
  bytesToBigint,
  TxStatus,
  type Runtime,
  Runner,
  type EVMLog,
  type HTTPPayload,
} from "@chainlink/cre-sdk";
import {
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  toBytes,
  isAddress,
  type Hex,
  type Address,
} from "viem";
import { z } from "zod";
import { IAutomationCompatibleABI } from "../../contracts/evm/ts/generated/IAutomationCompatible";
import { AutomationReceiver } from "../../contracts/evm/ts/generated/AutomationReceiver";
import { IAutomationCompatible } from "../../contracts/evm/ts/generated/IAutomationCompatible";

// One binary, config selects handlers:
// - HTTP: TriggerVrf (round-watcher)
// - LOG: payout lanes (VRFResult / PayoutProgress)
// - BOTH: payout lanes with HTTP recovery wake (same workflow slot)
const evmAddress = z.string().superRefine((value, ctx) => {
  if (!isAddress(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid EVM address" });
  }
});

const configSchema = z.object({
  chainSelectorName: z.string(),
  receiverAddress: evmAddress,
  targetAddress: evmAddress,
  /** LOG | HTTP | BOTH (LOG + HTTP handlers in one registered workflow). */
  migrationType: z.enum(["LOG", "HTTP", "BOTH"]),
  checkData: z.string().optional(),
  writeGasLimit: z.string().optional(),
  maxDrainIterations: z.number().int().positive().optional(),

  // HTTP
  authorizedKeys: z.array(evmAddress).optional(),
  /** Local `cre workflow simulate` only — never set in production configs. */
  allowUnauthenticatedSim: z.boolean().optional(),

  // LOG
  logTriggerAddress: z.string().optional(),
  logTriggerEventSignatures: z.array(z.string()).min(1).optional(),
  logTriggerConfidence: z
    .enum(["CONFIDENCE_LEVEL_SAFE", "CONFIDENCE_LEVEL_FINALIZED"])
    .optional(),
});
type Config = z.infer<typeof configSchema>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function assertConfiguredAddress(value: string | undefined, fieldName: string): asserts value is Address {
  if (!value || !isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${fieldName} must be configured with a deployed contract address`);
  }
}

/** Map CRE log → AutomationCompatible.checkLog struct. */
function mapLogToAutomation(log: EVMLog) {
  return {
    index: BigInt(log.index || 0),
    // CRE EVMLog has no block timestamp; scheduler.checkLog does not use it.
    timestamp: 0n,
    txHash: (log.txHash ? bytesToHex(log.txHash) : ("0x" + "0".repeat(64))) as Hex,
    blockNumber: log.blockNumber ? bytesToBigint(log.blockNumber.absVal) : 0n,
    blockHash: (log.blockHash ? bytesToHex(log.blockHash) : ("0x" + "0".repeat(64))) as Hex,
    source: (log.address ? bytesToHex(log.address) : ("0x" + "0".repeat(40))) as Address,
    topics: (log.topics || []).map((t) => bytesToHex(t) as Hex),
    data: (log.data ? bytesToHex(log.data) : "0x") as Hex,
  };
}

function buildTopicsFilter(signatures: string[]): Array<{ values: string[] }> {
  return [
    {
      values: signatures.map((signature) => hexToBase64(keccak256(toBytes(signature)))),
    },
  ];
}

function writePerformUpkeep(
  runtime: Runtime<Config>,
  receiver: AutomationReceiver,
  targetAddress: Address,
  performData: Hex,
  writeGasLimit: string,
): string {
  const finalCallData = encodeFunctionData({
    abi: IAutomationCompatibleABI,
    functionName: "performUpkeep",
    args: [performData],
  });
  const reportPayload = encodeAbiParameters(
    [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    [targetAddress, finalCallData],
  );

  const writeResult = receiver.writeReport(runtime, reportPayload, { gasLimit: writeGasLimit });
  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Transaction failed: ${writeResult.errorMessage || writeResult.txStatus}`);
  }
  return bytesToHex(writeResult.txHash || new Uint8Array(32));
}

/**
 * Drain checkUpkeep → performUpkeep up to maxDrainIterations.
 * LOG wake: first iteration uses checkLog (validates the triggering log); later drains use checkUpkeep.
 * HTTP wake: always checkUpkeep (no log payload).
 */
const runMigration = (runtime: Runtime<Config>, triggerLog?: EVMLog): string => {
  const config = runtime.config;
  const checkData = (config.checkData ?? "0x") as Hex;
  const writeGasLimit = config.writeGasLimit ?? "2500000";
  const maxDrainIterations = config.maxDrainIterations ?? 1;

  assertConfiguredAddress(config.receiverAddress, "receiverAddress");
  assertConfiguredAddress(config.targetAddress, "targetAddress");

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);

  const evmClient = new EVMClient(network.chainSelector.selector);
  const target = new IAutomationCompatible(evmClient, config.targetAddress);
  const receiver = new AutomationReceiver(evmClient, config.receiverAddress);
  const targetAddress = config.targetAddress as Address;

  let lastTxHash = "";

  for (let i = 0; i < maxDrainIterations; i++) {
    let upkeepNeeded: boolean;
    let performData: Hex;

    if (triggerLog && i === 0) {
      [upkeepNeeded, performData] = target.checkLog(runtime, mapLogToAutomation(triggerLog), checkData);
    } else {
      [upkeepNeeded, performData] = target.checkUpkeep(runtime, checkData);
    }

    if (!upkeepNeeded) {
      return i === 0 ? "No upkeep needed" : lastTxHash || "Drain complete";
    }

    lastTxHash = writePerformUpkeep(runtime, receiver, targetAddress, performData, writeGasLimit);
  }

  return lastTxHash;
};

function buildLogHandler(config: Config, evmClient: EVMClient) {
  assertConfiguredAddress(config.logTriggerAddress, "logTriggerAddress");
  const signatures = config.logTriggerEventSignatures;
  if (!signatures?.length) {
    throw new Error("logTriggerEventSignatures is required for LOG / BOTH migration");
  }

  return handler(
    evmClient.logTrigger({
      addresses: [hexToBase64(config.logTriggerAddress)],
      topics: buildTopicsFilter(signatures),
      confidence: config.logTriggerConfidence ?? "CONFIDENCE_LEVEL_SAFE",
    }),
    (runtime: Runtime<Config>, triggerLog: EVMLog) => runMigration(runtime, triggerLog),
  );
}

function buildHttpHandler(config: Config) {
  const authorizedKeys = config.authorizedKeys ?? [];
  if (authorizedKeys.length === 0 && !config.allowUnauthenticatedSim) {
    throw new Error(
      "authorizedKeys is required for HTTP / BOTH migration (or set allowUnauthenticatedSim for local simulate only)",
    );
  }

  return handler(
    new HTTPCapability().trigger({
      authorizedKeys: authorizedKeys.map((publicKey) => ({
        type: "KEY_TYPE_ECDSA_EVM" as const,
        publicKey,
      })),
    }),
    (runtime: Runtime<Config>, _payload: HTTPPayload) => runMigration(runtime),
  );
}

function initWorkflow(config: Config) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new EVMClient(network.chainSelector.selector);

  // LOG first so --trigger-index=0 stays the log path for existing simulate scripts.
  // HTTP is --trigger-index=1 when migrationType is BOTH.
  if (config.migrationType === "BOTH") {
    return [buildLogHandler(config, evmClient), buildHttpHandler(config)];
  }
  if (config.migrationType === "LOG") {
    return [buildLogHandler(config, evmClient)];
  }
  if (config.migrationType === "HTTP") {
    return [buildHttpHandler(config)];
  }

  throw new Error(`Unsupported migrationType: ${config.migrationType}`);
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
