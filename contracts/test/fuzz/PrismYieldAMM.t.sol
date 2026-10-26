// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {PrismYieldAMM} from "../../src/core/PrismYieldAMM.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {PrismPrincipalToken} from "../../src/core/tokens/PrismPrincipalToken.sol";
import {PrismYieldToken} from "../../src/core/tokens/PrismYieldToken.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {IMUSDSavingsRate, IMUSDSavingsGauge, IPrismFeeStaking} from "../../src/interfaces/IMezoCore.sol";

contract AMMMUSD is ERC20 {
    constructor() ERC20("Mock MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract AMMMEZO is ERC20 {
    constructor() ERC20("Mock MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract AMMFeeStaking is IPrismFeeStaking {
    using SafeERC20 for IERC20;

    IERC20 public immutable musd;
    uint256 public discountBps;
    uint256 public notified;

    constructor(IERC20 _musd) {
        musd = _musd;
    }

    function setDiscountBps(uint256 bps) external {
        discountBps = bps;
    }

    function getFeeDiscountBps(address) external view returns (uint256) {
        return discountBps;
    }

    function notifyRewardAmount(uint256 amount) external {
        musd.safeTransferFrom(msg.sender, address(this), amount);
        notified += amount;
    }
}

contract PrismYieldAMMTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SECONDS_PER_WEEK = 604800;
    uint256 internal constant SEED = 1000e18;
    uint256 internal constant FEE_BPS = 5;

    AMMMUSD internal musd;
    TestnetFeeInjector internal smusd;
    AMMMEZO internal mezo;
    MockMUSDSavingsGauge internal gauge;
    AMMFeeStaking internal feeStaking;
    DualTrackAdapter internal adapter;
    PrismSeriesFactory internal factory;
    PrismTokenizer internal tokenizer;
    PrismYieldAMM internal amm;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal treasury = address(0x7BEA5);

    uint256 internal maturity;
    address internal pt;
    address internal yt;

    function setUp() public {
        maturity = ((block.timestamp / SECONDS_PER_WEEK) + 4) * SECONDS_PER_WEEK;

        musd = new AMMMUSD();
        smusd = new TestnetFeeInjector(IERC20(address(musd)));
        mezo = new AMMMEZO();
        gauge = new MockMUSDSavingsGauge(IERC20(address(smusd)), IERC20(address(mezo)));
        feeStaking = new AMMFeeStaking(IERC20(address(musd)));
        adapter =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500);
        factory = new PrismSeriesFactory();
        tokenizer = new PrismTokenizer(
            IERC20(address(musd)),
            IMUSDSavingsRate(address(smusd)),
            adapter,
            factory,
            IPrismFeeStaking(address(feeStaking)),
            IERC20(address(mezo)),
            treasury,
            address(this)
        );
        tokenizer.initializeSeries(maturity);
        amm = new PrismYieldAMM(tokenizer, IERC20(address(musd)), IPrismFeeStaking(address(feeStaking)), treasury);

        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        pt = s.ptToken;
        yt = s.ytToken;

        musd.mint(address(this), SEED * 2);
        musd.approve(address(tokenizer), SEED);
        tokenizer.mintPyFromMusd(SEED, maturity, address(this));
        musd.approve(address(amm), SEED);
        IERC20(pt).approve(address(amm), SEED);
        amm.addLiquidity(maturity, SEED, SEED, address(this));
    }

    function _fundMusd(address user, uint256 amount) internal {
        musd.mint(user, amount);
        vm.prank(user);
        musd.approve(address(amm), amount);
    }

    function _mintPy(address user, uint256 amount) internal {
        musd.mint(user, amount);
        vm.startPrank(user);
        musd.approve(address(tokenizer), amount);
        tokenizer.mintPyFromMusd(amount, maturity, user);
        IERC20(pt).approve(address(amm), amount);
        vm.stopPrank();
    }

    function _price() internal view returns (uint256) {
        return amm.ptPriceInMusd(maturity);
    }

    function _assertPoolBalances() internal view {
        (,, uint256 reserveMusd, uint256 reservePt,,,) = amm.getPool(maturity);
        assertEq(musd.balanceOf(address(amm)), reserveMusd);
        assertEq(IERC20(pt).balanceOf(address(amm)), reservePt);
    }

    function testInitialPoolState() public view {
        (address poolPt, address poolYt, uint256 reserveMusd, uint256 reservePt, uint256 totalLp,, uint256 price) =
            amm.getPool(maturity);
        assertEq(poolPt, pt);
        assertEq(poolYt, yt);
        assertEq(reserveMusd, SEED);
        assertEq(reservePt, SEED);
        assertEq(totalLp, SEED);
        assertEq(amm.lpShares(maturity, address(this)), SEED);
        assertLe(price, WAD);
        assertGt(price, 0.99e18);
        _assertPoolBalances();
    }

    function testPriceConvergesToOneAtMaturity() public {
        assertLt(_price(), WAD);
        vm.warp(maturity);
        assertEq(amm.ptPriceInMusd(maturity), WAD);
        (,,, uint256 reservePt,,,) = amm.getPool(maturity);
        (uint256 ptOut, uint256 fixedApyBps, int256 netCarrySpreadBps) =
            amm.quoteBorrowAndLockSpread(maturity, 100e18, 100);
        assertEq(ptOut, (100e18 * (BPS - FEE_BPS)) / BPS);
        assertEq(fixedApyBps, 0);
        assertEq(netCarrySpreadBps, -100);
        assertGt(reservePt, 0);
    }

    function testSwapMusdForPt() public {
        _fundMusd(alice, 100e18);
        (,, uint256 reserveMusdBefore, uint256 reservePtBefore,,,) = amm.getPool(maturity);

        vm.prank(alice);
        uint256 ptOut = amm.swapExactMusdForPt(maturity, 100e18, 0, alice);

        uint256 fee = (100e18 * FEE_BPS) / BPS;
        uint256 priceBefore = 0;
        (,,,,,, priceBefore) = amm.getPool(maturity);
        assertGt(ptOut, 100e18 - fee);
        assertEq(IERC20(pt).balanceOf(alice), ptOut);
        assertEq(feeStaking.notified(), fee / 2);
        assertEq(musd.balanceOf(treasury), fee - fee / 2);

        (,, uint256 reserveMusdAfter, uint256 reservePtAfter,,,) = amm.getPool(maturity);
        assertEq(reserveMusdAfter, reserveMusdBefore + 100e18 - fee);
        assertEq(reservePtAfter, reservePtBefore - ptOut);
        assertLe(priceBefore, WAD);
        _assertPoolBalances();
    }

    function testSwapPtForMusd() public {
        _mintPy(alice, 100e18);
        (,, uint256 reserveMusdBefore, uint256 reservePtBefore,,,) = amm.getPool(maturity);

        vm.prank(alice);
        uint256 musdOut = amm.swapExactPtForMusd(maturity, 100e18, 0, alice);

        assertGt(musdOut, 0);
        assertLt(musdOut, 100e18);
        assertEq(musd.balanceOf(alice), musdOut);
        assertEq(IERC20(pt).balanceOf(alice), 0);

        (,, uint256 reserveMusdAfter, uint256 reservePtAfter,,,) = amm.getPool(maturity);
        assertEq(reservePtAfter, reservePtBefore + 100e18);
        assertLt(reserveMusdAfter, reserveMusdBefore);
        _assertPoolBalances();
    }

    function testSwapMusdForYtFlashMintNetting() public {
        _fundMusd(alice, 100e18);
        (,, uint256 reserveMusdBefore, uint256 reservePtBefore,,,) = amm.getPool(maturity);
        uint256 ytSupplyBefore = IERC20(yt).totalSupply();

        vm.prank(alice);
        (uint256 ytOut, uint256 refund) = amm.swapExactMusdForYt(maturity, 100e18, 0, alice);

        uint256 fee = (100e18 * FEE_BPS) / BPS;
        uint256 net = 100e18 - fee;
        assertEq(ytOut, net);
        assertEq(IERC20(yt).balanceOf(alice), net);
        assertGt(refund, 0);
        assertLt(refund, net);
        assertEq(IERC20(yt).totalSupply(), ytSupplyBefore + net);

        (,, uint256 reserveMusdAfter, uint256 reservePtAfter,,,) = amm.getPool(maturity);
        assertEq(reservePtAfter, reservePtBefore + net);
        assertEq(reserveMusdAfter, reserveMusdBefore - refund);
        assertEq(musd.balanceOf(alice), refund);
        assertEq(feeStaking.notified(), fee / 2);
        _assertPoolBalances();
    }

    function testPreviewSwapMusdForYtMatchesExecution() public {
        _fundMusd(alice, 50e18);
        (uint256 previewYt, uint256 previewRefund, uint256 previewFee) =
            amm.previewSwapMusdForYt(maturity, 50e18, alice);

        vm.prank(alice);
        (uint256 ytOut, uint256 refund) = amm.swapExactMusdForYt(maturity, 50e18, 0, alice);

        assertEq(ytOut, previewYt);
        assertEq(refund, previewRefund);
        assertEq(previewFee, (50e18 * FEE_BPS) / BPS);
    }

    function testFeeDiscountReducesSwapFee() public {
        feeStaking.setDiscountBps(5000);
        _fundMusd(alice, 100e18);

        vm.prank(alice);
        amm.swapExactMusdForPt(maturity, 100e18, 0, alice);

        uint256 feeBps = (FEE_BPS * (BPS - 5000)) / BPS;
        uint256 fee = (100e18 * feeBps) / BPS;
        assertEq(feeStaking.notified(), fee / 2);
        assertEq(musd.balanceOf(treasury), fee - fee / 2);
    }

    function testAddAndRemoveLiquidity() public {
        _mintPy(bob, 200e18);
        musd.mint(bob, 200e18);
        vm.startPrank(bob);
        musd.approve(address(amm), 200e18);
        IERC20(pt).approve(address(amm), 200e18);
        uint256 shares = amm.addLiquidity(maturity, 200e18, 200e18, bob);
        vm.stopPrank();

        assertEq(shares, 200e18);
        assertEq(amm.lpShares(maturity, bob), 200e18);
        (,, uint256 reserveMusd, uint256 reservePt, uint256 totalLp,,) = amm.getPool(maturity);
        assertEq(reserveMusd, 1200e18);
        assertEq(reservePt, 1200e18);
        assertEq(totalLp, 1200e18);

        vm.prank(bob);
        (uint256 musdOut, uint256 ptOut) = amm.removeLiquidity(maturity, 200e18, bob);
        assertEq(musdOut, 200e18);
        assertEq(ptOut, 200e18);
        assertEq(amm.lpShares(maturity, bob), 0);
        (,, reserveMusd, reservePt, totalLp,,) = amm.getPool(maturity);
        assertEq(reserveMusd, 1000e18);
        assertEq(reservePt, 1000e18);
        assertEq(totalLp, 1000e18);
        _assertPoolBalances();
    }

    function testRemoveAllLiquidity() public {
        vm.prank(address(this));
        (uint256 musdOut, uint256 ptOut) = amm.removeLiquidity(maturity, SEED, address(this));
        assertEq(musdOut, SEED);
        assertEq(ptOut, SEED);
        (,, uint256 reserveMusd, uint256 reservePt, uint256 totalLp,,) = amm.getPool(maturity);
        assertEq(reserveMusd, 0);
        assertEq(reservePt, 0);
        assertEq(totalLp, 0);
        _assertPoolBalances();
    }

    function testQuoteBorrowAndLockSpread() public view {
        (uint256 ptOut, uint256 fixedApyBps, int256 netCarrySpreadBps) =
            amm.quoteBorrowAndLockSpread(maturity, 1800e18, 100);

        assertGt(ptOut, 1800e18);
        assertGt(fixedApyBps, 100);
        assertEq(netCarrySpreadBps, int256(fixedApyBps) - 100);
    }

    function testSwapPtForMusdKeepsFeeInPoolAccounting() public {
        _mintPy(alice, 100e18);
        uint256 treasuryBefore = musd.balanceOf(treasury);
        uint256 stakingBefore = feeStaking.notified();
        vm.prank(alice);
        amm.swapExactPtForMusd(maturity, 100e18, 0, alice);
        assertGt(musd.balanceOf(treasury) + feeStaking.notified(), treasuryBefore + stakingBefore);
        _assertPoolBalances();
    }

    function testReverts() public {
        vm.expectRevert("unknown pool");
        amm.ptPriceInMusd(maturity + SECONDS_PER_WEEK);

        vm.expectRevert("unknown pool");
        amm.swapExactMusdForPt(maturity + SECONDS_PER_WEEK, 1e18, 0, alice);

        _fundMusd(alice, 10e18);
        vm.startPrank(alice);
        vm.expectRevert("slippage");
        amm.swapExactMusdForPt(maturity, 1e18, 10e18, alice);
        vm.expectRevert("musdIn=0");
        amm.swapExactMusdForPt(maturity, 0, 0, alice);
        vm.expectRevert("receiver=0");
        amm.swapExactMusdForPt(maturity, 1e18, 0, address(0));
        vm.expectRevert("shares=0");
        amm.removeLiquidity(maturity, 0, alice);
        vm.expectRevert("insufficient shares");
        amm.removeLiquidity(maturity, 1e18, alice);
        vm.stopPrank();

        vm.warp(maturity);
        _fundMusd(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert("matured");
        amm.swapExactMusdForYt(maturity, 1e18, 0, bob);

        vm.expectRevert("matured");
        amm.addLiquidity(maturity, 1e18, 1e18, bob);
    }

    function testFuzzSwapMusdForPtBounded(uint96 amount) public {
        uint256 musdIn = bound(uint256(amount), 1, 100e18);
        _fundMusd(alice, musdIn);
        (,, uint256 reserveMusdBefore, uint256 reservePtBefore,,,) = amm.getPool(maturity);

        vm.prank(alice);
        uint256 ptOut = amm.swapExactMusdForPt(maturity, musdIn, 0, alice);

        assertLe(ptOut, reservePtBefore);
        assertEq(IERC20(pt).balanceOf(alice), ptOut);
        (,, uint256 reserveMusdAfter, uint256 reservePtAfter,,,) = amm.getPool(maturity);
        assertEq(reservePtAfter, reservePtBefore - ptOut);
        assertGe(reserveMusdAfter, reserveMusdBefore);
        _assertPoolBalances();
    }

    function testFuzzSwapMusdForYtBounded(uint96 amount) public {
        uint256 musdIn = bound(uint256(amount), 1, 100e18);
        _fundMusd(alice, musdIn);
        (,, uint256 reserveMusdBefore, uint256 reservePtBefore,,,) = amm.getPool(maturity);

        vm.prank(alice);
        (uint256 ytOut, uint256 refund) = amm.swapExactMusdForYt(maturity, musdIn, 0, alice);

        uint256 fee = (musdIn * FEE_BPS) / BPS;
        assertEq(ytOut, musdIn - fee);
        assertLe(refund, reserveMusdBefore);
        assertEq(IERC20(yt).balanceOf(alice), ytOut);
        (,, uint256 reserveMusdAfter, uint256 reservePtAfter,,,) = amm.getPool(maturity);
        assertEq(reservePtAfter, reservePtBefore + ytOut);
        assertEq(reserveMusdAfter, reserveMusdBefore - refund);
        assertEq(musd.balanceOf(alice), refund);
        _assertPoolBalances();
    }

    function testFuzzPtPriceNeverExceedsOne(uint256 warpSeconds) public {
        uint256 target = bound(warpSeconds, 1, maturity - block.timestamp);
        vm.warp(target);
        uint256 price = amm.ptPriceInMusd(maturity);
        assertLe(price, WAD);
        assertGe(price, 0.5e18);
        vm.warp(maturity);
        assertEq(amm.ptPriceInMusd(maturity), WAD);
    }

    function testFuzzRemoveLiquidityConserves(uint96 shares) public {
        uint256 burn = bound(uint256(shares), 1, amm.lpShares(maturity, address(this)));
        (,, uint256 reserveMusdBefore, uint256 reservePtBefore,,,) = amm.getPool(maturity);

        vm.prank(address(this));
        (uint256 musdOut, uint256 ptOut) = amm.removeLiquidity(maturity, burn, address(this));

        assertLe(musdOut, reserveMusdBefore);
        assertLe(ptOut, reservePtBefore);
        (,, uint256 reserveMusdAfter, uint256 reservePtAfter,,,) = amm.getPool(maturity);
        assertEq(reserveMusdAfter, reserveMusdBefore - musdOut);
        assertEq(reservePtAfter, reservePtBefore - ptOut);
        _assertPoolBalances();
    }

    function testFuzzQuotePtOutGreaterThanPrincipal(uint96 amount) public view {
        uint256 borrow = bound(uint256(amount), 1_800e18, 10_000e18);
        (uint256 ptOut,,) = amm.quoteBorrowAndLockSpread(maturity, borrow, 100);
        assertGt(ptOut, borrow);
    }
}
