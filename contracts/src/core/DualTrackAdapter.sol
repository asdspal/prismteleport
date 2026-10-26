// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMUSDSavingsGauge} from "../interfaces/IMezoCore.sol";

contract DualTrackAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum TrackMode {
        UNSTAKED_SMUSD,
        GAUGE_STAKED_MEZO
    }

    uint256 public constant SWITCH_HYSTERESIS_BPS = 50;

    IERC20 public immutable smusd;
    IERC20 public immutable mezo;
    IMUSDSavingsGauge public immutable gauge;

    address public tokenizer;
    TrackMode public activeMode;
    uint256 public unstakedFeeAprBps;
    uint256 public gaugeMezoAprBps;

    event TrackModeSwitched(
        TrackMode indexed previousMode, TrackMode indexed newMode, uint256 unstakedAprBps, uint256 gaugeAprBps
    );
    event GaugeRewardsHarvested(uint256 mezoAmount);
    event TokenizerInitialized(address indexed tokenizer);
    event AprsUpdated(uint256 unstakedAprBps, uint256 gaugeAprBps);

    constructor(IERC20 _smusd, IERC20 _mezo, IMUSDSavingsGauge _gauge, uint256 _unstakedFeeAprBps) {
        require(address(_smusd) != address(0), "smusd=0");
        require(address(_mezo) != address(0), "mezo=0");
        smusd = _smusd;
        mezo = _mezo;
        gauge = _gauge;
        unstakedFeeAprBps = _unstakedFeeAprBps;
    }

    modifier onlyTokenizer() {
        require(msg.sender == tokenizer, "only tokenizer");
        _;
    }

    function initializeTokenizer(address _tokenizer) external {
        require(tokenizer == address(0), "already initialized");
        require(_tokenizer != address(0), "tokenizer=0");
        tokenizer = _tokenizer;
        emit TokenizerInitialized(_tokenizer);
    }

    function setAprs(uint256 _gaugeMezoAprBps, uint256 _unstakedFeeAprBps) external onlyTokenizer {
        gaugeMezoAprBps = _gaugeMezoAprBps;
        unstakedFeeAprBps = _unstakedFeeAprBps;
        emit AprsUpdated(_unstakedFeeAprBps, _gaugeMezoAprBps);
    }

    function depositSmusd(uint256 smusdAmount) external nonReentrant onlyTokenizer {
        require(smusdAmount != 0, "amount=0");
        smusd.safeTransferFrom(msg.sender, address(this), smusdAmount);
        if (activeMode == TrackMode.GAUGE_STAKED_MEZO) _stake(smusdAmount);
    }

    function withdrawSmusd(uint256 smusdAmount, address to) external nonReentrant onlyTokenizer {
        require(smusdAmount != 0, "amount=0");
        require(to != address(0), "to=0");

        if (activeMode == TrackMode.GAUGE_STAKED_MEZO) {
            uint256 liquid = smusd.balanceOf(address(this));
            // forge-lint: disable-next-line(reentrancy-no-eth)
            if (liquid < smusdAmount) gauge.withdraw(smusdAmount - liquid);
        }

        smusd.safeTransfer(to, smusdAmount);
    }

    function harvestGaugeRewards() external nonReentrant returns (uint256 mezoHarvested) {
        require(address(gauge) != address(0), "gauge=0");
        require(tokenizer != address(0), "tokenizer not set");

        uint256 before = mezo.balanceOf(address(this));
        // forge-lint: disable-next-line(reentrancy-no-eth, unused-return)
        gauge.getReward();
        mezoHarvested = mezo.balanceOf(address(this)) - before;
        if (mezoHarvested != 0) mezo.safeTransfer(tokenizer, mezoHarvested);
        // forge-lint: disable-next-line(reentrancy-events)
        emit GaugeRewardsHarvested(mezoHarvested);
    }

    function evaluateAndSwitchMode() external nonReentrant returns (TrackMode newMode) {
        TrackMode previous = activeMode;
        uint256 gaugeApr = gaugeMezoAprBps;
        uint256 unstakedApr = unstakedFeeAprBps;

        if (address(gauge) == address(0) || gaugeApr + SWITCH_HYSTERESIS_BPS < unstakedApr) {
            if (previous == TrackMode.GAUGE_STAKED_MEZO) {
                _unstakeAll();
                activeMode = TrackMode.UNSTAKED_SMUSD;
            }
        } else if (gaugeApr >= unstakedApr + SWITCH_HYSTERESIS_BPS) {
            if (previous == TrackMode.UNSTAKED_SMUSD) {
                _stakeAll();
                activeMode = TrackMode.GAUGE_STAKED_MEZO;
            }
        }

        newMode = activeMode;
        if (newMode != previous) {
            // forge-lint: disable-next-line(reentrancy-events)
            emit TrackModeSwitched(previous, newMode, unstakedApr, gaugeApr);
        }
    }

    function totalSmusdControlled() external view returns (uint256) {
        uint256 liquid = smusd.balanceOf(address(this));
        if (address(gauge) == address(0)) return liquid;
        return liquid + gauge.balanceOf(address(this));
    }

    function _stakeAll() internal {
        uint256 balance = smusd.balanceOf(address(this));
        if (balance != 0) _stake(balance);
    }

    function _stake(uint256 amount) internal {
        smusd.forceApprove(address(gauge), amount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        gauge.deposit(amount);
    }

    function _unstakeAll() internal {
        uint256 balance = gauge.balanceOf(address(this));
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (balance != 0) gauge.withdraw(balance);
    }
}
