// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract VRFCoordinatorV2Mock {
    function requestRandomWords(bytes32,uint64,uint16,uint32,uint32) external pure returns (uint256) {
        return 1;
    }

    // Simulate Chainlink VRF callback
    function fulfillRandomWords(uint256 requestId, address consumer) external {
        // For testing, just send a single random word (e.g., 777)
        uint256[] memory randomWords = new uint256[](1);
        randomWords[0] = 777;
        (bool success, ) = consumer.call(
            abi.encodeWithSignature(
                "rawFulfillRandomWords(uint256,uint256[])",
                requestId,
                randomWords
            )
        );
        require(success, "Callback failed");
    }
} 