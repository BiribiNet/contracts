// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITipInfrastructure {
    function INFRA_RECIPIENT() external view returns (address);
}

/// @notice Voluntary BRB contributions. No game privileges, points or custody.
/// @dev Immutable deployment: token and infrastructure recipient cannot be redirected.
contract TipJar is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable TOKEN;
    address public immutable RECIPIENT;

    error InvalidConfiguration();
    error InvalidAmount();
    error UnexpectedReceivedAmount();

    event TipSent(address indexed sender, address indexed token, address indexed recipient, uint256 amount);

    constructor(address token, address engine) {
        if (token.code.length == 0 || engine.code.length == 0) revert InvalidConfiguration();
        address recipient = ITipInfrastructure(engine).INFRA_RECIPIENT();
        if (recipient == address(0) || recipient == address(this)) revert InvalidConfiguration();
        TOKEN = IERC20(token);
        RECIPIENT = recipient;
    }

    function tip(uint256 amount) external nonReentrant {
        if (amount == 0 || msg.sender == RECIPIENT) revert InvalidAmount();
        uint256 beforeBalance = TOKEN.balanceOf(RECIPIENT);
        TOKEN.safeTransferFrom(msg.sender, RECIPIENT, amount);
        uint256 afterBalance = TOKEN.balanceOf(RECIPIENT);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert UnexpectedReceivedAmount();
        }
        emit TipSent(msg.sender, address(TOKEN), RECIPIENT, amount);
    }
}
