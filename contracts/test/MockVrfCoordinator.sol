// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IVrfConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

contract MockVrfCoordinator {
    uint256 public nextRequestId = 1;

    function requestRandomWords(
        bytes32,
        uint64,
        uint16,
        uint32,
        uint32
    ) external returns (uint256 requestId) {
        requestId = nextRequestId++;
    }

    function fulfill(address consumer, uint256 requestId, uint256 randomWord) external {
        uint256[] memory words = new uint256[](2);
        words[0] = randomWord;
        words[1] = randomWord;
        IVrfConsumer(consumer).rawFulfillRandomWords(requestId, words);
    }

    function fulfillWithJackpot(address consumer, uint256 requestId, uint256 winningWord, uint256 jackpotWord) external {
        uint256[] memory words = new uint256[](2);
        words[0] = winningWord;
        words[1] = jackpotWord;
        IVrfConsumer(consumer).rawFulfillRandomWords(requestId, words);
    }
}
