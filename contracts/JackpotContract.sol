// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract JackpotContract is AccessControlUpgradeable, UUPSUpgradeable {
    error OnlyRoulette();
    address private immutable BRB_TOKEN;
    address private immutable ROULETTE_CONTRACT;

    constructor(address BRBToken, address RouletteContract) {
        BRB_TOKEN = BRBToken;
        ROULETTE_CONTRACT = RouletteContract;
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function jackpotWin(address[] memory winners, uint256 winnerShare) external {
        if (msg.sender != ROULETTE_CONTRACT) revert OnlyRoulette();
        uint256 winnersLength = winners.length;
        for (uint256 i; i < winnersLength;) {
            IERC20(BRB_TOKEN).transfer(winners[i], winnerShare);
            unchecked { ++i; }
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}