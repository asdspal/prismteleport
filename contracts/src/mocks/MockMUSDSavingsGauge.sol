// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMUSDSavingsGauge} from "../interfaces/IMezoCore.sol";

contract MockMUSDSavingsGauge is IMUSDSavingsGauge {
    using SafeERC20 for IERC20;

    IERC20 public immutable smusd;
    IERC20 public immutable mezo;

    uint256 public rewardRate;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public rewards;

    constructor(IERC20 _smusd, IERC20 _mezo) {
        smusd = _smusd;
        mezo = _mezo;
    }

    function setRewardRate(uint256 rate) external {
        rewardRate = rate;
    }

    function notifyReward(address account, uint256 amount) external {
        rewards[account] += amount;
    }

    function deposit(uint256 amount) external {
        smusd.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        smusd.safeTransfer(msg.sender, amount);
    }

    function getReward() external returns (uint256 amount) {
        amount = rewards[msg.sender];
        rewards[msg.sender] = 0;
        if (amount != 0) mezo.safeTransfer(msg.sender, amount);
    }
}
