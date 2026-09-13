import { expect } from "chai";

import { customErrorPattern } from "./helpers/customErrorPattern";

describe("Custom-error assertions", () => {
    it("accepts named and raw RPC errors for the exact expected no-argument error", () => {
        const pattern = customErrorPattern("InvalidInitialization()");
        expect("reverted with custom error 'InvalidInitialization()'").to.match(pattern);
        expect("reverted with an unrecognized custom error (return data: 0xf92ee8a9)").to.match(pattern);
    });

    it("does not mistake input calldata, a different error, or a selector prefix for the expected error", () => {
        const pattern = customErrorPattern("InvalidInitialization()");
        expect("data: 0xf92ee8a9; reverted with custom error 'InvalidConfig()'").not.to.match(pattern);
        expect("return data: 0x35be3ac8)").not.to.match(pattern);
        expect("return data: 0xf92ee8a900)").not.to.match(pattern);
        expect("unknown RPC error for InvalidInitialization()").not.to.match(pattern);
    });
});
