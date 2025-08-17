// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OnTokenTransferTest {
    address public _from;
    uint256 public _value;
    bytes public _data;
    
    function onTokenTransfer(address from, uint256 wad, bytes calldata data) external returns (bool) {
        _from = from;
        _value = wad;
        _data = data;
        return true;
    }
}