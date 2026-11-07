// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { BankVault4626 } from "../BankVault4626.sol";
import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";

/// @dev Test harness for withdrawal-queue edge cases. SideBet reentrancy probes live on
/// `legacy/LegacySideBetBankVault4626Harness` (the production vault has no side-bet surface any more).
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
}
