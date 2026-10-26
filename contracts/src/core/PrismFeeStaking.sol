// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMezoPrecompile} from "../interfaces/IMezoCore.sol";

contract PrismFeeStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct StakeInfo {
        uint128 amount;
        uint64 lastStakeTimestamp;
        uint128 rewardDebt;
        uint128 claimableMusd;
    }

    uint256 public constant ACC_PRECISION = 1e18;
    uint256 public constant DISCOUNT_COOLDOWN = 1 hours;
    uint256 public constant TIER_1 = 10e18;
    uint256 public constant TIER_2 = 100e18;
    uint256 public constant TIER_3 = 500e18;
    uint256 public constant DISCOUNT_1_BPS = 1_000;
    uint256 public constant DISCOUNT_2_BPS = 2_500;
    uint256 public constant DISCOUNT_3_BPS = 5_000;

    IERC20 public immutable mezoToken;
    IERC20 public immutable musdToken;

    uint256 public accMusdPerMezo;
    uint256 public totalMezoStaked;
    uint256 public unallocatedMusdBuffer;

    mapping(address => StakeInfo) public stakes;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 musdAmount);
    event FeeRevenueNotified(address indexed source, uint256 musdAmount);

    constructor(IERC20 _mezoToken, IERC20 _musdToken) {
        require(address(_mezoToken) != address(0), "mezo=0");
        require(address(_musdToken) != address(0), "musd=0");
        mezoToken = _mezoToken;
        musdToken = _musdToken;
    }

    function stake(uint256 amount) external nonReentrant {
        _stake(msg.sender, amount);
    }

    function stakeWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        if (v < 27) v += 27;
        bytes memory data = abi.encodeWithSelector(
            IMezoPrecompile.permit.selector, msg.sender, address(this), amount, deadline, v, r, s
        );
        // forge-lint: disable-next-line(reentrancy-no-eth)
        (bool ok, bytes memory ret) = address(mezoToken).call(data);
        require(ok, "permit failed");
        if (ret.length == 32) {
            require(abi.decode(ret, (bool)), "permit denied");
        } else {
            require(ret.length == 0, "permit bad return");
        }
        _stake(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        require(amount != 0, "amount=0");
        StakeInfo storage info = stakes[msg.sender];
        require(amount <= info.amount, "insufficient stake");

        _checkpoint(info);
        // casting to uint128 is safe because amount <= info.amount
        // forge-lint: disable-next-line(unsafe-typecast)
        info.amount = uint128(uint256(info.amount) - amount);
        info.rewardDebt = _toUint128((uint256(info.amount) * accMusdPerMezo) / ACC_PRECISION);
        totalMezoStaked -= amount;

        mezoToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claimRewards() external nonReentrant returns (uint256 amount) {
        StakeInfo storage info = stakes[msg.sender];
        _checkpoint(info);

        amount = info.claimableMusd;
        require(amount != 0, "no rewards");
        info.claimableMusd = 0;

        musdToken.safeTransfer(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    function notifyRewardAmount(uint256 musdAmount) external nonReentrant {
        require(musdAmount != 0, "amount=0");
        musdToken.safeTransferFrom(msg.sender, address(this), musdAmount);

        if (totalMezoStaked == 0) {
            unallocatedMusdBuffer += musdAmount;
        } else {
            uint256 distributable = musdAmount + unallocatedMusdBuffer;
            uint256 accIncrease = (distributable * ACC_PRECISION) / totalMezoStaked;
            accMusdPerMezo += accIncrease;
            // forge-lint: disable-next-line(divide-before-multiply)
            unallocatedMusdBuffer = distributable - (accIncrease * totalMezoStaked) / ACC_PRECISION;
        }

        emit FeeRevenueNotified(msg.sender, musdAmount);
    }

    function getFeeDiscountBps(address user) external view returns (uint256) {
        StakeInfo storage info = stakes[user];
        uint256 amount = info.amount;
        if (amount < TIER_1) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < info.lastStakeTimestamp + DISCOUNT_COOLDOWN) return 0;
        if (amount >= TIER_3) return DISCOUNT_3_BPS;
        if (amount >= TIER_2) return DISCOUNT_2_BPS;
        return DISCOUNT_1_BPS;
    }

    function pendingMusd(address user) external view returns (uint256) {
        StakeInfo storage info = stakes[user];
        return uint256(info.claimableMusd) + (uint256(info.amount) * accMusdPerMezo) / ACC_PRECISION - info.rewardDebt;
    }

    function _stake(address user, uint256 amount) internal {
        require(amount != 0, "amount=0");
        StakeInfo storage info = stakes[user];

        _checkpoint(info);
        mezoToken.safeTransferFrom(user, address(this), amount);

        info.amount = _toUint128(uint256(info.amount) + amount);
        info.rewardDebt = _toUint128((uint256(info.amount) * accMusdPerMezo) / ACC_PRECISION);
        // casting to uint64 is safe because block.timestamp < 2^64 for any realistic chain
        // forge-lint: disable-next-line(unsafe-typecast)
        info.lastStakeTimestamp = uint64(block.timestamp);
        totalMezoStaked += amount;

        // forge-lint: disable-next-line(reentrancy-events)
        emit Staked(user, amount);
    }

    function _toUint128(uint256 value) internal pure returns (uint128) {
        require(value <= type(uint128).max, "uint128 overflow");
        // casting to uint128 is safe because value was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(value);
    }

    function _checkpoint(StakeInfo storage info) internal {
        uint256 accumulated = (uint256(info.amount) * accMusdPerMezo) / ACC_PRECISION;
        uint256 pending = accumulated - info.rewardDebt;
        if (pending != 0) info.claimableMusd = _toUint128(uint256(info.claimableMusd) + pending);
        info.rewardDebt = _toUint128(accumulated);
    }
}
