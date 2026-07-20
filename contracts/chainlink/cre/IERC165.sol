// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev ERC-165 interface (from OpenZeppelin, vendored for CRE receiver compatibility).
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
