import { writeFileSync } from "node:fs";
import { funkyCataloguePlan } from "./utils/funkyCatalogue";
// Read-only proposal. Never connects a signer or changes a multiplier band.
const proposal = funkyCataloguePlan(1, 50000, 5000000, 500);
writeFileSync("docs/side-bet-funky-pricing.json", JSON.stringify(proposal, (_, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
