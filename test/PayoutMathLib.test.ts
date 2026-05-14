import { expect } from "chai";
import { viem } from "hardhat";

describe("PayoutMathLib", function () {
    it("caps payout to pool size when needed", async function () {
        const harness = await viem.deployContract("PayoutMathLibHarness");
        expect(await harness.read.capPayoutByPool([120n, 100n])).to.equal(100n);
        expect(await harness.read.capPayoutByPool([90n, 100n])).to.equal(90n);
    });

    it("computes basis-point percentages", async function () {
        const harness = await viem.deployContract("PayoutMathLibHarness");
        expect(await harness.read.percentOf([1_000n, 250n])).to.equal(25n);
        expect(await harness.read.percentOf([10_000n, 10_000n])).to.equal(10_000n);
    });
});
