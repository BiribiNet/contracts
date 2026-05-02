// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";

library UpkeepCodecLib {
    function encodeJob(IRouletteEngine.Job memory job) internal pure returns (bytes memory) {
        return abi.encode(job);
    }

    function decodeJob(bytes memory data) internal pure returns (IRouletteEngine.Job memory) {
        return abi.decode(data, (IRouletteEngine.Job));
    }
}
