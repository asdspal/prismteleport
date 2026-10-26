// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {PrismPrincipalToken} from "../../src/core/tokens/PrismPrincipalToken.sol";
import {PrismYieldToken} from "../../src/core/tokens/PrismYieldToken.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {IMUSDSavingsRate, IMUSDSavingsGauge, IPrismFeeStaking} from "../../src/interfaces/IMezoCore.sol";

contract MockMUSD is ERC20 {
    constructor() ERC20("Mock MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockMEZO is ERC20 {
    constructor() ERC20("Mock MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFeeStaking is IPrismFeeStaking {
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

contract PrismTokenizerTest is Test {
    uint256 internal constant SECONDS_PER_WEEK = 604800;
    uint256 internal constant FEE_BPS = 300;
    uint256 internal constant BPS = 10000;

    MockMUSD internal musd;
    TestnetFeeInjector internal smusd;
    MockMEZO internal mezo;
    MockMUSDSavingsGauge internal gauge;
    MockFeeStaking internal feeStaking;
    DualTrackAdapter internal adapter;
    PrismSeriesFactory internal factory;
    PrismTokenizer internal tokenizer;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal treasury = address(0x7BEA5);
    address internal keeper = address(0xCAFE);

    uint256 internal maturity;

    function setUp() public {
        maturity = ((block.timestamp / SECONDS_PER_WEEK) + 4) * SECONDS_PER_WEEK;

        musd = new MockMUSD();
        smusd = new TestnetFeeInjector(IERC20(address(musd)));
        mezo = new MockMEZO();
        gauge = new MockMUSDSavingsGauge(IERC20(address(smusd)), IERC20(address(mezo)));
        feeStaking = new MockFeeStaking(IERC20(address(musd)));
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
            keeper
        );
        vm.prank(address(this));
        tokenizer.initializeSeries(maturity);
    }

    function _mintPy(address user, uint256 amount) internal returns (address ptToken, address ytToken) {
        musd.mint(user, amount);
        vm.startPrank(user);
        musd.approve(address(tokenizer), amount);
        tokenizer.mintPyFromMusd(amount, maturity, user);
        vm.stopPrank();
        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        ptToken = s.ptToken;
        ytToken = s.ytToken;
    }

    function _injectSmusdYield(uint256 amount) internal {
        musd.mint(address(this), amount);
        musd.approve(address(smusd), amount);
        smusd.injectWeeklyFeeYield(amount);
    }

    function _injectMezo(uint256 amount) internal {
        mezo.mint(address(gauge), amount);
        gauge.notifyReward(address(adapter), amount);
    }

    function testInitializeSeries() public {
        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        assertEq(s.maturity, maturity);
        assertTrue(s.ptToken != address(0));
        assertTrue(s.ytToken != address(0));
        assertEq(s.rateAtInit, 1e18);
        assertEq(s.totalPt, 0);
        assertEq(s.totalYt, 0);

        assertEq(PrismPrincipalToken(s.ptToken).maturity(), maturity);
        assertEq(PrismYieldToken(s.ytToken).maturity(), maturity);
        assertEq(PrismPrincipalToken(s.ptToken).tokenizer(), address(tokenizer));
        assertEq(PrismYieldToken(s.ytToken).tokenizer(), address(tokenizer));

        uint256[] memory active = tokenizer.getActiveMaturities();
        assertEq(active.length, 1);
        assertEq(active[0], maturity);
    }

    function testInitializeSeriesRejectsBadMaturity() public {
        vm.expectRevert("not thursday");
        tokenizer.initializeSeries(maturity + 1 days);

        vm.expectRevert("maturity past");
        tokenizer.initializeSeries(0);

        vm.expectRevert("series exists");
        tokenizer.initializeSeries(maturity);
    }

    function testMintPyFromMusd() public {
        (address ptToken, address ytToken) = _mintPy(alice, 1000e18);

        assertEq(PrismPrincipalToken(ptToken).balanceOf(alice), 1000e18);
        assertEq(PrismYieldToken(ytToken).balanceOf(alice), 1000e18);

        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        assertEq(s.totalPt, 1000e18);
        assertEq(s.totalYt, 1000e18);
        assertEq(tokenizer.totalActiveYt(), 1000e18);
        assertEq(adapter.totalSmusdControlled(), 1000e18);
        assertEq(smusd.balanceOf(address(adapter)), 1000e18);
        (uint256 pMusd, uint256 pMezo) = tokenizer.pendingYield(maturity, alice);
        assertEq(pMusd, 0);
        assertEq(pMezo, 0);
    }

    function testMintPyFromSmusd() public {
        (, address ytToken) = _mintPy(alice, 500e18);
        uint256 extra = 250e18;
        musd.mint(alice, extra);
        vm.startPrank(alice);
        musd.approve(address(smusd), extra);
        smusd.deposit(extra);
        smusd.approve(address(tokenizer), extra);
        tokenizer.mintPyFromSmusd(extra, maturity, alice);
        vm.stopPrank();

        assertEq(PrismYieldToken(ytToken).balanceOf(alice), 750e18);
        assertEq(adapter.totalSmusdControlled(), 750e18);
        assertEq(tokenizer.totalActiveYt(), 750e18);
    }

    function testMintRejectsMaturedAndUnknown() public {
        vm.expectRevert("unknown series");
        tokenizer.mintPyFromMusd(1e18, maturity + SECONDS_PER_WEEK, alice);

        _mintPy(alice, 1e18);
        vm.warp(maturity);
        musd.mint(alice, 1e18);
        vm.startPrank(alice);
        musd.approve(address(tokenizer), 1e18);
        vm.expectRevert("matured");
        tokenizer.mintPyFromMusd(1e18, maturity, alice);
        vm.stopPrank();
    }

    function testRedeemPyBeforeMaturity() public {
        (address ptToken, address ytToken) = _mintPy(alice, 1000e18);
        _injectSmusdYield(0.5e18);
        tokenizer.syncYield();

        vm.prank(alice);
        tokenizer.redeemPyBeforeMaturity(400e18, maturity, alice);

        assertEq(smusd.balanceOf(alice), 400e18);
        assertEq(PrismPrincipalToken(ptToken).balanceOf(alice), 600e18);
        assertEq(PrismYieldToken(ytToken).balanceOf(alice), 600e18);
        assertEq(tokenizer.totalActiveYt(), 600e18);
        assertEq(adapter.totalSmusdControlled(), 600e18);
        assertEq(musd.balanceOf(alice), 0.485e18);
        assertEq(feeStaking.notified(), 0.0075e18);
        assertEq(musd.balanceOf(treasury), 0.0075e18);
    }

    function testRedeemPyRejectsAtMaturity() public {
        _mintPy(alice, 100e18);
        vm.warp(maturity);
        vm.prank(alice);
        vm.expectRevert("matured");
        tokenizer.redeemPyBeforeMaturity(1e18, maturity, alice);
    }

    function testRedeemPtAtMaturityOneToOne() public {
        (address ptToken, address ytToken) = _mintPy(alice, 1000e18);
        _injectSmusdYield(50e18);
        tokenizer.syncYield();

        vm.warp(maturity);
        tokenizer.syncYield();

        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        assertTrue(s.finalized);
        assertEq(s.finalExchangeRate, 1.05e18);
        assertEq(tokenizer.totalActiveYt(), 0);

        vm.prank(alice);
        tokenizer.redeemPtAfterMaturity(1000e18, maturity, alice);
        assertEq(smusd.balanceOf(alice), 1000e18);
        assertEq(PrismPrincipalToken(ptToken).balanceOf(alice), 0);
        assertEq(adapter.totalSmusdControlled(), 0);

        vm.prank(alice);
        (uint256 netMusd, uint256 netMezo) = tokenizer.claimYield(maturity, alice);
        assertEq(netMusd, 48.5e18);
        assertEq(netMezo, 0);
        assertEq(musd.balanceOf(alice), 48.5e18);
        assertEq(feeStaking.notified(), 0.75e18);
        assertEq(musd.balanceOf(treasury), 0.75e18);
        assertEq(PrismYieldToken(ytToken).balanceOf(alice), 1000e18);
    }

    function testRedeemPtRejectsBeforeMaturity() public {
        _mintPy(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert("not matured");
        tokenizer.redeemPtAfterMaturity(1e18, maturity, alice);
    }

    function testClaimSmusdAndMezoYield() public {
        _mintPy(alice, 1000e18);
        _injectSmusdYield(0.5e18);
        tokenizer.syncYield();
        _injectMezo(10e18);
        tokenizer.syncYield();

        (uint256 pendingMusd, uint256 pendingMezo) = tokenizer.pendingYield(maturity, alice);
        assertApproxEqAbs(pendingMusd, 0.5e18, 1);
        assertEq(pendingMezo, 10e18);

        vm.prank(alice);
        (uint256 netMusd, uint256 netMezo) = tokenizer.claimYield(maturity, alice);

        assertApproxEqAbs(netMusd, 0.485e18, 1);
        assertEq(netMezo, 9.7e18);
        assertApproxEqAbs(musd.balanceOf(alice), 0.485e18, 1);
        assertEq(mezo.balanceOf(alice), 9.7e18);
        assertApproxEqAbs(feeStaking.notified(), 0.0075e18, 1);
        assertApproxEqAbs(musd.balanceOf(treasury), 0.0075e18, 1);
        assertEq(mezo.balanceOf(address(feeStaking)), 0.15e18);
        assertEq(mezo.balanceOf(treasury), 0.15e18);
        (uint256 pMusd, uint256 pMezo) = tokenizer.pendingYield(maturity, alice);
        assertEq(pMusd, 0);
        assertEq(pMezo, 0);
    }

    function testFeeDiscount() public {
        _mintPy(alice, 1000e18);
        feeStaking.setDiscountBps(5000);
        _injectSmusdYield(0.5e18);
        tokenizer.syncYield();

        vm.prank(alice);
        (uint256 netMusd,) = tokenizer.claimYield(maturity, alice);
        assertApproxEqAbs(netMusd, 0.4925e18, 1);
        assertApproxEqAbs(feeStaking.notified(), 0.00375e18, 1);
        assertApproxEqAbs(musd.balanceOf(treasury), 0.00375e18, 1);
    }

    function testFivePercentJumpIsSmoothAndNoSandwich() public {
        _mintPy(alice, 1000e18);
        uint256 rateBefore = tokenizer.smoothedExchangeRate();

        _injectSmusdYield(50e18);
        assertEq(tokenizer.smoothedExchangeRate(), rateBefore);

        tokenizer.syncYield();
        uint256 rateAfterSync = tokenizer.smoothedExchangeRate();
        assertGt(rateAfterSync, rateBefore);
        assertLe(rateAfterSync - rateBefore, ((1e18 + rateBefore) * 5) / BPS + 1);
        assertGt(tokenizer.unvestedRateBuffer(), 0);

        tokenizer.syncYield();
        assertEq(tokenizer.smoothedExchangeRate(), rateAfterSync);

        (address bobPt, address bobYt) = _mintPy(bob, 1e18);
        (uint256 bobPendingMusd, uint256 bobPendingMezo) = tokenizer.pendingYield(maturity, bob);
        assertEq(bobPendingMusd, 0);
        assertEq(bobPendingMezo, 0);
        assertGt(PrismPrincipalToken(bobPt).balanceOf(bob), 0);
        assertGt(PrismYieldToken(bobYt).balanceOf(bob), 0);

        (uint256 alicePending,) = tokenizer.pendingYield(maturity, alice);
        assertGt(alicePending, 0);
    }

    function testYtTransferCheckpointsYield() public {
        (, address ytToken) = _mintPy(alice, 1000e18);
        _injectSmusdYield(0.5e18);
        tokenizer.syncYield();

        vm.prank(alice);
        PrismYieldToken(ytToken).transfer(bob, 400e18);

        (uint256 alicePending,) = tokenizer.pendingYield(maturity, alice);
        (uint256 bobPending,) = tokenizer.pendingYield(maturity, bob);
        assertApproxEqAbs(alicePending, 0.5e18, 1);
        assertEq(bobPending, 0);

        skip(61);
        _injectSmusdYield(0.5e18);
        tokenizer.syncYield();

        (alicePending,) = tokenizer.pendingYield(maturity, alice);
        (bobPending,) = tokenizer.pendingYield(maturity, bob);
        assertApproxEqAbs(alicePending, 0.8e18, 1);
        assertApproxEqAbs(bobPending, 0.2e18, 1);
    }

    function testMaturedSeriesStopsAccruingAndSendsLateYieldToTreasury() public {
        _mintPy(alice, 1000e18);
        vm.warp(maturity);
        tokenizer.syncYield();

        assertTrue(tokenizer.getSeries(maturity).finalized);
        assertEq(tokenizer.totalActiveYt(), 0);

        _injectSmusdYield(0.5e18);
        tokenizer.syncYield();

        (uint256 pendingMusd,) = tokenizer.pendingYield(maturity, alice);
        assertEq(pendingMusd, 0);
        assertApproxEqAbs(musd.balanceOf(treasury), 0.5e18, 1);
    }

    function testMultipleSeriesShareGlobalYieldProRata() public {
        uint256 maturity2 = maturity + 8 * SECONDS_PER_WEEK;
        tokenizer.initializeSeries(maturity2);

        _mintPy(alice, 1000e18);
        musd.mint(bob, 500e18);
        vm.startPrank(bob);
        musd.approve(address(tokenizer), 500e18);
        tokenizer.mintPyFromMusd(500e18, maturity2, bob);
        vm.stopPrank();

        _injectSmusdYield(0.5e18);
        tokenizer.syncYield();

        (uint256 alicePending,) = tokenizer.pendingYield(maturity, alice);
        (uint256 bobPending,) = tokenizer.pendingYield(maturity2, bob);
        assertApproxEqAbs(alicePending, 0.333333333333333333e18, 1000);
        assertApproxEqAbs(bobPending, 0.166666666666666666e18, 1000);
    }

    function testUpdateTrackAprsOnlyKeeper() public {
        vm.prank(bob);
        vm.expectRevert("only keeper");
        tokenizer.updateTrackAprs(600, 500);

        vm.prank(keeper);
        tokenizer.updateTrackAprs(600, 500);
        assertEq(adapter.gaugeMezoAprBps(), 600);
        assertEq(adapter.unstakedFeeAprBps(), 500);
    }

    function testEvaluateTrackModeStakesAndUnstakes() public {
        _mintPy(alice, 1000e18);
        vm.prank(keeper);
        tokenizer.updateTrackAprs(600, 500);

        uint256 mode = tokenizer.evaluateTrackMode();
        assertEq(mode, 1);
        assertEq(uint256(adapter.activeMode()), 1);
        assertEq(gauge.balanceOf(address(adapter)), 1000e18);

        vm.prank(keeper);
        tokenizer.updateTrackAprs(0, 500);
        mode = tokenizer.evaluateTrackMode();
        assertEq(mode, 0);
        assertEq(uint256(adapter.activeMode()), 0);
        assertEq(gauge.balanceOf(address(adapter)), 0);
        assertEq(adapter.totalSmusdControlled(), 1000e18);
    }

    function testRedeemWhileGaugeStaked() public {
        _mintPy(alice, 1000e18);
        vm.prank(keeper);
        tokenizer.updateTrackAprs(600, 500);
        tokenizer.evaluateTrackMode();

        vm.prank(alice);
        tokenizer.redeemPyBeforeMaturity(400e18, maturity, alice);

        assertEq(smusd.balanceOf(alice), 400e18);
        assertEq(adapter.totalSmusdControlled(), 600e18);
        assertEq(gauge.balanceOf(address(adapter)), 600e18);
    }

    function testRevertOnZeroAmountsAndZeroReceiver() public {
        _mintPy(alice, 100e18);
        vm.startPrank(alice);
        vm.expectRevert("amount=0");
        tokenizer.mintPyFromMusd(0, maturity, alice);
        vm.expectRevert("receiver=0");
        tokenizer.mintPyFromMusd(1e18, maturity, address(0));
        vm.expectRevert("receiver=0");
        tokenizer.redeemPyBeforeMaturity(1e18, maturity, address(0));
        vm.expectRevert("receiver=0");
        tokenizer.claimYield(maturity, address(0));
        vm.stopPrank();
    }

    function testOnlyYtCanCallBeforeYtTransfer() public {
        vm.expectRevert("only yt");
        tokenizer.beforeYtTransfer(maturity, alice, bob);
    }

    function testFuzzMintAndMatureRedeem(uint96 amount) public {
        uint256 pyAmount = bound(uint256(amount), 1, 1e24);
        _mintPy(alice, pyAmount);
        assertEq(adapter.totalSmusdControlled(), pyAmount);

        vm.warp(maturity);
        tokenizer.syncYield();

        vm.prank(alice);
        tokenizer.redeemPtAfterMaturity(pyAmount, maturity, alice);

        assertEq(smusd.balanceOf(alice), pyAmount);
        assertEq(adapter.totalSmusdControlled(), 0);
    }

    function testFuzzSmoothedRateIncreaseIsBounded(uint96 injection) public {
        uint256 amount = bound(uint256(injection), 1, 50e18);
        _mintPy(alice, 1000e18);

        uint256 rateBefore = tokenizer.smoothedExchangeRate();
        _injectSmusdYield(amount);
        assertEq(tokenizer.smoothedExchangeRate(), rateBefore);

        tokenizer.syncYield();
        uint256 rateAfter = tokenizer.smoothedExchangeRate();
        uint256 maxInstant = ((1e18 + rateBefore - 1e18) * 5) / BPS;
        assertLe(rateAfter - rateBefore, maxInstant + 1);
    }

    function testFuzzYieldClaimConservesValue(uint96 injection, uint96 mezoAmount) public {
        uint256 musdInjection = bound(uint256(injection), 1, 50e18);
        uint256 mezoInjection = bound(uint256(mezoAmount), 0, 100e18);

        _mintPy(alice, 1000e18);
        _injectSmusdYield(musdInjection);
        tokenizer.syncYield();
        if (mezoInjection != 0) {
            _injectMezo(mezoInjection);
            tokenizer.syncYield();
        }

        (uint256 pendingMusd, uint256 pendingMezo) = tokenizer.pendingYield(maturity, alice);

        vm.prank(alice);
        (uint256 netMusd, uint256 netMezo) = tokenizer.claimYield(maturity, alice);

        uint256 grossMusd = pendingMusd;
        uint256 grossMezo = pendingMezo;
        uint256 feeMusd = (grossMusd * FEE_BPS) / BPS;
        uint256 feeMezo = (grossMezo * FEE_BPS) / BPS;

        assertApproxEqAbs(netMusd + feeMusd, grossMusd, 2);
        assertApproxEqAbs(netMezo + feeMezo, grossMezo, 2);
        assertLe(netMusd, grossMusd);
        assertLe(netMezo, grossMezo);
    }
}
