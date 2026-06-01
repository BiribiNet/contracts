// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { BankVault4626 } from "../BankVault4626.sol";
import { BRBJackpotFunder } from "../BRBJackpotFunder.sol";
import { RouletteEngine } from "../RouletteEngine.sol";
import { SideBet } from "../SideBet.sol";
import { ISideBet } from "../interfaces/ISideBet.sol";

/// @dev Executes guarded paths inside try/catch so revert branches register under solidity-coverage.
contract CoverageProbe {
    function tryBankInitialize(BankVault4626 vault, BankVault4626.InitializeParams calldata p) external returns (bool ok) {
        try vault.initialize(p) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetSideBetController(BankVault4626 vault, address controller) external returns (bool ok) {
        try vault.setSideBetController(controller) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetMinBet(BankVault4626 vault, uint256 minBet) external returns (bool ok) {
        try vault.setMinBet(minBet) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function tryPlaceBet(BankVault4626 vault, uint256 amount, bytes calldata betData, address referral)
        external
        returns (bool ok)
    {
        try vault.placeBet(amount, betData, referral) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function tryPlaceBetWithPermit(
        BankVault4626 vault,
        uint256 amount,
        bytes calldata betData,
        address referral,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bool ok) {
        try vault.placeBetWithPermit(amount, betData, referral, deadline, v, r, s) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function tryLockSideBetStake(BankVault4626 vault, address player, uint256 stake, uint256 payoutReserve)
        external
        returns (bool ok)
    {
        try vault.lockSideBetStake(player, stake, payoutReserve) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function tryRedeemBps(BankVault4626 vault, uint16 bps, address receiver, address owner) external returns (bool ok) {
        try vault.redeemBps(bps, receiver, owner) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function tryWithdraw(BankVault4626 vault, uint256 assets, address receiver, address owner) external returns (bool ok) {
        try vault.withdraw(assets, receiver, owner) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function tryRedeem(BankVault4626 vault, uint256 shares, address receiver, address owner) external returns (bool ok) {
        try vault.redeem(shares, receiver, owner) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetWithdrawalQueueBatchSize(RouletteEngine engine, uint256 newBatchSize) external returns (bool ok) {
        try engine.setWithdrawalQueueBatchSize(newBatchSize) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetMaxWithdrawalQueueLength(RouletteEngine engine, uint256 newMaxLength) external returns (bool ok) {
        try engine.setMaxWithdrawalQueueLength(newMaxLength) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySettleBatch(SideBet sideBet, ISideBet.SettleRow[] calldata rows, ISideBet.SettleVaultApply[] calldata vaultApplies)
        external
        returns (bool ok)
    {
        try sideBet.settleBatch(rows, vaultApplies) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetSwapAssetBps(BRBJackpotFunder funder, uint256 bps) external returns (bool ok) {
        try funder.setSwapAssetBps(bps) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetTreasuryBrbSplit(BRBJackpotFunder funder, uint256 num, uint256 den) external returns (bool ok) {
        try funder.setTreasuryBrbSplit(num, den) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetSlippageBps(BRBJackpotFunder funder, uint256 bps) external returns (bool ok) {
        try funder.setSlippageBps(bps) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySideBetInitialize(
        SideBet sideBet,
        address admin,
        address engine,
        address registry,
        uint32 minMul,
        uint32 maxMul
    ) external returns (bool ok) {
        try sideBet.initialize(admin, engine, registry, minMul, maxMul) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function tryAddConfig(SideBet sideBet, SideBet.SideBetConfig calldata cfg) external returns (bool ok) {
        try sideBet.addConfig(cfg) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySetMultiplierBand(SideBet sideBet, uint32 minMul, uint32 maxMul) external returns (bool ok) {
        try sideBet.setMultiplierBand(minMul, maxMul) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function trySideBetPlaceBet(SideBet sideBet, uint256 configId, uint256 stake) external returns (bool ok) {
        try sideBet.placeBet(configId, stake) {
            ok = true;
        } catch {
            ok = false;
        }
    }
}
