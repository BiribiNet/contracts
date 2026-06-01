// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { BankVault4626 } from "../BankVault4626.sol";
import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";
import { ISideBet } from "../interfaces/ISideBet.sol";

/// @dev Test harness for withdrawal-queue edge cases and SideBet reentrancy probes.
contract BankVault4626Harness is BankVault4626 {
    /// @dev Must stay in sync with `BankVault4626` ERC-7201 namespace slot.
    bytes32 private constant HARNESS_VAULT_STORAGE_LOCATION =
        0xb0c430920bd46af8c5ecb68ebf1a5f6f3805a863a6d4fa0fa5e65feb72f8e800;

    /// @dev Prefix of `BankVault4626.BankVaultStorage` — enough to write `lockedBetLiquidity`.
    struct HarnessVaultStorage {
        uint32 marketId;
        IRouletteEngine ENGINE;
        uint256 lockedBetLiquidity;
    }

    address public sideBetTarget;
    uint256 public reenterConfigId;
    uint256 public reenterStake;
    bool public reenterSideBet;
    address public sideBetSettleTarget;
    bool public reenterSettleBatch;

    function _harnessS() private pure returns (HarnessVaultStorage storage $) {
        assembly {
            $.slot := HARNESS_VAULT_STORAGE_LOCATION
        }
    }

    function harnessEnqueueWithdrawal(address owner, uint16 bps, address receiver) external {
        _enqueueWithdrawal(owner, bps, receiver);
    }

    function harnessSetLockedBetLiquidity(uint256 locked) external {
        _harnessS().lockedBetLiquidity = locked;
    }

    function harnessMaxWithdrawParts(address owner) external view returns (uint256 base, uint256 free, uint256 capped) {
        free = totalAssets();
        capped = maxWithdraw(owner);
        base = capped;
    }

    function configureSideBetReenter(address target, uint256 configId, uint256 stake) external {
        sideBetTarget = target;
        reenterConfigId = configId;
        reenterStake = stake;
        reenterSideBet = target != address(0);
    }

    function configureSettleReenter(address target) external {
        sideBetSettleTarget = target;
        reenterSettleBatch = target != address(0);
    }

    function lockSideBetStake(address player, uint256 stake, uint256 payoutReserve) public override onlySideBet {
        super.lockSideBetStake(player, stake, payoutReserve);
        if (reenterSideBet && sideBetTarget != address(0)) {
            ISideBet(sideBetTarget).placeBet(reenterConfigId, reenterStake);
        }
    }

    function releaseBets(uint256 amount) public override onlyEngineOrSideBet {
        super.releaseBets(amount);
        if (reenterSettleBatch && sideBetSettleTarget != address(0)) {
            ISideBet(sideBetSettleTarget).settleBatch(
                new ISideBet.SettleRow[](0),
                new ISideBet.SettleVaultApply[](0)
            );
        }
    }
}
