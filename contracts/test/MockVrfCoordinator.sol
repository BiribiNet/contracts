// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { VRFV2PlusClient } from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import { CallWithExactGas } from "@chainlink/contracts/src/v0.8/shared/call/CallWithExactGas.sol";

interface IVrfConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

/// @dev Minimal VRFCoordinatorV2_5-shaped mock for local tests (LINK payment, struct request).
contract MockVrfCoordinator {
    uint256 public nextRequestId = 1;
    event GasCappedFulfillment(uint256 requestId, bool success, uint256 gasUsed);

    /// @dev Models the coordinator's non-reverting, exact-gas consumer call. A
    /// successful outer transaction does NOT mean the consumer callback succeeded.
    function fulfillGasCapped(address consumer, uint256 requestId, uint256 winningWord, uint256 jackpotWord, uint32 gasLimit) external {
        uint256[] memory words = new uint256[](2);
        words[0] = winningWord;
        words[1] = jackpotWord;
        (bool success,, uint256 gasUsed) = CallWithExactGas._callWithExactGasSafeReturnData(
            abi.encodeCall(IVrfConsumer.rawFulfillRandomWords, (requestId, words)), consumer, gasLimit, 5000, 0
        );
        emit GasCappedFulfillment(requestId, success, gasUsed);
    }

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata)
        external
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;
    }

    /// @notice Second word XOR-masks `randomWord` so `(a % 37) != ((a ^ mask) % 37)` in normal test use (avoid accidental jackpot).
    /// @dev `RouletteEngine` triggers the jackpot round when `(randomWords[0] % 37) == (randomWords[1] % 37)` with two words.
    function fulfill(address consumer, uint256 requestId, uint256 randomWord) external {
        uint256[] memory words = new uint256[](2);
        words[0] = randomWord;
        unchecked {
            words[1] = randomWord ^ 0xa5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5;
        }
        IVrfConsumer(consumer).rawFulfillRandomWords(requestId, words);
    }

    function fulfillWithJackpot(address consumer, uint256 requestId, uint256 winningWord, uint256 jackpotWord) external {
        uint256[] memory words = new uint256[](2);
        words[0] = winningWord;
        words[1] = jackpotWord;
        IVrfConsumer(consumer).rawFulfillRandomWords(requestId, words);
    }
}
