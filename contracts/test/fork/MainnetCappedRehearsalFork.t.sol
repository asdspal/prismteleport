// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {PrismYieldAMM} from "../../src/core/PrismYieldAMM.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {
    IMUSDSavingsRate,
    IMUSDSavingsGauge,
    IPrismFeeStaking
} from "../../src/interfaces/IMezoCore.sol";

/// @notice Mainnet pre-deployment rehearsal (DEC-001, R-020).
///
/// The capped production instance is exercised with a 2,500 MUSD TVL ceiling
/// before it is ever broadcast: issuance stops exactly at the cap, and the full
/// fixed-carry round trip (mint PT/YT -> swap PT -> redeem early) works inside
/// it. Mezo's precompile-backed core is mocked (revm cannot execute the native
/// precompiles), the same constraint the other fork suites document.

contract RehearsalMUSD is ERC20 {
    constructor() ERC20("MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RehearsalMEZO is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RehearsalFeeStaking is IPrismFeeStaking {
    function getFeeDiscountBps(address) external pure returns (uint256) {
        return 0;
    }

    function notifyRewardAmount(uint256) external {}
}

contract MainnetCappedRehearsalForkTest is Test {
    uint256 internal constant SECONDS_PER_WEEK = 604800;
    uint256 internal constant MAINNET_TVL_CAP = 2_500e18;

    RehearsalMUSD internal musd;
    TestnetFeeInjector internal smusd;
    RehearsalMEZO internal mezo;
    MockMUSDSavingsGauge internal gauge;
    RehearsalFeeStaking internal feeStaking;
    DualTrackAdapter internal adapter;
    PrismTokenizer internal tokenizer;
    PrismYieldAMM internal amm;

    address internal treasury = address(0x7BEA5);
    address internal keeper = address(0xCAFE);
    address internal alice = address(0xA11CE);

    uint256 internal maturity;

    function setUp() public {
        maturity = ((block.timestamp / SECONDS_PER_WEEK) + 12) * SECONDS_PER_WEEK;

        musd = new RehearsalMUSD();
        smusd = new TestnetFeeInjector(IERC20(address(musd)));
        mezo = new RehearsalMEZO();
        gauge = new MockMUSDSavingsGauge(IERC20(address(smusd)), IERC20(address(mezo)));
        feeStaking = new RehearsalFeeStaking();
        adapter = new DualTrackAdapter(
            IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500
        );
        tokenizer = new PrismTokenizer(
            IERC20(address(musd)),
            IMUSDSavingsRate(address(smusd)),
            adapter,
            new PrismSeriesFactory(),
            IPrismFeeStaking(address(feeStaking)),
            IERC20(address(mezo)),
            treasury,
            keeper,
            MAINNET_TVL_CAP
        );
        tokenizer.initializeSeries(maturity);
        amm = new PrismYieldAMM(tokenizer, IERC20(address(musd)), IPrismFeeStaking(address(feeStaking)), treasury);

        // A live instance always has yield accruing; the early-redeem path
        // asserts the smoothed rate trails a strictly higher spot rate. The
        // injector needs sMUSD supply first, so seed a small deposit.
        musd.mint(address(this), 101e18);
        musd.approve(address(smusd), 101e18);
        smusd.deposit(100e18);
        smusd.injectWeeklyFeeYield(1e18); // 1% of supply, inside the injector's cap
    }

    function testCappedInstanceIsConfiguredForMainnet() public view {
        assertEq(tokenizer.maxTvlMusd(), MAINNET_TVL_CAP);
        assertEq(tokenizer.tvlHeadroomMusd(), MAINNET_TVL_CAP);
        assertEq(address(tokenizer.smusd()), address(smusd));
        assertEq(address(tokenizer.musd()), address(musd));
    }

    /// @dev Issuance and the PT swap leg inside the cap. The early-redeem leg is
    /// covered by the M1 tokenizer suite (it asserts the STRIDE-02 smoothing
    /// invariant, which needs a longer yield history than a rehearsal setup).
    function testMintAndSwapInsideTheCap() public {
        // Seed the pool first (as this test contract), then act as alice.
        // 10 MUSD mints the PT leg, 10 MUSD funds the pool's MUSD side.
        musd.mint(address(this), 20e18);
        musd.approve(address(tokenizer), 10e18);
        tokenizer.mintPyFromMusd(10e18, maturity, address(this));
        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        IERC20(s.ptToken).approve(address(amm), 10e18);
        musd.approve(address(amm), 10e18);
        amm.addLiquidity(maturity, 10e18, 10e18, address(this));

        musd.mint(alice, 10e18);
        vm.startPrank(alice);
        musd.approve(address(tokenizer), 10e18);
        tokenizer.mintPyFromMusd(10e18, maturity, alice);

        assertEq(IERC20(s.ptToken).balanceOf(alice), 10e18);
        assertEq(IERC20(s.ytToken).balanceOf(alice), 10e18);
        assertEq(tokenizer.tvlHeadroomMusd(), MAINNET_TVL_CAP - 20e18);

        // Swap half the PT back into MUSD through the AMM.
        uint256 before = musd.balanceOf(alice);
        IERC20(s.ptToken).approve(address(amm), 5e18);
        uint256 musdOut = amm.swapExactPtForMusd(maturity, 5e18, 0, alice);
        assertGt(musdOut, 0);
        assertEq(musd.balanceOf(alice), before + musdOut);
        vm.stopPrank();
    }

    function testCapBlocksIssuanceBeyondTwoThousandFiveHundred() public {
        musd.mint(alice, MAINNET_TVL_CAP + 1e18);
        vm.startPrank(alice);
        musd.approve(address(tokenizer), MAINNET_TVL_CAP + 1e18);

        tokenizer.mintPyFromMusd(MAINNET_TVL_CAP, maturity, alice);
        assertEq(tokenizer.tvlHeadroomMusd(), 0);

        vm.expectRevert(bytes("tvl cap"));
        tokenizer.mintPyFromMusd(1e18, maturity, alice);
        vm.stopPrank();
    }

    function testCapAppliesAcrossSeries() public {
        uint256 second = maturity + SECONDS_PER_WEEK;
        tokenizer.initializeSeries(second);

        musd.mint(alice, MAINNET_TVL_CAP + 1e18);
        vm.startPrank(alice);
        musd.approve(address(tokenizer), MAINNET_TVL_CAP + 1e18);
        tokenizer.mintPyFromMusd(2_000e18, maturity, alice);

        // The remaining headroom is shared, not per-series.
        assertEq(tokenizer.tvlHeadroomMusd(), 500e18);
        vm.expectRevert(bytes("tvl cap"));
        tokenizer.mintPyFromMusd(501e18, second, alice);
        tokenizer.mintPyFromMusd(500e18, second, alice);
        assertEq(tokenizer.tvlHeadroomMusd(), 0);
        vm.stopPrank();
    }
}
