// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IJackpotTreasury } from "./interfaces/IJackpotTreasury.sol";

/// @notice BRB-only jackpot treasury. Engine distributes pool among winners by stake share.
contract JackpotTreasury is AccessControl, IJackpotTreasury {
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURY_ADMIN_ROLE = keccak256("TREASURY_ADMIN_ROLE");

    address public immutable engine;
    IERC20 public immutable brb;

    error OnlyEngine();
    error ZeroAddress();
    error LengthMismatch();

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    constructor(address brb_, address engine_, address admin) {
        if (brb_ == address(0) || engine_ == address(0) || admin == address(0)) revert ZeroAddress();
        brb = IERC20(brb_);
        engine = engine_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TREASURY_ADMIN_ROLE, admin);
    }

    function jackpotPool() public view override returns (uint256) {
        return brb.balanceOf(address(this));
    }

    /// @inheritdoc IJackpotTreasury
    function payBatch(address[] calldata winners, uint256[] calldata amounts)
        external
        override
        onlyEngine
        returns (uint256 paid)
    {
        uint256 n = winners.length;
        if (n != amounts.length) revert LengthMismatch();
        address w;
        uint256 amt;
        for (uint256 i; i < n; ) {
            w = winners[i];
            amt = amounts[i];
            if (amt > 0) {
                brb.safeTransfer(w, amt);
                paid += amt;
            }
            unchecked {
                ++i;
            }
        }
    }
}
