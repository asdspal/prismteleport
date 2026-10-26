// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DualTrackAdapter} from "./DualTrackAdapter.sol";
import {PrismPrincipalToken} from "./tokens/PrismPrincipalToken.sol";
import {PrismYieldToken} from "./tokens/PrismYieldToken.sol";
import {PrismSeriesFactory} from "./tokens/PrismSeriesFactory.sol";
import {IMUSDSavingsRate, IPrismFeeStaking} from "../interfaces/IMezoCore.sol";

contract PrismTokenizer is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SECONDS_PER_WEEK = 604800;
    uint256 public constant SMOOTHING_BPS = 5;
    uint256 public constant FEE_BPS = 300;
    uint256 public constant BPS = 10000;
    uint256 public constant ACC_PRECISION = 1e18;

    struct Series {
        uint256 maturity;
        address ptToken;
        address ytToken;
        uint256 totalPt;
        uint256 totalYt;
        uint256 rateAtInit;
        uint256 finalExchangeRate;
        bool finalized;
        uint256 finalAccMusdPerYt;
        uint256 finalAccMezoPerYt;
    }

    IERC20 public immutable musd;
    IMUSDSavingsRate public immutable smusd;
    DualTrackAdapter public immutable adapter;
    PrismSeriesFactory public immutable seriesFactory;
    IPrismFeeStaking public immutable feeStaking;
    IERC20 public immutable mezo;
    address public immutable treasury;
    address public immutable keeper;

    mapping(uint256 => Series) public series;
    uint256[] public maturities;

    uint256 public totalActiveYt;
    uint256 public accMusdPerYt;
    uint256 public accMezoPerYt;

    uint256 public smoothedYieldIndex;
    uint256 public lastYieldIndex;
    uint256 public lastRateYieldIndex;
    uint256 public unvestedRateBuffer;
    uint256 public rateBufferLastUpdate;

    uint256 public unvestedMusdBuffer;
    uint256 public yieldBufferLastUpdate;

    mapping(uint256 => mapping(address => uint256)) public userMusdIndex;
    mapping(uint256 => mapping(address => uint256)) public userMezoIndex;
    mapping(uint256 => mapping(address => uint256)) public claimableMusd;
    mapping(uint256 => mapping(address => uint256)) public claimableMezo;

    event SeriesInitialized(uint256 indexed maturity, address ptToken, address ytToken, uint256 rateAtInit);
    event PyMinted(uint256 indexed maturity, address indexed receiver, uint256 amount);
    event PyRedeemed(uint256 indexed maturity, address indexed user, address indexed receiver, uint256 amount);
    event PtRedeemed(uint256 indexed maturity, address indexed user, address indexed receiver, uint256 amount);
    event YieldPaid(address indexed user, address indexed receiver, uint256 musdAmount, uint256 mezoAmount);
    event MusdYieldDistributed(uint256 amount, uint256 accMusdPerYt);
    event MezoYieldDistributed(uint256 amount, uint256 accMezoPerYt);
    event SeriesFinalized(uint256 indexed maturity, uint256 finalRate);
    event YieldToTreasury(address indexed token, uint256 amount);
    event TrackAprsUpdated(uint256 gaugeMezoAprBps, uint256 unstakedFeeAprBps);

    constructor(
        IERC20 _musd,
        IMUSDSavingsRate _smusd,
        DualTrackAdapter _adapter,
        PrismSeriesFactory _seriesFactory,
        IPrismFeeStaking _feeStaking,
        IERC20 _mezo,
        address _treasury,
        address _keeper
    ) {
        require(address(_musd) != address(0), "musd=0");
        require(address(_smusd) != address(0), "smusd=0");
        require(address(_adapter) != address(0), "adapter=0");
        require(address(_seriesFactory) != address(0), "factory=0");
        require(address(_feeStaking) != address(0), "feeStaking=0");
        require(address(_mezo) != address(0), "mezo=0");
        require(_treasury != address(0), "treasury=0");
        require(_keeper != address(0), "keeper=0");

        musd = _musd;
        smusd = _smusd;
        adapter = _adapter;
        seriesFactory = _seriesFactory;
        feeStaking = _feeStaking;
        mezo = _mezo;
        treasury = _treasury;
        keeper = _keeper;

        uint256 initialYieldIndex = _smusd.yieldIndex();
        smoothedYieldIndex = initialYieldIndex;
        lastYieldIndex = initialYieldIndex;
        lastRateYieldIndex = initialYieldIndex;
        rateBufferLastUpdate = block.timestamp;
        yieldBufferLastUpdate = block.timestamp;

        _adapter.initializeTokenizer(address(this));
    }

    function initializeSeries(uint256 maturity) external returns (address ptToken, address ytToken) {
        // forge-lint: disable-next-line(block-timestamp)
        require(maturity > block.timestamp, "maturity past");
        require(maturity % SECONDS_PER_WEEK == 0, "not thursday");
        require(series[maturity].ptToken == address(0), "series exists");

        uint256 rate = smoothedExchangeRate();
        // forge-lint: disable-next-line(reentrancy-no-eth)
        (ptToken, ytToken) = seriesFactory.createSeries(maturity);

        series[maturity] = Series({
            maturity: maturity,
            ptToken: ptToken,
            ytToken: ytToken,
            totalPt: 0,
            totalYt: 0,
            rateAtInit: rate,
            finalExchangeRate: 0,
            finalized: false,
            finalAccMusdPerYt: 0,
            finalAccMezoPerYt: 0
        });
        maturities.push(maturity);

        // forge-lint: disable-next-line(reentrancy-events)
        emit SeriesInitialized(maturity, ptToken, ytToken, rate);
    }

    function mintPyFromMusd(uint256 musdAmount, uint256 maturity, address receiver)
        external
        nonReentrant
        returns (uint256 pyAmount)
    {
        require(musdAmount != 0, "amount=0");
        require(receiver != address(0), "receiver=0");
        Series storage s = _requireSeries(maturity);
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < maturity, "matured");

        _syncYield();
        musd.safeTransferFrom(msg.sender, address(this), musdAmount);
        musd.forceApprove(address(smusd), musdAmount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        smusd.deposit(musdAmount);
        IERC20(address(smusd)).forceApprove(address(adapter), musdAmount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        adapter.depositSmusd(musdAmount);

        pyAmount = musdAmount;
        _mintPy(s, receiver, pyAmount);
    }

    function mintPyFromSmusd(uint256 smusdAmount, uint256 maturity, address receiver)
        external
        nonReentrant
        returns (uint256 pyAmount)
    {
        require(smusdAmount != 0, "amount=0");
        require(receiver != address(0), "receiver=0");
        Series storage s = _requireSeries(maturity);
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < maturity, "matured");

        _syncYield();
        IERC20(address(smusd)).safeTransferFrom(msg.sender, address(this), smusdAmount);
        IERC20(address(smusd)).forceApprove(address(adapter), smusdAmount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        adapter.depositSmusd(smusdAmount);

        pyAmount = smusdAmount;
        _mintPy(s, receiver, pyAmount);
    }

    function redeemPyBeforeMaturity(uint256 pyAmount, uint256 maturity, address receiver)
        external
        nonReentrant
        returns (uint256 musdYield, uint256 mezoYield)
    {
        require(pyAmount != 0, "amount=0");
        require(receiver != address(0), "receiver=0");
        Series storage s = _requireSeries(maturity);
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < maturity, "matured");

        _syncYield();
        (musdYield, mezoYield) = _settleAndPay(s, msg.sender, receiver);

        // forge-lint: disable-next-line(reentrancy-no-eth)
        PrismPrincipalToken(s.ptToken).burn(msg.sender, pyAmount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        PrismYieldToken(s.ytToken).burn(msg.sender, pyAmount);

        s.totalPt -= pyAmount;
        s.totalYt -= pyAmount;
        totalActiveYt -= pyAmount;
        // forge-lint: disable-next-line(reentrancy-no-eth)
        adapter.withdrawSmusd(pyAmount, receiver);

        // forge-lint: disable-next-line(reentrancy-events)
        emit PyRedeemed(maturity, msg.sender, receiver, pyAmount);
    }

    function redeemPtAfterMaturity(uint256 ptAmount, uint256 maturity, address receiver)
        external
        nonReentrant
        returns (uint256 smusdOut)
    {
        require(ptAmount != 0, "amount=0");
        require(receiver != address(0), "receiver=0");
        Series storage s = _requireSeries(maturity);
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp >= maturity, "not matured");

        _syncYield();
        require(s.totalPt >= ptAmount, "insufficient pt");

        // forge-lint: disable-next-line(reentrancy-no-eth)
        PrismPrincipalToken(s.ptToken).burn(msg.sender, ptAmount);
        s.totalPt -= ptAmount;
        // forge-lint: disable-next-line(reentrancy-no-eth)
        adapter.withdrawSmusd(ptAmount, receiver);

        smusdOut = ptAmount;
        // forge-lint: disable-next-line(reentrancy-events)
        emit PtRedeemed(maturity, msg.sender, receiver, ptAmount);
    }

    function claimYield(uint256 maturity, address receiver)
        external
        nonReentrant
        returns (uint256 netMusd, uint256 netMezo)
    {
        require(receiver != address(0), "receiver=0");
        Series storage s = _requireSeries(maturity);

        _syncYield();
        (netMusd, netMezo) = _settleAndPay(s, msg.sender, receiver);
    }

    function syncYield() external nonReentrant {
        _syncYield();
    }

    function updateTrackAprs(uint256 gaugeMezoAprBps, uint256 unstakedFeeAprBps) external {
        require(msg.sender == keeper, "only keeper");
        adapter.setAprs(gaugeMezoAprBps, unstakedFeeAprBps);
        // forge-lint: disable-next-line(reentrancy-events)
        emit TrackAprsUpdated(gaugeMezoAprBps, unstakedFeeAprBps);
    }

    function evaluateTrackMode() external returns (uint256) {
        return uint256(adapter.evaluateAndSwitchMode());
    }

    function beforeYtTransfer(uint256 maturity, address from, address to) external {
        Series storage s = _requireSeries(maturity);
        require(msg.sender == s.ytToken, "only yt");

        _syncYield();
        _settleUser(s, from);
        _settleUser(s, to);
    }

    function smoothedExchangeRate() public view returns (uint256) {
        uint256 base = smoothedYieldIndex;
        uint256 buffer = unvestedRateBuffer;

        if (buffer != 0) {
            uint256 elapsed = block.timestamp - rateBufferLastUpdate;
            uint256 vested = (buffer * elapsed) / SECONDS_PER_WEEK;
            // forge-lint: disable-next-line(block-timestamp)
            if (vested > buffer) vested = buffer;
            base += vested;
        }

        return 1e18 + base;
    }

    function getActiveMaturities() external view returns (uint256[] memory) {
        return maturities;
    }

    function getSeries(uint256 maturity) external view returns (Series memory) {
        return series[maturity];
    }

    function pendingYield(uint256 maturity, address user)
        external
        view
        returns (uint256 pendingMusd, uint256 pendingMezo)
    {
        Series storage s = series[maturity];
        if (s.ptToken == address(0)) return (0, 0);

        uint256 ytBalance = IERC20(s.ytToken).balanceOf(user);
        uint256 accMusd = _effectiveAccMusd(s);
        uint256 accMezo = _effectiveAccMezo(s);

        pendingMusd =
            claimableMusd[maturity][user] + (ytBalance * (accMusd - userMusdIndex[maturity][user])) / ACC_PRECISION;
        pendingMezo =
            claimableMezo[maturity][user] + (ytBalance * (accMezo - userMezoIndex[maturity][user])) / ACC_PRECISION;
    }

    function _mintPy(Series storage s, address receiver, uint256 amount) internal {
        s.totalPt += amount;
        s.totalYt += amount;

        // forge-lint: disable-next-line(reentrancy-no-eth)
        PrismPrincipalToken(s.ptToken).mint(receiver, amount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        PrismYieldToken(s.ytToken).mint(receiver, amount);
        totalActiveYt += amount;

        // forge-lint: disable-next-line(reentrancy-events)
        emit PyMinted(s.maturity, receiver, amount);
    }

    function _settleAndPay(Series storage s, address user, address receiver)
        internal
        returns (uint256 netMusd, uint256 netMezo)
    {
        _settleUser(s, user);

        uint256 grossMusd = claimableMusd[s.maturity][user];
        uint256 grossMezo = claimableMezo[s.maturity][user];
        claimableMusd[s.maturity][user] = 0;
        claimableMezo[s.maturity][user] = 0;

        netMusd = _payMusd(user, receiver, grossMusd);
        netMezo = _payMezo(user, receiver, grossMezo);

        // forge-lint: disable-next-line(reentrancy-events)
        emit YieldPaid(user, receiver, grossMusd, grossMezo);
    }

    function _payMusd(address user, address receiver, uint256 gross) internal returns (uint256 net) {
        if (gross == 0) return 0;

        uint256 fee = _feeAmount(user, gross);
        net = gross - fee;
        uint256 toStaking = fee / 2;
        uint256 toTreasury = fee - toStaking;

        if (net != 0) musd.safeTransfer(receiver, net);
        if (toStaking != 0) {
            musd.forceApprove(address(feeStaking), toStaking);
            // forge-lint: disable-next-line(reentrancy-no-eth)
            feeStaking.notifyRewardAmount(toStaking);
        }
        if (toTreasury != 0) musd.safeTransfer(treasury, toTreasury);
    }

    function _payMezo(address user, address receiver, uint256 gross) internal returns (uint256 net) {
        if (gross == 0) return 0;

        uint256 fee = _feeAmount(user, gross);
        net = gross - fee;
        uint256 toStaking = fee / 2;
        uint256 toTreasury = fee - toStaking;

        if (net != 0) mezo.safeTransfer(receiver, net);
        if (toStaking != 0) mezo.safeTransfer(address(feeStaking), toStaking);
        if (toTreasury != 0) mezo.safeTransfer(treasury, toTreasury);
    }

    function _feeAmount(address user, uint256 gross) internal view returns (uint256) {
        uint256 discount = feeStaking.getFeeDiscountBps(user);
        uint256 fee = (gross * FEE_BPS) / BPS;
        // forge-lint: disable-next-line(divide-before-multiply)
        return (fee * (BPS - discount)) / BPS;
    }

    function _syncYield() internal {
        _releaseVestedMusd();
        _syncSmoothedRate();
        _claimSmusdYield();
        _harvestMezo();
        _finalizeMatured();
    }

    function _releaseVestedMusd() internal {
        uint256 elapsed = block.timestamp - yieldBufferLastUpdate;
        // forge-lint: disable-next-line(block-timestamp)
        if (elapsed != 0 && unvestedMusdBuffer != 0) {
            uint256 vested = (unvestedMusdBuffer * elapsed) / SECONDS_PER_WEEK;
            // forge-lint: disable-next-line(block-timestamp)
            if (vested > unvestedMusdBuffer) vested = unvestedMusdBuffer;
            unvestedMusdBuffer -= vested;
            _distributeMusd(vested);
        }
        yieldBufferLastUpdate = block.timestamp;
    }

    function _syncSmoothedRate() internal {
        uint256 elapsed = block.timestamp - rateBufferLastUpdate;
        // forge-lint: disable-next-line(block-timestamp)
        if (elapsed != 0 && unvestedRateBuffer != 0) {
            uint256 vested = (unvestedRateBuffer * elapsed) / SECONDS_PER_WEEK;
            // forge-lint: disable-next-line(block-timestamp)
            if (vested > unvestedRateBuffer) vested = unvestedRateBuffer;
            smoothedYieldIndex += vested;
            unvestedRateBuffer -= vested;
        }
        rateBufferLastUpdate = block.timestamp;

        uint256 actual = smusd.yieldIndex();
        if (actual > lastRateYieldIndex) {
            uint256 jump = actual - lastRateYieldIndex;
            lastRateYieldIndex = actual;
            uint256 maxInstant = ((1e18 + smoothedYieldIndex) * SMOOTHING_BPS) / BPS;
            if (jump > maxInstant) {
                smoothedYieldIndex += maxInstant;
                unvestedRateBuffer += jump - maxInstant;
            } else {
                smoothedYieldIndex += jump;
            }
        }
    }

    function _claimSmusdYield() internal {
        uint256 before = musd.balanceOf(address(this));
        // forge-lint: disable-next-line(reentrancy-no-eth, unused-return)
        adapter.claimSmusdYield();
        uint256 claimed = musd.balanceOf(address(this)) - before;
        if (claimed != 0) _processSmusdYield(claimed);
    }

    function _processSmusdYield(uint256 claimed) internal {
        uint256 actual = smusd.yieldIndex();
        uint256 previous = lastYieldIndex;
        lastYieldIndex = actual;

        if (actual <= previous) {
            _distributeMusd(claimed);
            return;
        }

        uint256 jumpBps = ((actual - previous) * BPS) / ACC_PRECISION;
        if (jumpBps <= SMOOTHING_BPS) {
            _distributeMusd(claimed);
            return;
        }

        uint256 buffered = (claimed * (jumpBps - SMOOTHING_BPS)) / jumpBps;
        uint256 immediate = claimed - buffered;
        unvestedMusdBuffer += buffered;
        yieldBufferLastUpdate = block.timestamp;

        if (immediate != 0) _distributeMusd(immediate);
    }

    function _harvestMezo() internal {
        if (address(adapter.gauge()) == address(0)) return;

        uint256 before = mezo.balanceOf(address(this));
        // forge-lint: disable-next-line(reentrancy-no-eth, unused-return)
        adapter.harvestGaugeRewards();
        uint256 harvested = mezo.balanceOf(address(this)) - before;
        if (harvested != 0) _distributeMezo(harvested);
    }

    function _distributeMusd(uint256 amount) internal {
        if (amount == 0) return;
        if (totalActiveYt == 0) {
            musd.safeTransfer(treasury, amount);
            // forge-lint: disable-next-line(reentrancy-events)
            emit YieldToTreasury(address(musd), amount);
            return;
        }

        accMusdPerYt += (amount * ACC_PRECISION) / totalActiveYt;
        // forge-lint: disable-next-line(reentrancy-events)
        emit MusdYieldDistributed(amount, accMusdPerYt);
    }

    function _distributeMezo(uint256 amount) internal {
        if (amount == 0) return;
        if (totalActiveYt == 0) {
            mezo.safeTransfer(treasury, amount);
            // forge-lint: disable-next-line(reentrancy-events)
            emit YieldToTreasury(address(mezo), amount);
            return;
        }

        accMezoPerYt += (amount * ACC_PRECISION) / totalActiveYt;
        // forge-lint: disable-next-line(reentrancy-events)
        emit MezoYieldDistributed(amount, accMezoPerYt);
    }

    function _finalizeMatured() internal {
        uint256 length = maturities.length;
        for (uint256 i = 0; i < length; i++) {
            uint256 maturity = maturities[i];
            Series storage s = series[maturity];
            // forge-lint: disable-next-line(block-timestamp)
            if (!s.finalized && block.timestamp >= maturity) {
                s.finalized = true;
                // forge-lint: disable-next-line(calls-loop)
                s.finalExchangeRate = 1e18 + smusd.yieldIndex();
                s.finalAccMusdPerYt = accMusdPerYt;
                s.finalAccMezoPerYt = accMezoPerYt;
                totalActiveYt -= s.totalYt;
                // forge-lint: disable-next-line(reentrancy-events)
                emit SeriesFinalized(maturity, s.finalExchangeRate);
            }
        }
    }

    function _settleUser(Series storage s, address user) internal {
        if (user == address(0)) return;

        uint256 ytBalance = IERC20(s.ytToken).balanceOf(user);
        uint256 accMusd = _effectiveAccMusd(s);
        uint256 accMezo = _effectiveAccMezo(s);
        uint256 oldMusd = userMusdIndex[s.maturity][user];
        uint256 oldMezo = userMezoIndex[s.maturity][user];

        if (ytBalance != 0 && accMusd > oldMusd) {
            claimableMusd[s.maturity][user] += (ytBalance * (accMusd - oldMusd)) / ACC_PRECISION;
        }
        if (ytBalance != 0 && accMezo > oldMezo) {
            claimableMezo[s.maturity][user] += (ytBalance * (accMezo - oldMezo)) / ACC_PRECISION;
        }

        userMusdIndex[s.maturity][user] = accMusd;
        userMezoIndex[s.maturity][user] = accMezo;
    }

    function _effectiveAccMusd(Series storage s) internal view returns (uint256) {
        return s.finalized ? s.finalAccMusdPerYt : accMusdPerYt;
    }

    function _effectiveAccMezo(Series storage s) internal view returns (uint256) {
        return s.finalized ? s.finalAccMezoPerYt : accMezoPerYt;
    }

    function _requireSeries(uint256 maturity) internal view returns (Series storage s) {
        s = series[maturity];
        require(s.ptToken != address(0), "unknown series");
    }
}
