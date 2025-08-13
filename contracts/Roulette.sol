// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { VRFCoordinatorV2Interface } from "@chainlink/contracts/src/v0.8/interfaces/VRFCoordinatorV2Interface.sol";
import { VRFConsumerBaseV2 } from "@chainlink/contracts/src/v0.8/vrf/VRFConsumerBaseV2.sol";

contract Roulette is AccessControlUpgradeable, VRFConsumerBaseV2, UUPSUpgradeable {
    // Unique storage slot for the struct
    bytes32 internal constant STORAGE_LOCATION = 0x1a77ad5db938f3b6f6a30da412cd3861089fbb3b2776a8e6bd9256af3f612300;
    // Roles
    bytes32 public constant FUNCTIONS_OPERATOR_ROLE = keccak256("FUNCTIONS_OPERATOR_ROLE");
    bytes32 public constant VRF_OPERATOR_ROLE = keccak256("VRF_OPERATOR_ROLE");

    // Struct holding all contract state
    struct RouletteStorage {
        address brbToken;
        bytes32 merkleRoot;
        // VRF config
        address vrfCoordinator;
        bytes32 vrfKeyHash;
        uint64 vrfSubscriptionId;
        uint32 vrfCallbackGasLimit;
        // VRF state
        uint256 lastRequestId;
        uint256 lastRandomWord;
    }

    // Internal function to get storage pointer
    function _rouletteStorage() internal pure returns (RouletteStorage storage storageStruct) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            storageStruct.slot := slot
        }
    }

    // Events
    event MerkleRootUpdated(bytes32 newRoot);
    event Bet(address indexed user, uint256 amount, bytes32[] proof, uint256 currentBalance);
    event VRFRequested(uint256 requestId);
    event VRFFulfilled(uint256 requestId, uint256 randomWord);

    // Constructor for non-upgradeable pattern
    constructor(
        address admin,
        address _brbToken,
        address _functionsOperator,
        address _vrfCoordinator,
        bytes32 _vrfKeyHash,
        uint64 _vrfSubscriptionId,
        uint32 _vrfCallbackGasLimit
    ) VRFConsumerBaseV2(_vrfCoordinator) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FUNCTIONS_OPERATOR_ROLE, _functionsOperator);
        _grantRole(VRF_OPERATOR_ROLE, admin); // Optionally, admin can also be VRF operator
        
        RouletteStorage storage rs = _rouletteStorage();
        rs.brbToken = _brbToken;
        rs.vrfCoordinator = _vrfCoordinator;
        rs.vrfKeyHash = _vrfKeyHash;
        rs.vrfSubscriptionId = _vrfSubscriptionId;
        rs.vrfCallbackGasLimit = _vrfCallbackGasLimit;
    }

    // Access-controlled Merkle root setter
    function setMerkleRoot(bytes32 newRoot) public onlyRole(FUNCTIONS_OPERATOR_ROLE) {
        _rouletteStorage().merkleRoot = newRoot;
        emit MerkleRootUpdated(newRoot);
    }

    // Get the current Merkle root
    function getMerkleRoot() public view returns (bytes32) {
        return _rouletteStorage().merkleRoot;
    }

    // Place a bet with BRB tokens, providing a Merkle proof of current balance
    function bet(uint256 amount, bytes32[] calldata proof, uint256 currentBalance) external {
        address brbToken = _rouletteStorage().brbToken;
        require(IERC20(brbToken).transferFrom(msg.sender, address(this), amount), "Transfer failed");
        emit Bet(msg.sender, amount, proof, currentBalance);
    }

    // Request randomness from Chainlink VRF v2
    function requestRandomness() external onlyRole(VRF_OPERATOR_ROLE) returns (uint256 requestId) {
        RouletteStorage storage rs = _rouletteStorage();
        requestId = VRFCoordinatorV2Interface(rs.vrfCoordinator).requestRandomWords(
            rs.vrfKeyHash,
            rs.vrfSubscriptionId,
            3, // requestConfirmations
            rs.vrfCallbackGasLimit,
            1  // numWords
        );
        rs.lastRequestId = requestId;
        emit VRFRequested(requestId);
    }

    // Chainlink VRF callback
    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        RouletteStorage storage rs = _rouletteStorage();
        rs.lastRandomWord = randomWords[0];
        emit VRFFulfilled(requestId, randomWords[0]);
    }

    function _authorizeUpgrade(address /* newImpl */) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
} 