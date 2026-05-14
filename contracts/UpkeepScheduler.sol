// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { AutomationCompatibleInterface } from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IUpkeepForwarderAuthority } from "./interfaces/IUpkeepForwarderAuthority.sol";
import { IUpkeepScheduler } from "./interfaces/IUpkeepScheduler.sol";

contract UpkeepScheduler is AccessControl, AutomationCompatibleInterface, IUpkeepScheduler {
    bytes32 public constant SCHEDULER_ADMIN_ROLE = keccak256("SCHEDULER_ADMIN_ROLE");

    IRouletteEngine public immutable ENGINE;
    uint32 public override scanLimit;
    uint32 public override maxPayoutsPerCall;

    mapping(uint256 lane => uint32 cursor) public laneCursor;

    /// @dev `address(0)` = any caller (tests / local tooling). Non-zero `forwarderAuthority`: only approved Automation forwarders.
    address public forwarderAuthority;

    error ZeroAddress();
    error InvalidScanLimit();
    error InvalidMaxPayoutsPerCall();
    error UnauthorizedAutomationForwarder();

    event ScanLimitUpdated(uint32 newScanLimit);
    event MaxPayoutsPerCallUpdated(uint32 newMaxPayoutsPerCall);
    event LaneCursorAdvanced(uint256 lane, uint32 previousCursor, uint32 newCursor);
    event ForwarderAuthorityUpdated(address authority);

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

    modifier onlyApprovedAutomationForwarder() {
        address auth = forwarderAuthority;
        if (auth != address(0)) {
            if (!IUpkeepForwarderAuthority(auth).isApprovedAutomationForwarder(msg.sender)) {
                revert UnauthorizedAutomationForwarder();
            }
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

    /// @notice Simulation step for Chainlink Automation: selects the next `ENGINE` job (`findNextJob`).
    /// @dev `abi.encode(lane, job, payouts, maxPayoutsSnapshot)` — `payouts` is always empty; the engine builds winner rows
    /// on-chain in `executeJob`. Snapshot still ties `maxPayoutsPerCall` across `checkUpkeep` / `performUpkeep`.
    /// Only automation lane `0` is used (parallel payout lanes removed).
    function checkUpkeep(
        bytes calldata checkData
    ) external view override returns (bool upkeepNeeded, bytes memory performData) {
        uint256 lane = checkData.length == 0 ? 0 : abi.decode(checkData, (uint256));
        if (lane != 0) return (false, bytes(""));

        uint32 startCursor = laneCursor[0];
        uint32 maxSnapshot = maxPayoutsPerCall;

        (bool found, IRouletteEngine.Job memory job) = ENGINE.findNextJob(startCursor, scanLimit);
        if (!found) {
            return (false, bytes(""));
        }

        IBankVault.Payout[] memory payouts = new IBankVault.Payout[](0);

        performData = abi.encode(uint256(0), job, payouts, maxSnapshot);
        return (true, performData);
    }

    function performUpkeep(bytes calldata performData) external override onlyApprovedAutomationForwarder {
        (uint256 lane, IRouletteEngine.Job memory job, IBankVault.Payout[] memory payouts, uint32 maxSnapshot) =
            abi.decode(performData, (uint256, IRouletteEngine.Job, IBankVault.Payout[], uint32));

        uint32 previousCursor = laneCursor[lane];
        laneCursor[lane] = job.nextCursor;
        emit LaneCursorAdvanced(lane, previousCursor, job.nextCursor);

        ENGINE.executeJob(job, maxSnapshot, payouts);
    }
}
