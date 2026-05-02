// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { AutomationCompatibleInterface } from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IUpkeepScheduler } from "./interfaces/IUpkeepScheduler.sol";
import { UpkeepCodecLib } from "./libraries/UpkeepCodecLib.sol";

contract UpkeepScheduler is AccessControl, AutomationCompatibleInterface, IUpkeepScheduler {
    bytes32 public constant SCHEDULER_ADMIN_ROLE = keccak256("SCHEDULER_ADMIN_ROLE");

    IRouletteEngine public immutable ENGINE;
    uint32 public override scanLimit;
    uint32 public override maxPayoutsPerCall;

    mapping(uint256 lane => uint32 cursor) public laneCursor;

    error ZeroAddress();
    error InvalidScanLimit();
    error InvalidMaxPayoutsPerCall();

    event ScanLimitUpdated(uint32 newScanLimit);
    event MaxPayoutsPerCallUpdated(uint32 newMaxPayoutsPerCall);
    event LaneCursorAdvanced(uint256 lane, uint32 previousCursor, uint32 newCursor);

    constructor(address engine, address admin, uint32 initialScanLimit, uint32 initialMaxPayoutsPerCall) {
        if (engine == address(0) || admin == address(0)) revert ZeroAddress();
        if (initialScanLimit == 0) revert InvalidScanLimit();
        if (initialMaxPayoutsPerCall == 0) revert InvalidMaxPayoutsPerCall();

        ENGINE = IRouletteEngine(engine);
        scanLimit = initialScanLimit;
        maxPayoutsPerCall = initialMaxPayoutsPerCall;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCHEDULER_ADMIN_ROLE, admin);
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

    function checkUpkeep(
        bytes calldata checkData
    ) external view override returns (bool upkeepNeeded, bytes memory performData) {
        uint256 lane = checkData.length == 0 ? 0 : abi.decode(checkData, (uint256));
        uint32 startCursor = laneCursor[lane];

        (bool found, IRouletteEngine.Job memory job) = ENGINE.findNextJob(startCursor, scanLimit);
        if (!found) {
            return (false, bytes(""));
        }
        return (true, abi.encode(lane, UpkeepCodecLib.encodeJob(job)));
    }

    function performUpkeep(bytes calldata performData) external override {
        (uint256 lane, bytes memory encodedJob) = abi.decode(performData, (uint256, bytes));
        IRouletteEngine.Job memory job = UpkeepCodecLib.decodeJob(encodedJob);

        uint32 previousCursor = laneCursor[lane];
        laneCursor[lane] = job.nextCursor;
        emit LaneCursorAdvanced(lane, previousCursor, job.nextCursor);

        ENGINE.executeJob(job, maxPayoutsPerCall);
    }
}
