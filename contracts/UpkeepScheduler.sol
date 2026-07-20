// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { AutomationCompatibleInterface } from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { ISideBet } from "./interfaces/ISideBet.sol";
import { IUpkeepForwarderAuthority } from "./interfaces/IUpkeepForwarderAuthority.sol";
import { IUpkeepScheduler } from "./interfaces/IUpkeepScheduler.sol";

contract UpkeepScheduler is AccessControl, AutomationCompatibleInterface, IUpkeepScheduler {
    bytes32 public constant SCHEDULER_ADMIN_ROLE = keccak256("SCHEDULER_ADMIN_ROLE");

    enum UpkeepWorkKind {
        Roulette,
        SideBet
    }

    IRouletteEngine public immutable ENGINE;
    ISideBet public immutable SIDE_BET;
    uint32 public override scanLimit;
    uint32 public override maxPayoutsPerCall;

    mapping(uint256 lane => uint32 cursor) public laneCursor;
    mapping(uint256 lane => uint256 cursorBetId) public sideBetCursor;

    /// @dev `CreExecutionAuthority` (or test double) — only approved executors (e.g. CRE `AutomationReceiver`) may call `performUpkeep`.
    address public forwarderAuthority;

    error ZeroAddress();
    error InvalidScanLimit();
    error InvalidMaxPayoutsPerCall();
    error UnauthorizedAutomationForwarder();

    event ScanLimitUpdated(uint32 newScanLimit);
    event MaxPayoutsPerCallUpdated(uint32 newMaxPayoutsPerCall);
    event LaneCursorAdvanced(uint256 lane, uint32 previousCursor, uint32 newCursor);
    event SideBetCursorAdvanced(uint256 lane, uint256 previousCursor, uint256 newCursor);
    event ForwarderAuthorityUpdated(address authority);

    /// @dev CRE log-trigger ABI (`IAutomationCompatible.checkLog`).
    struct Log {
        uint256 index;
        uint256 timestamp;
        bytes32 txHash;
        uint256 blockNumber;
        bytes32 blockHash;
        address source;
        bytes32[] topics;
        bytes data;
    }

    bytes32 private constant VRF_RESULT_TOPIC = keccak256("VRFResult(uint64,uint8,uint8)");
    bytes32 private constant PAYOUT_PROGRESS_TOPIC =
        keccak256("PayoutProgress(uint64,uint32,uint256,uint256,uint256)");

    constructor(
        address engine,
        address sideBet,
        address admin,
        uint32 initialScanLimit,
        uint32 initialMaxPayoutsPerCall
    ) {
        if (engine == address(0) || admin == address(0)) revert ZeroAddress();
        if (initialScanLimit == 0) revert InvalidScanLimit();
        if (initialMaxPayoutsPerCall == 0) revert InvalidMaxPayoutsPerCall();

        ENGINE = IRouletteEngine(engine);
        SIDE_BET = ISideBet(sideBet);
        scanLimit = initialScanLimit;
        maxPayoutsPerCall = initialMaxPayoutsPerCall;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCHEDULER_ADMIN_ROLE, admin);
    }

    modifier onlyApprovedAutomationForwarder() {
        if (!IUpkeepForwarderAuthority(forwarderAuthority).isApprovedAutomationForwarder(msg.sender)) {
            revert UnauthorizedAutomationForwarder();
        }
        _;
    }

    function setForwarderAuthority(address newAuthority) external onlyRole(SCHEDULER_ADMIN_ROLE) {
        forwarderAuthority = newAuthority;
        emit ForwarderAuthorityUpdated(newAuthority);
    }

    function setScanLimit(uint32 newScanLimit) external onlyRole(SCHEDULER_ADMIN_ROLE) {
        if (newScanLimit == 0) revert InvalidScanLimit();
        scanLimit = newScanLimit;
        emit ScanLimitUpdated(newScanLimit);
    }

    function setMaxPayoutsPerCall(uint32 newMaxPayoutsPerCall) external onlyRole(SCHEDULER_ADMIN_ROLE) {
        if (newMaxPayoutsPerCall == 0) revert InvalidMaxPayoutsPerCall();
        maxPayoutsPerCall = newMaxPayoutsPerCall;
        emit MaxPayoutsPerCallUpdated(newMaxPayoutsPerCall);
    }

    /// @notice Simulation runs roulette `previewPayoutBundle` or side-bet `previewSettleBundle`; `performUpkeep` applies only.
    /// @dev Roulette: `abi.encode(UpkeepWorkKind.Roulette, lane, job, vaultPayouts, jackpotWinners, jackpotAmounts)`.
    /// Side bet: `abi.encode(UpkeepWorkKind.SideBet, lane, rows, nextCursorBetId, vaultApplies)`.
    function checkUpkeep(
        bytes calldata checkData
    ) public view override returns (bool upkeepNeeded, bytes memory performData) {
        uint256 lane = checkData.length == 0 ? 0 : abi.decode(checkData, (uint256));
        uint32 laneCount = ENGINE.payoutParallelLaneCount();
        if (laneCount == 0) laneCount = 1;
        if (lane >= laneCount) return (false, bytes(""));

        uint32 startCursor = laneCursor[lane];
        uint32 maxSnapshot = maxPayoutsPerCall;

        (bool found, IRouletteEngine.Job memory job) =
            ENGINE.findNextJob(startCursor, scanLimit, uint32(lane), 0);
        if (found) {
            if (job.kind != IRouletteEngine.JobKind.Payout || ENGINE.payoutLaneHasWork(job)) {
                IBankVault.Payout[] memory vaultPayouts;
                address[] memory jackpotWinners;
                uint256[] memory jackpotAmounts;
                if (job.kind == IRouletteEngine.JobKind.Payout) {
                    (vaultPayouts, jackpotWinners, jackpotAmounts) = ENGINE.previewPayoutBundle(job, maxSnapshot);
                }

                performData = abi.encode(
                    UpkeepWorkKind.Roulette, lane, job, vaultPayouts, jackpotWinners, jackpotAmounts
                );
                return (true, performData);
            }
        }

        uint256 cursorBetId = sideBetCursor[lane];
        if (cursorBetId < lane) cursorBetId = lane;

        (ISideBet.SettleRow[] memory rows, uint256 nextCursorBetId, ISideBet.SettleVaultApply[] memory vaultApplies) =
            SIDE_BET.previewSettleBundle(cursorBetId, maxSnapshot, uint32(lane), laneCount);
        if (rows.length == 0) return (false, bytes(""));

        performData = abi.encode(UpkeepWorkKind.SideBet, lane, rows, nextCursorBetId, vaultApplies);
        return (true, performData);
    }

    /// @notice CRE log-trigger entrypoint: accept `VRFResult` / `PayoutProgress` from `ENGINE`, then run `checkUpkeep`.
    function checkLog(
        Log calldata log,
        bytes calldata checkData
    ) external view returns (bool upkeepNeeded, bytes memory performData) {
        if (log.source != address(ENGINE) || log.topics.length == 0) {
            return (false, bytes(""));
        }

        bytes32 topic0 = log.topics[0];
        if (topic0 != VRF_RESULT_TOPIC && topic0 != PAYOUT_PROGRESS_TOPIC) {
            return (false, bytes(""));
        }

        return checkUpkeep(checkData);
    }

    function performUpkeep(bytes calldata performData) external override onlyApprovedAutomationForwarder {
        uint8 kindRaw = abi.decode(performData, (uint8));
        if (kindRaw == uint8(UpkeepWorkKind.Roulette)) {
            (
                ,
                uint256 lane,
                IRouletteEngine.Job memory job,
                IBankVault.Payout[] memory vaultPayouts,
                address[] memory jackpotWinners,
                uint256[] memory jackpotAmounts
            ) = abi.decode(
                performData, (uint8, uint256, IRouletteEngine.Job, IBankVault.Payout[], address[], uint256[])
            );

            uint32 previousCursor = laneCursor[lane];
            laneCursor[lane] = job.nextCursor;
            emit LaneCursorAdvanced(lane, previousCursor, job.nextCursor);

            ENGINE.executeJob(job, vaultPayouts, jackpotWinners, jackpotAmounts);
            return;
        }

        if (kindRaw == uint8(UpkeepWorkKind.SideBet)) {
            (
                ,
                uint256 lane,
                ISideBet.SettleRow[] memory rows,
                uint256 nextCursorBetId,
                ISideBet.SettleVaultApply[] memory vaultApplies
            ) = abi.decode(performData, (uint8, uint256, ISideBet.SettleRow[], uint256, ISideBet.SettleVaultApply[]));

            uint256 previousCursor = sideBetCursor[lane];
            sideBetCursor[lane] = nextCursorBetId;
            emit SideBetCursorAdvanced(lane, previousCursor, nextCursorBetId);

            SIDE_BET.settleBatch(rows, vaultApplies);
        }
    }
}
