// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRoulette } from "./interfaces/IRoulette.sol";

library RouletteLib {
    /**
     * @dev Safety buffer constant (110% = 10% safety buffer)
     */
    uint256 internal constant SAFETY_BUFFER_BPS = 11000;
    
    /**
     * @dev Struct for optimized maxPayout calculation components
     */
    struct MaxPayoutComponents {
        uint256 straightComponent;
        uint256 streetComponent;
        uint256 redBlackComponent;
        uint256 oddEvenComponent;
        uint256 lowHighComponent;
        uint256 dozenComponent;
        uint256 columnComponent;
        uint256 otherComponent;
    }
    

    struct WinningBetTypes {
        // INSIDE BETS
        uint256[] winningSplits;    // Split IDs that win
        uint256 winningStreets;   // Street numbers that win  
        uint256[] winningCorners;   // Corner IDs that win
        uint256[] winningLines;     // Line IDs that win
        uint256 winningColumn;    // Column ID that wins (1-3)
        uint256 winningDozen;     // Dozen ID that wins (1-3)
        bool red;
        bool black;
        bool odd;
        bool even;
        bool low;
        bool high;
        bool trio012;
        bool trio023;
    }

    function max(uint256 x, uint256 y) internal pure returns (uint256 z) {
        /// @solidity memory-safe-assembly
        assembly {
            z := xor(x, mul(xor(x, y), gt(y, x)))
        }
    }

    function max3(uint256 x, uint256 y, uint256 z) internal pure returns (uint256) {
        return max(max(x, y), z);
    }

    /**
     * @dev Determine ALL winning bet sections for a given number (COMPLETE CASINO DEALER LOGIC)
     */
    function getWinningBetTypes(uint256 winningNumber) public pure returns (WinningBetTypes memory) {
        WinningBetTypes memory winning;
        
        // OUTSIDE BETS (simple)
        winning.red = isRedNumber(winningNumber);
        winning.black = !isRedNumber(winningNumber) && winningNumber != 0;
        winning.odd = winningNumber > 0 && winningNumber % 2 == 1;
        winning.even = winningNumber > 0 && winningNumber % 2 == 0;
        winning.low = winningNumber >= 1 && winningNumber <= 18;
        winning.high = winningNumber >= 19 && winningNumber <= 36;
        
        // COLUMN & DOZEN (if not zero)
        if (winningNumber > 0) {
            winning.winningColumn = ((winningNumber - 1) % 3) + 1; // 1, 2, or 3
            winning.winningDozen = ((winningNumber - 1) / 12) + 1;  // 1, 2, or 3
        }
        
        winning.trio012 = isTrio012Number(winningNumber);
        winning.trio023 = isTrio023Number(winningNumber);
        
        // INSIDE BETS (complex - determine which splits, streets, corners, lines win)
        winning.winningSplits = getWinningSplits(winningNumber);
        winning.winningStreets = getWinningStreets(winningNumber);
        winning.winningCorners = getWinningCorners(winningNumber);
        winning.winningLines = getWinningLines(winningNumber);
        
        return winning;
    }
    
    /**
     * @dev Get all splits that include this number
     */
    function getWinningSplits(uint256 num) private pure returns (uint256[] memory) {
        uint256[] memory splits = new uint256[](4); // Max 4 splits per number (2 horizontal + 2 vertical)
        uint256 count;
        
        if (num == 0) return new uint256[](0); // Zero has no splits
        
        // Horizontal splits (left-right)
        if (num % 3 != 0 && num < 36) splits[count++] = getSplitId(num, num + 1);
        if (num % 3 != 1 && num > 1) splits[count++] = getSplitId(num - 1, num);
        
        // Vertical splits (up-down)  
        if (num <= 33) splits[count++] = getSplitId(num, num + 3);
        if (num >= 4) splits[count++] = getSplitId(num - 3, num);
        
        // Use assembly to resize array instead of copying
        assembly {
            mstore(splits, count)
        }
        return splits;
    }
    
    /**
     * @dev Get street number for this number
     */
    function getWinningStreets(uint256 num) private pure returns (uint256) {
        if (num == 0) return 0; // Zero has no standard street
        
        return ((num - 1) / 3) * 3 + 1; // First number of the street
    }
    
    /**
     * @dev Get all corners that include this number
     */
    function getWinningCorners(uint256 num) private pure returns (uint256[] memory) {
        uint256[] memory corners = new uint256[](4);
        uint256 count;
        
        unchecked {
        // Special case: 0-1-2-3 corner (corner ID 0)
        if (num == 0 || num == 1 || num == 2 || num == 3) {
            corners[count++] = 0; // Special 0-1-2-3 corner
        }
        
        // For numbers 1-36, find all valid 2x2 corners that contain this number
        // Corner ID = top-left number of the 2x2 square
        
            if (num >= 1 && num <= 36) {
                // Top-left corner (num is bottom-right of 2x2 square)
                // Example: num=5, corner is 1-2-4-5, so corner ID = 1
                if (num >= 4 && num <= 36 && (num - 1) % 3 != 0) {
                    corners[count++] = num - 4; // Top-left of corner
                }

                // Top-right corner (num is bottom-left of 2x2 square)  
                // Example: num=5, corner is 2-3-5-6, so corner ID = 2
                if (num >= 4 && num <= 36 && num % 3 != 0) {
                    corners[count++] = num - 3; // Top-left of corner
                }

                // Bottom-left corner (num is top-right of 2x2 square)
                // Example: num=5, corner is 4-5-7-8, so corner ID = 4
                if (num >= 1 && num <= 33 && (num - 1) % 3 != 0) {
                    corners[count++] = num - 1; // Top-left of corner
                }

                // Bottom-right corner (num is top-left of 2x2 square)
                // Example: num=5, corner is 5-6-8-9, so corner ID = 5
                if (num >= 1 && num <= 33 && num % 3 != 0) {
                    corners[count++] = num; // Top-left of corner
                }
            }
        }
        
        // Use assembly to resize array instead of copying
        assembly {
            mstore(corners, count)
        }
        return corners;
    }
    
    /**
     * @dev Get lines that include this number  
     */
    function getWinningLines(uint256 num) private pure returns (uint256[] memory) {
        unchecked {
            if (num == 0) return new uint256[](0);

            uint256[] memory lines = new uint256[](2); // Max 2 lines per number
            uint256 count;                               
            uint256 streetStart = ((num - 1) / 3) * 3 + 1; // First number of the street num is in

            // Line that starts with the current street (e.g., if num is 4, this is 4-9 line)
            if (streetStart <= 31) { // Line must not go beyond number 36 (31,32,33,34,35,36 is last line) 
                lines[count++] = streetStart;
            }

            // Line that ends with the current street (e.g., if num is 4, this is 1-6 line)
            if (streetStart > 1 && (streetStart - 3) >= 1) { // Line must not start before 1 (1,2,3,4,5,6 is first line)
                lines[count++] = streetStart - 3; // Line starts at the first number of the previous street
            }

            // Use assembly to resize array to actual size
            assembly {
                mstore(lines, count)
            }
            return lines;
        }
    }
    
    /**
     * @dev Generate split ID for two numbers
     */
    function getSplitId(uint256 num1, uint256 num2) private pure returns (uint256) {
        unchecked {
            return num1 < num2 ? num1 * 100 + num2 : num2 * 100 + num1;
        }
    }
    
    /**
     * @dev Validate if a split ID represents a valid adjacent pair of numbers
     */
    function isValidSplit(uint256 splitId) internal pure returns (bool) {
        unchecked {
            if (splitId > 3636 || splitId < 100) return false; // Maximum valid split ID is 3536 (35-36)

            uint256 num1 = splitId / 100;
            uint256 num2 = splitId % 100;

            // Both numbers must be 0-36
            if (num1 > 36 || num2 > 36) return false;

            // Check if they are adjacent (horizontal or vertical)
            bool horizontalAdjacent = (num1 + 1 == num2) && (num1 % 3 != 0); // Same row, next column
            bool verticalAdjacent = (num1 + 3 == num2) && (num1 <= 33); // Next row, same column

            return horizontalAdjacent || verticalAdjacent;
        }
    }
    
    /**
     * @dev Validate if a corner ID represents a valid 2x2 square
     */
    function isValidCorner(uint256 cornerId) internal pure returns (bool) {
        unchecked {
            if (cornerId == 0) return true; // Special case for 0-1-2-3 corner

            // For regular corners, the ID should be the top-left number of a 2x2 square
            if (cornerId < 1 || cornerId > 33) return false;

            // Check if it's a valid top-left corner (not in the rightmost column)
            // and ensure the 2x2 square doesn't go beyond the table
            return cornerId % 3 != 0 && cornerId <= 33;
        }
    }
    
    /**
     * @dev Check if number is red (bitmap lookup — single bitwise op instead of 18 comparisons)
     * Red numbers: 1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
     */
    uint256 private constant RED_BITMAP =
        (1 << 1) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 9) |
        (1 << 12) | (1 << 14) | (1 << 16) | (1 << 18) | (1 << 19) |
        (1 << 21) | (1 << 23) | (1 << 25) | (1 << 27) | (1 << 30) |
        (1 << 32) | (1 << 34) | (1 << 36);

    function isRedNumber(uint256 num) private pure returns (bool) {
        return num <= 36 && (RED_BITMAP & (1 << num)) != 0;
    }
    
    /**
     * @dev Check if number is part of the 0-1-2 trio
     */
    function isTrio012Number(uint256 num) private pure returns (bool) {
        unchecked {
            return num == 0 || num == 1 || num == 2;
        }
    }

    /**
     * @dev Check if number is part of the 0-2-3 trio
     */
    function isTrio023Number(uint256 num) private pure returns (bool) {
        unchecked {
            return num == 0 || num == 2 || num == 3;
        }
    }
    
    /**
     * @dev Calculate straight and street components
     */
    function calculateStraightStreetComponents(
        uint256 roundId,
        mapping(uint256 => uint256) storage maxStraightBet,
        mapping(uint256 => uint256) storage maxStreetBet
    ) internal view returns (uint256) {
        unchecked {
            return (maxStraightBet[roundId] * 36) + (maxStreetBet[roundId] * 12);
        }
    }
    
    /**
     * @dev Calculate pair components (red/black, odd/even, low/high)
     */
    function calculatePairComponents(
        uint256 roundId,
        mapping(uint256 => uint256) storage redBetsSum,
        mapping(uint256 => uint256) storage blackBetsSum,
        mapping(uint256 => uint256) storage oddBetsSum,
        mapping(uint256 => uint256) storage evenBetsSum,
        mapping(uint256 => uint256) storage lowBetsSum,
        mapping(uint256 => uint256) storage highBetsSum
    ) internal view returns (uint256) {
        unchecked {
            uint256 redBlackComponent = max(redBetsSum[roundId], blackBetsSum[roundId]) * 2;
            uint256 oddEvenComponent = max(oddBetsSum[roundId], evenBetsSum[roundId]) * 2;
            uint256 lowHighComponent = max(lowBetsSum[roundId], highBetsSum[roundId]) * 2;
            return redBlackComponent + oddEvenComponent + lowHighComponent;
        }
    }
    
    /**
     * @dev Calculate optimized maxPayout components part 2 (dozens, columns, other)
     * @param roundId Round ID to calculate maxPayout for
     * @param dozenBetsSum Storage reference
     * @param columnBetsSum Storage reference
     * @return Sum of dozen, column, and other components
     */
    function calculateMaxPayoutPart2(
        uint256 roundId,
        mapping(uint256 => mapping(uint256 => uint256)) storage dozenBetsSum,
        mapping(uint256 => mapping(uint256 => uint256)) storage columnBetsSum
    ) internal view returns (uint256) {
        unchecked {
            uint256 dozenComponent = max3(
                dozenBetsSum[roundId][1],
                dozenBetsSum[roundId][2],
                dozenBetsSum[roundId][3]
            ) * 3;
            
            uint256 columnComponent = max3(
                columnBetsSum[roundId][1],
                columnBetsSum[roundId][2],
                columnBetsSum[roundId][3]
            ) * 3;
            
            return dozenComponent + columnComponent;
        }
    }
    
}
