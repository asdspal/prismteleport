// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PrismTokenizer} from "./PrismTokenizer.sol";
import {IPrismFeeStaking} from "../interfaces/IMezoCore.sol";

contract PrismYieldAMM is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant SWAP_FEE_BPS = 5;
    uint256 public constant BASE_IMPLIED_RATE_WAD = 5e16;
    uint256 public constant MAX_IMPLIED_RATE_WAD = 10e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MIN_TIME_TO_MATURITY = 1 hours;
    uint256 public constant MAX_TIME_TO_MATURITY = 365 days;

    struct Pool {
        address pt;
        address yt;
        uint256 reserveMusd;
        uint256 reservePt;
        uint256 totalLp;
        uint256 impliedRateWad;
        bool initialized;
    }

    PrismTokenizer public immutable tokenizer;
    IERC20 public immutable musd;
    IPrismFeeStaking public immutable feeStaking;
    address public immutable treasury;

    mapping(uint256 => Pool) public pools;
    mapping(uint256 => mapping(address => uint256)) public lpShares;

    event PoolInitialized(uint256 indexed maturity, address pt, address yt);
    event LiquidityAdded(
        uint256 indexed maturity, address indexed provider, uint256 musdAmount, uint256 ptAmount, uint256 shares
    );
    event LiquidityRemoved(
        uint256 indexed maturity, address indexed provider, uint256 musdAmount, uint256 ptAmount, uint256 shares
    );
    event SwappedMusdForPt(
        uint256 indexed maturity, address indexed user, address indexed receiver, uint256 musdIn, uint256 ptOut
    );
    event SwappedPtForMusd(
        uint256 indexed maturity, address indexed user, address indexed receiver, uint256 ptIn, uint256 musdOut
    );
    event SwappedMusdForYt(
        uint256 indexed maturity,
        address indexed user,
        address indexed receiver,
        uint256 musdIn,
        uint256 ytOut,
        uint256 refundMusd
    );
    event SwapFeeCollected(uint256 indexed maturity, address indexed user, uint256 feeMusd);

    constructor(PrismTokenizer _tokenizer, IERC20 _musd, IPrismFeeStaking _feeStaking, address _treasury) {
        require(address(_tokenizer) != address(0), "tokenizer=0");
        require(address(_musd) != address(0), "musd=0");
        require(address(_feeStaking) != address(0), "feeStaking=0");
        require(_treasury != address(0), "treasury=0");

        tokenizer = _tokenizer;
        musd = _musd;
        feeStaking = _feeStaking;
        treasury = _treasury;
    }

    function addLiquidity(uint256 maturity, uint256 musdAmount, uint256 ptAmount, address provider)
        external
        nonReentrant
        returns (uint256 shares)
    {
        require(musdAmount != 0, "musd=0");
        require(ptAmount != 0, "pt=0");
        require(provider != address(0), "provider=0");
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < maturity, "matured");

        Pool storage p = pools[maturity];
        if (!p.initialized) {
            _initializePool(p, maturity);
        }

        uint256 oldMusd = p.reserveMusd;
        uint256 oldPt = p.reservePt;
        uint256 oldLp = p.totalLp;

        shares = oldLp == 0
            ? Math.sqrt(musdAmount * ptAmount)
            : Math.min((musdAmount * oldLp) / oldMusd, (ptAmount * oldLp) / oldPt);
        require(shares != 0, "shares=0");

        musd.safeTransferFrom(msg.sender, address(this), musdAmount);
        IERC20(p.pt).safeTransferFrom(msg.sender, address(this), ptAmount);

        p.reserveMusd = oldMusd + musdAmount;
        p.reservePt = oldPt + ptAmount;
        p.totalLp = oldLp + shares;
        lpShares[maturity][provider] += shares;

        // forge-lint: disable-next-line(reentrancy-events)
        emit LiquidityAdded(maturity, provider, musdAmount, ptAmount, shares);
    }

    function removeLiquidity(uint256 maturity, uint256 shares, address receiver)
        external
        nonReentrant
        returns (uint256 musdOut, uint256 ptOut)
    {
        require(shares != 0, "shares=0");
        require(receiver != address(0), "receiver=0");

        Pool storage p = _requirePool(maturity);
        uint256 userShares = lpShares[maturity][msg.sender];
        require(shares <= userShares, "insufficient shares");

        uint256 total = p.totalLp;
        musdOut = (shares * p.reserveMusd) / total;
        ptOut = (shares * p.reservePt) / total;
        require(musdOut != 0 || ptOut != 0, "empty");

        lpShares[maturity][msg.sender] = userShares - shares;
        p.totalLp = total - shares;
        p.reserveMusd -= musdOut;
        p.reservePt -= ptOut;

        if (musdOut != 0) musd.safeTransfer(receiver, musdOut);
        if (ptOut != 0) IERC20(p.pt).safeTransfer(receiver, ptOut);

        emit LiquidityRemoved(maturity, msg.sender, musdOut, ptOut, shares);
    }

    function swapExactMusdForPt(uint256 maturity, uint256 musdIn, uint256 minPtOut, address receiver)
        external
        nonReentrant
        returns (uint256 ptOut)
    {
        require(musdIn != 0, "musdIn=0");
        require(receiver != address(0), "receiver=0");

        Pool storage p = _requirePool(maturity);
        uint256 fee = _feeAmount(msg.sender, musdIn);
        uint256 netMusd = musdIn - fee;
        uint256 price = _ptPrice(p, maturity);
        ptOut = (netMusd * WAD) / price;
        require(ptOut >= minPtOut, "slippage");
        require(ptOut <= p.reservePt, "insufficient pt");

        musd.safeTransferFrom(msg.sender, address(this), musdIn);
        p.reserveMusd += netMusd;
        p.reservePt -= ptOut;
        _collectMusdFee(maturity, msg.sender, fee);

        IERC20(p.pt).safeTransfer(receiver, ptOut);
        // forge-lint: disable-next-line(reentrancy-events)
        emit SwappedMusdForPt(maturity, msg.sender, receiver, musdIn, ptOut);
    }

    function swapExactPtForMusd(uint256 maturity, uint256 ptIn, uint256 minMusdOut, address receiver)
        external
        nonReentrant
        returns (uint256 musdOut)
    {
        require(ptIn != 0, "ptIn=0");
        require(receiver != address(0), "receiver=0");

        Pool storage p = _requirePool(maturity);
        uint256 price = _ptPrice(p, maturity);
        uint256 grossMusd = (ptIn * price) / WAD;
        require(grossMusd <= p.reserveMusd, "insufficient musd");

        uint256 fee = _feeAmount(msg.sender, grossMusd);
        musdOut = grossMusd - fee;
        require(musdOut >= minMusdOut, "slippage");

        IERC20(p.pt).safeTransferFrom(msg.sender, address(this), ptIn);
        p.reservePt += ptIn;
        p.reserveMusd -= grossMusd;

        if (musdOut != 0) musd.safeTransfer(receiver, musdOut);
        _collectMusdFee(maturity, msg.sender, fee);

        // forge-lint: disable-next-line(reentrancy-events)
        emit SwappedPtForMusd(maturity, msg.sender, receiver, ptIn, musdOut);
    }

    function swapExactMusdForYt(uint256 maturity, uint256 musdIn, uint256 minYtOut, address receiver)
        external
        nonReentrant
        returns (uint256 ytOut, uint256 refundMusd)
    {
        require(musdIn != 0, "musdIn=0");
        require(receiver != address(0), "receiver=0");
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < maturity, "matured");

        Pool storage p = _requirePool(maturity);
        uint256 fee = _feeAmount(msg.sender, musdIn);
        uint256 netMusd = musdIn - fee;
        ytOut = netMusd;
        require(ytOut >= minYtOut, "slippage");

        musd.safeTransferFrom(msg.sender, address(this), musdIn);
        musd.forceApprove(address(tokenizer), netMusd);
        // forge-lint: disable-next-line(reentrancy-no-eth, unused-return)
        tokenizer.mintPyFromMusd(netMusd, maturity, address(this));

        uint256 price = _ptPrice(p, maturity);
        refundMusd = (netMusd * price) / WAD;
        require(refundMusd <= p.reserveMusd, "insufficient musd");
        p.reservePt += netMusd;
        p.reserveMusd -= refundMusd;

        _collectMusdFee(maturity, msg.sender, fee);
        IERC20(p.yt).safeTransfer(receiver, ytOut);
        if (refundMusd != 0) musd.safeTransfer(receiver, refundMusd);

        // forge-lint: disable-next-line(reentrancy-events)
        emit SwappedMusdForYt(maturity, msg.sender, receiver, musdIn, ytOut, refundMusd);
    }

    function previewSwapMusdForYt(uint256 maturity, uint256 musdIn, address user)
        external
        view
        returns (uint256 ytOut, uint256 refundMusd, uint256 feeMusd)
    {
        Pool storage p = _requirePool(maturity);
        feeMusd = _feeAmount(user, musdIn);
        ytOut = musdIn - feeMusd;
        refundMusd = (ytOut * _ptPrice(p, maturity)) / WAD;
    }

    function quoteBorrowAndLockSpread(uint256 maturity, uint256 musdBorrowAmount, uint256 troveBorrowAprBps)
        external
        view
        returns (uint256 ptOut, uint256 fixedApyBps, int256 netCarrySpreadBps)
    {
        Pool storage p = _requirePool(maturity);
        uint256 price = _ptPrice(p, maturity);
        uint256 netMusd = (musdBorrowAmount * (BPS - SWAP_FEE_BPS)) / BPS;
        // forge-lint: disable-next-line(divide-before-multiply)
        ptOut = (netMusd * WAD) / price;
        fixedApyBps = _fixedApyBps(price, maturity);
        // forge-lint: disable-next-line(unsafe-typecast)
        netCarrySpreadBps = int256(fixedApyBps) - int256(troveBorrowAprBps);
    }

    function ptPriceInMusd(uint256 maturity) external view returns (uint256) {
        return _ptPrice(_requirePool(maturity), maturity);
    }

    function getPool(uint256 maturity)
        external
        view
        returns (
            address pt,
            address yt,
            uint256 reserveMusd,
            uint256 reservePt,
            uint256 totalLp,
            uint256 impliedRateWad,
            uint256 price
        )
    {
        Pool storage p = pools[maturity];
        pt = p.pt;
        yt = p.yt;
        reserveMusd = p.reserveMusd;
        reservePt = p.reservePt;
        totalLp = p.totalLp;
        impliedRateWad = _impliedRate(p);
        price = _ptPrice(p, maturity);
    }

    function _initializePool(Pool storage p, uint256 maturity) internal {
        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        require(s.ptToken != address(0), "unknown series");
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < maturity, "matured");

        p.pt = s.ptToken;
        p.yt = s.ytToken;
        p.impliedRateWad = BASE_IMPLIED_RATE_WAD;
        p.initialized = true;

        emit PoolInitialized(maturity, s.ptToken, s.ytToken);
    }

    function _requirePool(uint256 maturity) internal view returns (Pool storage p) {
        p = pools[maturity];
        require(p.initialized, "unknown pool");
    }

    function _ptPrice(Pool storage p, uint256 maturity) internal view returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        if (maturity <= block.timestamp) return WAD;
        if (!p.initialized) return WAD;

        // forge-lint: disable-next-line(block-timestamp)
        uint256 timeRemaining = maturity - block.timestamp;
        // forge-lint: disable-next-line(block-timestamp)
        if (timeRemaining < MIN_TIME_TO_MATURITY) timeRemaining = MIN_TIME_TO_MATURITY;
        // forge-lint: disable-next-line(block-timestamp)
        if (timeRemaining > MAX_TIME_TO_MATURITY) timeRemaining = MAX_TIME_TO_MATURITY;

        uint256 rate = _impliedRate(p);
        uint256 discount = (rate * timeRemaining) / SECONDS_PER_YEAR;
        return (WAD * WAD) / (WAD + discount);
    }

    function _fixedApyBps(uint256 price, uint256 maturity) internal view returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        if (maturity <= block.timestamp || price >= WAD) return 0;

        // forge-lint: disable-next-line(block-timestamp)
        uint256 timeRemaining = maturity - block.timestamp;
        // forge-lint: disable-next-line(block-timestamp)
        if (timeRemaining < MIN_TIME_TO_MATURITY) timeRemaining = MIN_TIME_TO_MATURITY;
        // forge-lint: disable-next-line(block-timestamp)
        if (timeRemaining > MAX_TIME_TO_MATURITY) timeRemaining = MAX_TIME_TO_MATURITY;

        return ((WAD - price) * BPS * SECONDS_PER_YEAR) / (price * timeRemaining);
    }

    function _impliedRate(Pool storage p) internal view returns (uint256) {
        uint256 base = p.impliedRateWad;
        if (base == 0) base = BASE_IMPLIED_RATE_WAD;

        uint256 total = p.reserveMusd + p.reservePt;
        if (total == 0) return base;

        if (p.reservePt > p.reserveMusd) {
            uint256 skew = ((p.reservePt - p.reserveMusd) * WAD) / total;
            // forge-lint: disable-next-line(divide-before-multiply)
            base += (base * skew) / WAD;
        } else if (p.reserveMusd > p.reservePt) {
            uint256 skew = ((p.reserveMusd - p.reservePt) * WAD) / total;
            // forge-lint: disable-next-line(divide-before-multiply)
            uint256 delta = (base * skew) / WAD;
            base = base > delta ? base - delta : 0;
        }

        return base > MAX_IMPLIED_RATE_WAD ? MAX_IMPLIED_RATE_WAD : base;
    }

    function _feeAmount(address user, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint256 discount = feeStaking.getFeeDiscountBps(user);
        if (discount > BPS) discount = BPS;
        uint256 feeBps = (SWAP_FEE_BPS * (BPS - discount)) / BPS;
        // forge-lint: disable-next-line(divide-before-multiply)
        return (amount * feeBps) / BPS;
    }

    function _collectMusdFee(uint256 maturity, address user, uint256 fee) internal {
        if (fee == 0) return;

        uint256 toStaking = fee / 2;
        uint256 toTreasury = fee - toStaking;

        if (toStaking != 0) {
            musd.forceApprove(address(feeStaking), toStaking);
            // forge-lint: disable-next-line(reentrancy-no-eth)
            feeStaking.notifyRewardAmount(toStaking);
        }
        if (toTreasury != 0) musd.safeTransfer(treasury, toTreasury);

        // forge-lint: disable-next-line(reentrancy-events)
        emit SwapFeeCollected(maturity, user, fee);
    }
}
