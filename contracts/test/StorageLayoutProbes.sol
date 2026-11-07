// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { BankVault4626 } from "../BankVault4626.sol";
import { RouletteEngineStorageLib } from "../libraries/RouletteEngineStorageLib.sol";

/// @dev TEST ONLY. Exposes the ERC-7201 namespaced structs as ordinary state so the compiler's
/// `storageLayout` output describes every member (slot, offset, type, recursively) — same method as
/// `reports/incident-2026-11-04/storage-validation.json` (`IncidentStorageProbe`).
contract EngineStorageLayoutProbe {
    RouletteEngineStorageLib.Layout internal data;
}

/// @dev TEST ONLY. See `EngineStorageLayoutProbe`.
contract VaultStorageLayoutProbe {
    BankVault4626.BankVaultStorage internal data;
}
