// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/utils/Create2.sol";

/**
 * @title SimpleCreate2
 * @dev A simple CREATE2 deployment helper using OpenZeppelin's Create2 library
 */
contract SimpleCreate2 {
    event ContractDeployed(address indexed deployed, bytes32 indexed salt);

    /**
     * @dev Compute the address of a contract to be deployed with CREATE2
     * @param salt The salt for CREATE2
     * @param bytecodeHash The keccak256 hash of the contract bytecode
     * @return The predicted address
     */
    function computeAddress(bytes32 salt, bytes32 bytecodeHash) public view returns (address) {
        return Create2.computeAddress(salt, bytecodeHash);
    }

    /**
     * @dev Deploy a contract using CREATE2
     * @param salt The salt for CREATE2
     * @param bytecode The contract bytecode
     * @return The deployed contract address
     */
    function deploy(bytes32 salt, bytes memory bytecode) public payable returns (address) {
        address deployed = Create2.deploy(0, salt, bytecode);
        emit ContractDeployed(deployed, salt);
        return deployed;
    }
}
