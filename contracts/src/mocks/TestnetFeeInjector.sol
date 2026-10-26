// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TestnetFeeInjector
/// @notice Testnet stand-in for Mezo's MUSD Savings Rate (sMUSD) vault.
/// @dev Mainnet sMUSD is not ERC-4626: deposits and withdrawals are 1:1 and yield is
///      claimed separately through a cumulative `yieldIndex`. This adapter mirrors that
///      ABI so PrismTokenizer uses one interface on both networks, and adds
///      `injectWeeklyFeeYield` so judges can simulate a weekly protocol fee drop.
///      Gas (Foundry, cold storage): deposit ~70k, injectWeeklyFeeYield ~52k.
contract TestnetFeeInjector is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant FEE_BPS_DENOMINATOR = 10_000;
    uint256 public constant INJECTION_COOLDOWN = 60;

    IERC20 public immutable musdToken;

    uint256 public yieldIndex;
    uint256 public totalClaimable;
    uint256 public lastInjection;
    mapping(address => uint256) public userYieldIndex;
    mapping(address => uint256) internal storedClaimable;

    event WeeklyFeeYieldInjected(address indexed caller, uint256 musdAmount, uint256 newYieldIndex);
    event YieldClaimed(address indexed user, uint256 amount);

    constructor(IERC20 musd) ERC20("Testnet sMUSD", "tsMUSD") {
        require(address(musd) != address(0), "musd=0");
        musdToken = musd;
    }

    /// @notice Deposit MUSD and mint tsMUSD 1:1.
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        _settle(msg.sender);
        musdToken.safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
    }

    /// @notice Burn tsMUSD and return MUSD 1:1.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        _settle(msg.sender);
        _burn(msg.sender, amount);
        musdToken.safeTransfer(msg.sender, amount);
    }

    /// @notice Simulate one weekly protocol fee distribution, capped at 5% of supply.
    function injectWeeklyFeeYield(uint256 musdAmount) public nonReentrant {
        require(musdAmount > 0, "amount=0");
        uint256 supply = totalSupply();
        require(supply > 0, "no supply");
        require(musdAmount <= (supply * MAX_FEE_BPS) / FEE_BPS_DENOMINATOR, "fee cap");
        if (lastInjection != 0) {
            // forge-lint: disable-next-line(block-timestamp)
            require(block.timestamp >= lastInjection + INJECTION_COOLDOWN, "cooldown");
        }

        musdToken.safeTransferFrom(msg.sender, address(this), musdAmount);
        lastInjection = block.timestamp;
        _distribute(musdAmount);
        emit WeeklyFeeYieldInjected(msg.sender, musdAmount, yieldIndex);
    }

    /// @notice Permissionless hook matching canonical sMUSD; routes through the capped simulator.
    function receiveProtocolYield(uint256 amount) external {
        injectWeeklyFeeYield(amount);
    }

    /// @notice Distribute any MUSD held above principal plus unclaimed yield.
    function receiveYieldFromStrategy() external {
        uint256 balance = musdToken.balanceOf(address(this));
        uint256 liabilities = totalSupply() + totalClaimable;
        if (balance > liabilities) {
            _distribute(balance - liabilities);
        }
    }

    /// @notice Claim accrued MUSD yield.
    function claimYield() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);
        amount = storedClaimable[msg.sender];
        if (amount == 0) return 0;

        storedClaimable[msg.sender] = 0;
        totalClaimable -= amount;
        musdToken.safeTransfer(msg.sender, amount);
        emit YieldClaimed(msg.sender, amount);
    }

    /// @notice Yield accrued to `user`, including yield not yet settled.
    function claimableYield(address user) public view returns (uint256) {
        uint256 accrued = (balanceOf(user) * (yieldIndex - userYieldIndex[user])) / 1e18;
        return storedClaimable[user] + accrued;
    }

    /// @notice Total MUSD value of one share, including unclaimed yield, scaled by 1e18.
    function yieldPerShare() external view returns (uint256) {
        return 1e18 + yieldIndex;
    }

    /// @notice Canonical sMUSD getter; the adapter has no separate strategy.
    function yieldToken() external view returns (address) {
        return address(musdToken);
    }

    function _distribute(uint256 amount) internal {
        uint256 supply = totalSupply();
        uint256 increment = (amount * 1e18) / supply;
        if (increment > 0) {
            yieldIndex += increment;
            // forge-lint: disable-next-line(divide-before-multiply)
            totalClaimable += (increment * supply) / 1e18;
        }
    }

    function _settle(address user) internal {
        uint256 balance = balanceOf(user);
        if (balance == 0) {
            userYieldIndex[user] = yieldIndex;
            return;
        }

        uint256 accrued = (balance * (yieldIndex - userYieldIndex[user])) / 1e18;
        userYieldIndex[user] = yieldIndex;
        if (accrued > 0) storedClaimable[user] += accrued;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) _settle(from);
        if (to != address(0) && to != from) _settle(to);
        super._update(from, to, value);
    }
}
