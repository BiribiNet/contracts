// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IBRB } from "./interfaces/IBRB.sol";
import { IRoulette } from "./interfaces/IRoulette.sol";

contract JackpotContract is AccessControlUpgradeable, UUPSUpgradeable {
    error OnlyRoulette();
    event JackpotPaid(uint256 winnersCount);
    IBRB private immutable BRB_TOKEN;
    address private immutable ROULETTE_CONTRACT;

    constructor(address BRBToken, address RouletteContract) {
        BRB_TOKEN = IBRB(BRBToken);
        ROULETTE_CONTRACT = RouletteContract;
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function jackpotWin(IRoulette.PayoutInfo[] calldata payouts) external {
        if (msg.sender != ROULETTE_CONTRACT) revert OnlyRoulette();
        BRB_TOKEN.transferBatch(payouts);
        emit JackpotPaid(payouts.length);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}