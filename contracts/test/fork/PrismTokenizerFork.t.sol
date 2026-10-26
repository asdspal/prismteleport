// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {IMUSDSavingsRate, IMUSDSavingsGauge, IPrismFeeStaking} from "../../src/interfaces/IMezoCore.sol";

contract ForkMUSD is ERC20 {
    constructor() ERC20("MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ForkMEZO is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PrismTokenizerForkTest is Test {
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant SMUSD = 0xd0F748a45708E77bf00384ED1C0ACC2e968517c3;
    address internal constant MEZO = 0x7B7c000000000000000000000000000000000001;
    address internal constant FEE_STAKING = 0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7;

    address internal alice = address(0xA11CE);
    address internal treasury = address(0x7BEA5);

    PrismTokenizer internal tokenizer;
    DualTrackAdapter internal adapter;
    MockMUSDSavingsGauge internal gauge;
    uint256 internal maturity;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC_URL", string("https://rpc.test.mezo.org")));
        assertEq(block.chainid, 31611, "expected Mezo Testnet");

        vm.etch(MUSD, address(new ForkMUSD()).code);
        deal(MUSD, alice, 0);
        vm.etch(MEZO, address(new ForkMEZO()).code);

        maturity = ((block.timestamp / 604800) + 4) * 604800;

        gauge = new MockMUSDSavingsGauge(IERC20(SMUSD), IERC20(MEZO));
        adapter = new DualTrackAdapter(IERC20(SMUSD), IERC20(MEZO), IMUSDSavingsGauge(address(gauge)), 500);
        PrismSeriesFactory factory = new PrismSeriesFactory();
        tokenizer = new PrismTokenizer(
            IERC20(MUSD),
            IMUSDSavingsRate(SMUSD),
            adapter,
            factory,
            IPrismFeeStaking(FEE_STAKING),
            IERC20(MEZO),
            treasury,
            address(this)
        );
        tokenizer.initializeSeries(maturity);
    }

    function testForkMintYieldAndMatureRedeemAgainstLiveSMUSD() public {
        ForkMUSD(MUSD).mint(alice, 1000e18);
        vm.startPrank(alice);
        IERC20(MUSD).approve(address(tokenizer), 1000e18);
        tokenizer.mintPyFromMusd(1000e18, maturity, alice);
        vm.stopPrank();

        assertEq(adapter.totalSmusdControlled(), 1000e18);
        assertEq(IERC20(SMUSD).balanceOf(address(adapter)), 1000e18);

        uint256 beforeBalance = TestnetFeeInjector(SMUSD).musdToken().balanceOf(address(this));
        uint256 expectedYield =
            (0.5e18 * IERC20(SMUSD).balanceOf(address(adapter))) / TestnetFeeInjector(SMUSD).totalSupply();
        ForkMUSD(MUSD).mint(address(this), 0.5e18);
        IERC20(MUSD).approve(SMUSD, 0.5e18);
        TestnetFeeInjector(SMUSD).injectWeeklyFeeYield(0.5e18);
        assertEq(TestnetFeeInjector(SMUSD).musdToken().balanceOf(address(this)), beforeBalance);

        tokenizer.syncYield();
        (uint256 pendingMusd,) = tokenizer.pendingYield(maturity, alice);
        assertApproxEqAbs(pendingMusd, expectedYield, 1e6);

        uint256 expectedNet = (expectedYield * 9700) / 10_000;
        vm.prank(alice);
        (uint256 netMusd,) = tokenizer.claimYield(maturity, alice);
        assertApproxEqAbs(netMusd, expectedNet, 1e6);
        assertApproxEqAbs(IERC20(MUSD).balanceOf(alice), expectedNet, 1e6);

        ForkMEZO(MEZO).mint(address(gauge), 10e18);
        gauge.notifyReward(address(adapter), 10e18);
        tokenizer.syncYield();

        vm.prank(alice);
        (uint256 netMusdAfter, uint256 netMezo) = tokenizer.claimYield(maturity, alice);
        assertEq(netMusdAfter, 0);
        assertEq(netMezo, 9.7e18);
        assertEq(IERC20(MEZO).balanceOf(alice), 9.7e18);

        vm.warp(maturity);
        tokenizer.syncYield();

        vm.prank(alice);
        tokenizer.redeemPtAfterMaturity(1000e18, maturity, alice);
        assertEq(IERC20(SMUSD).balanceOf(alice), 1000e18);
        assertEq(adapter.totalSmusdControlled(), 0);
    }
}
