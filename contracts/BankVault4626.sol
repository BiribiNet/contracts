// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";

contract BankVault4626 is ERC4626, AccessControl, IBankVault {
    using SafeERC20 for ERC20;

    bytes32 public constant BANK_ADMIN_ROLE = keccak256("BANK_ADMIN_ROLE");

    uint32 public immutable override marketId;
    IRouletteEngine public immutable ENGINE;

    uint256 public lockedBetLiquidity;

    error OnlyEngine();
    error ZeroAmount();
    error InvalidPlayer();

    event BetPlaced(address player, uint256 amount, uint32 marketId);
    event BetsReleased(uint256 amount, uint256 newLockedTotal);
    event PayoutBatchProcessed(uint256 payoutCount, uint256 totalPaid);
    event FundsTransferred(address indexed recipient, uint256 amount);

    modifier onlyEngine() {
        if (msg.sender != address(ENGINE)) revert OnlyEngine();
        _;
    }

    constructor(
        address assetToken_,
        string memory name_,
        string memory symbol_,
        uint32 marketId_,
        address engine,
        address admin
    ) ERC20(name_, symbol_) ERC4626(ERC20(assetToken_)) {
        marketId = marketId_;
        ENGINE = IRouletteEngine(engine);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BANK_ADMIN_ROLE, admin);
    }


    function placeBet(uint256 amount, bytes calldata betData) external {
        if (amount == 0) revert ZeroAmount();
        ERC20(address(asset())).safeTransferFrom(msg.sender, address(this), amount);
        lockedBetLiquidity += amount;
        ENGINE.recordBet(marketId, msg.sender, amount, betData);
        emit BetPlaced(msg.sender, amount, marketId);
    }

    function releaseBets(uint256 amount) external onlyEngine {
        if (amount > lockedBetLiquidity) {
            lockedBetLiquidity = 0;
        } else {
            lockedBetLiquidity -= amount;
        }
        emit BetsReleased(amount, lockedBetLiquidity);
    }

    function payoutBatch(IBankVault.Payout[] calldata payouts) external onlyEngine returns (uint256 totalPaid) {
        ERC20 token = ERC20(address(asset()));
        uint256 length = payouts.length;
        for (uint256 i; i < length; ) {
            IBankVault.Payout calldata payout = payouts[i];
            if (payout.player == address(0)) revert InvalidPlayer();
            token.safeTransfer(payout.player, payout.amount);
            totalPaid += payout.amount;
            unchecked {
                ++i;
            }
        }
        emit PayoutBatchProcessed(length, totalPaid);
        return totalPaid;
    }

    function transferOut(address recipient, uint256 amount) external onlyEngine {
        if (recipient == address(0)) revert InvalidPlayer();
        if (amount == 0) return;
        ERC20(address(asset())).safeTransfer(recipient, amount);
        emit FundsTransferred(recipient, amount);
    }

    function totalAssets() public view override returns (uint256) {
        uint256 gross = ERC20(address(asset())).balanceOf(address(this));
        return gross > lockedBetLiquidity ? gross - lockedBetLiquidity : 0;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 base = super.maxWithdraw(owner);
        uint256 freeLiquidity = totalAssets();
        return base > freeLiquidity ? freeLiquidity : base;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 maxAssets = maxWithdraw(owner);
        return previewWithdraw(maxAssets);
    }
}
