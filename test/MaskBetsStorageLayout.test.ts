import { artifacts } from "hardhat";

import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type StorageMember = { label: string; slot: string; offset: number; type: string };
type StorageType = {
    encoding: string;
    label: string;
    numberOfBytes: string;
    members?: StorageMember[];
    key?: string;
    value?: string;
    base?: string;
};
type Layout = { storage: StorageMember[]; types: Record<string, StorageType> };

const PROBE_SOURCE = "contracts/test/StorageLayoutProbes.sol";

async function probeLayout(probe: "EngineStorageLayoutProbe" | "VaultStorageLayoutProbe"): Promise<Layout> {
    const info = await artifacts.getBuildInfo(`${PROBE_SOURCE}:${probe}`);
    const layout = (info!.output.contracts[PROBE_SOURCE][probe] as unknown as { storageLayout: Layout }).storageLayout;
    return { storage: layout.types[layout.storage[0].type].members!, types: layout.types };
}

function readJson(path: string) {
    return JSON.parse(readFileSync(join(__dirname, "..", path), "utf8"));
}

/**
 * Same recursive comparison as `scripts/incident20261104.cjs#compareLayout`: every existing member keeps its
 * label, slot, offset and type (structs member by member, mapping keys/values, array strides). New members
 * may only be appended. `renamed` lists the only labels allowed to change (old → new).
 */
function compareLayout(before: Layout, after: Layout, renamed: Record<string, string> = {}) {
    const seen = new Set<string>();
    function members(a: StorageMember[], b: StorageMember[], label: string) {
        expect(b.length, `${label} removed fields`).to.be.gte(a.length);
        a.forEach((member, i) => {
            expect(b[i].label, `${label} label`).to.equal(renamed[member.label] ?? member.label);
            expect(b[i].slot, `${label}.${member.label} slot`).to.equal(member.slot);
            expect(b[i].offset, `${label}.${member.label} offset`).to.equal(member.offset);
            types(member.type, b[i].type, `${label}.${member.label}`);
        });
    }
    function types(aId: string, bId: string, label: string, fixed = false) {
        const key = `${aId}|${bId}|${fixed}`;
        if (seen.has(key)) return;
        seen.add(key);
        const a = before.types[aId], b = after.types[bId];
        expect(a && b, `${label} missing type`).to.not.equal(undefined);
        expect(b.encoding, `${label} encoding`).to.equal(a.encoding);
        if (fixed || !a.members) expect(b.numberOfBytes, `${label} width/stride`).to.equal(a.numberOfBytes);
        if (a.members) members(a.members, b.members!, label);
        else if (a.encoding === "mapping") {
            types(a.key!, b.key!, `${label} key`);
            types(a.value!, b.value!, `${label} value`);
        } else if (a.base) types(a.base, b.base!, `${label} item`, true);
        else expect(b.label.replace(/\s+/g, " "), `${label} type`).to.equal(a.label.replace(/\s+/g, " "));
    }
    members(before.storage, after.storage, "storage");
}

describe("Mask bets v1 — storage layouts (engine append-only, vault unchanged)", function () {
    it("engine: ERC-7201 Layout keeps all 45 fields and appends exactly the five mask fields", async function () {
        const baseline = readJson("reports/mask-bets-v1/storage-baseline-master.json").engine as Layout;
        const now = await probeLayout("EngineStorageLayoutProbe");
        compareLayout(baseline, now);
        const appended = now.storage.slice(baseline.storage.length).map((m) => [m.label, now.types[m.type].label]);
        expect(appended).to.deep.equal([
            ["roundMaskBets", "mapping(uint64 => mapping(uint32 => struct RouletteEngineStorageLib.MaskBetEntry[]))"],
            ["roundMaskWinCounts", "mapping(uint64 => mapping(uint32 => uint256[3]))"],
            ["roundMaskWeightedPayout", "mapping(uint64 => mapping(uint32 => uint256))"],
            ["maxMaskLegsPerMarketRound", "mapping(uint32 => uint32)"],
            ["maxMaskLiabilityBps", "mapping(uint32 => uint16)"],
        ]);
        // Every new field takes a fresh slot after the last existing one.
        const lastSlot = BigInt(baseline.storage[baseline.storage.length - 1].slot);
        now.storage.slice(baseline.storage.length).forEach((m, i) => expect(BigInt(m.slot)).to.equal(lastSlot + 1n + BigInt(i)));
        // MaskBetEntry: player | mask | size in slot 0, amount in slot 1.
        const entryType = Object.values(now.types).find((t) => t.label === "struct RouletteEngineStorageLib.MaskBetEntry")!;
        expect(entryType.numberOfBytes).to.equal("64");
        expect(entryType.members!.map((m) => [m.label, m.slot, m.offset])).to.deep.equal([
            ["player", "0", 0], ["mask", "0", 20], ["size", "0", 25], ["amount", "1", 0],
        ]);
    });

    it("vault: 14 fields with identical slots/offsets/types vs master and vs the deployed mainnet layout", async function () {
        const now = await probeLayout("VaultStorageLayoutProbe");
        expect(now.storage.length).to.equal(14);
        const renamed = { sideBetController: "_deprecatedSideBetController" };
        compareLayout(readJson("reports/mask-bets-v1/storage-baseline-master.json").vault as Layout, now, renamed);
        const deployed = readJson("reports/incident-2026-11-04/storage-validation.json").contracts
            .find((c: { name: string }) => c.name === "BankVault4626").layouts.afterRemoval.custom as Layout;
        compareLayout(deployed, now, renamed);
        expect(now.storage.length).to.equal(deployed.storage.length);
        expect(now.storage[3]).to.include({ label: "_deprecatedSideBetController", slot: "2", offset: 0 });
        expect(now.types[now.storage[3].type].label).to.equal("address");
    });
});

describe("Mask bets v1 — EIP-170 / EIP-3860 sizes without any size bypass", function () {
    const RUNTIME_LIMIT = 24_576;
    const INITCODE_LIMIT = 49_152;
    for (const name of [
        "RouletteEngine", "BankVault4626", "RouletteMaskBetLib", "RoulettePayoutSweepLib", "RouletteLiabilityMathLib",
        "RouletteUpkeepScanLib", "RouletteJackpotCollectLib", "RouletteExposureLib", "RouletteBetCodecLib",
        "JackpotBatchLib", "RouletteBetLib", "RoulettePayoutMulLib", "RouletteLib", "MarketFeeLib",
    ]) {
        it(`${name} fits under 24 576 / 49 152 bytes`, async function () {
            const artifact = await artifacts.readArtifact(name);
            expect((artifact.deployedBytecode.length - 2) / 2).to.be.lte(RUNTIME_LIMIT);
            expect((artifact.bytecode.length - 2) / 2).to.be.lte(INITCODE_LIMIT);
        });
    }
});
