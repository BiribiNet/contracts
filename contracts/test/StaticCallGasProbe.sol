// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev TEST ONLY. Measures the gas of one view call in a single `eth_call` (no `eth_estimateGas` binary
/// search), e.g. `previewPayoutBundle` walking 1 024 mask legs.
contract StaticCallGasProbe {
    error ProbeCallFailed();

    function measure(address target, bytes calldata data) external view returns (uint256 gasUsed) {
        uint256 before = gasleft();
        (bool ok,) = target.staticcall(data);
        gasUsed = before - gasleft();
        if (!ok) revert ProbeCallFailed();
    }
}
