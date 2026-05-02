// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

library RouletteBetLib {
    struct WinningBetTypes {
        uint256[] winningSplits;
        uint256 winningStreet;
        uint256[] winningCorners;
        uint256[] winningLines;
        uint256 winningColumn;
        uint256 winningDozen;
        bool red;
        bool black;
        bool odd;
        bool even;
        bool low;
        bool high;
        bool trio012;
        bool trio023;
    }

    function getWinningBetTypes(uint256 winningNumber) internal pure returns (WinningBetTypes memory winning) {
        winning.red = _isRedNumber(winningNumber);
        winning.black = !_isRedNumber(winningNumber) && winningNumber != 0;
        winning.odd = winningNumber > 0 && winningNumber % 2 == 1;
        winning.even = winningNumber > 0 && winningNumber % 2 == 0;
        winning.low = winningNumber >= 1 && winningNumber <= 18;
        winning.high = winningNumber >= 19 && winningNumber <= 36;
        winning.trio012 = winningNumber == 0 || winningNumber == 1 || winningNumber == 2;
        winning.trio023 = winningNumber == 0 || winningNumber == 2 || winningNumber == 3;

        if (winningNumber > 0) {
            winning.winningColumn = ((winningNumber - 1) % 3) + 1;
            winning.winningDozen = ((winningNumber - 1) / 12) + 1;
            winning.winningStreet = ((winningNumber - 1) / 3) * 3 + 1;
        }

        winning.winningSplits = _getWinningSplits(winningNumber);
        winning.winningCorners = _getWinningCorners(winningNumber);
        winning.winningLines = _getWinningLines(winningNumber);
    }

    function isValidSplit(uint256 splitId) internal pure returns (bool) {
        if (splitId > 3636 || splitId < 100) return false;
        uint256 num1 = splitId / 100;
        uint256 num2 = splitId % 100;
        if (num1 > 36 || num2 > 36) return false;
        bool horizontalAdjacent = (num1 + 1 == num2) && (num1 % 3 != 0);
        bool verticalAdjacent = (num1 + 3 == num2) && (num1 <= 33);
        return horizontalAdjacent || verticalAdjacent;
    }

    function isValidCorner(uint256 cornerId) internal pure returns (bool) {
        if (cornerId == 0) return true;
        if (cornerId < 1 || cornerId > 33) return false;
        return cornerId % 3 != 0;
    }

    function _getWinningSplits(uint256 num) private pure returns (uint256[] memory splits) {
        splits = new uint256[](4);
        uint256 count;
        if (num == 0) {
            assembly {
                mstore(splits, 0)
            }
            return splits;
        }
        if (num % 3 != 0 && num < 36) splits[count++] = _getSplitId(num, num + 1);
        if (num % 3 != 1 && num > 1) splits[count++] = _getSplitId(num - 1, num);
        if (num <= 33) splits[count++] = _getSplitId(num, num + 3);
        if (num >= 4) splits[count++] = _getSplitId(num - 3, num);
        assembly {
            mstore(splits, count)
        }
    }

    function _getWinningCorners(uint256 num) private pure returns (uint256[] memory corners) {
        corners = new uint256[](5);
        uint256 count;
        if (num == 0 || num == 1 || num == 2 || num == 3) corners[count++] = 0;

        if (num >= 1 && num <= 36) {
            if (num >= 4 && (num - 1) % 3 != 0) corners[count++] = num - 4;
            if (num >= 4 && num % 3 != 0) corners[count++] = num - 3;
            if (num <= 33 && (num - 1) % 3 != 0) corners[count++] = num - 1;
            if (num <= 33 && num % 3 != 0) corners[count++] = num;
        }

        assembly {
            mstore(corners, count)
        }
    }

    function _getWinningLines(uint256 num) private pure returns (uint256[] memory lines) {
        lines = new uint256[](2);
        uint256 count;
        if (num == 0) {
            assembly {
                mstore(lines, 0)
            }
            return lines;
        }

        uint256 streetStart = ((num - 1) / 3) * 3 + 1;
        if (streetStart <= 31) lines[count++] = streetStart;
        if (streetStart > 1) lines[count++] = streetStart - 3;
        assembly {
            mstore(lines, count)
        }
    }

    function _getSplitId(uint256 num1, uint256 num2) private pure returns (uint256) {
        return num1 < num2 ? num1 * 100 + num2 : num2 * 100 + num1;
    }

    function _isRedNumber(uint256 num) private pure returns (bool) {
        return (num == 1 ||
            num == 3 ||
            num == 5 ||
            num == 7 ||
            num == 9 ||
            num == 12 ||
            num == 14 ||
            num == 16 ||
            num == 18 ||
            num == 19 ||
            num == 21 ||
            num == 23 ||
            num == 25 ||
            num == 27 ||
            num == 30 ||
            num == 32 ||
            num == 34 ||
            num == 36);
    }
}
