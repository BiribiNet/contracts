// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract AggregatorV3Mock is AggregatorV3Interface {
        function decimals() external pure returns (uint8) {
            return 18;
        }

        function description() external pure returns (string memory) {
            return "Mock Aggregator";
        }

        function version() external pure returns (uint256) {
            return 1;
        }
        
        function getRoundData(uint80 _roundId) external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
            return (_roundId, 1 ether, 0, block.timestamp, _roundId);
        }

        function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
             return (1, 1 ether, 0, block.timestamp, 1);
        }
}