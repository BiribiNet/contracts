import { artifacts } from "hardhat";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Linked engine storage compatibility", function () {
  // v1: original deployed layout. v2: mask bets v1 (`MaskBetEntry` + five fields appended after `jackpotPreparation`).
  for (const version of ["v1", "v2"]) it(`preserves every existing mapped type and the ${version} ERC-7201 Layout prefix`, async function () {
    const baseline = JSON.parse(readFileSync(join(__dirname, `../docs/storage/RouletteEngineStorage.${version}.json`), "utf8"));
    const info = await artifacts.getBuildInfo("contracts/libraries/RouletteEngineStorageLib.sol:RouletteEngineStorageLib");
    const ast = info!.output.sources["contracts/libraries/RouletteEngineStorageLib.sol"].ast as any;
    const library = ast.nodes.find((node: any) => node.nodeType === "ContractDefinition");
    for (const [name, members] of Object.entries(baseline)) {
      const node = library.nodes.find((node: any) => node.name === name);
      expect(node, name).not.to.equal(undefined);
      const actual = node.members.map((member: any) => ({ name: member.name, type: member.typeDescriptions?.typeString ?? "enum" }));
      expect(name === "Layout" ? actual.slice(0, (members as any[]).length) : actual, name).to.deep.equal(members);
    }
  });
});
