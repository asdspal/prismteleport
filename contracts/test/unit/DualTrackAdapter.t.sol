// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {IMUSDSavingsGauge} from "../../src/interfaces/IMezoCore.sol";

contract MockSMUSD is ERC20 {
    constructor() ERC20("sMUSD", "sMUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockMEZO is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract DualTrackAdapterTest is Test {
    MockSMUSD internal smusd;
    MockMEZO internal mezo;
    MockMUSDSavingsGauge internal gauge;
    DualTrackAdapter internal adapter;

    address internal bob = address(0xB0B);

    function setUp() public {
        smusd = new MockSMUSD();
        mezo = new MockMEZO();
        gauge = new MockMUSDSavingsGauge(IERC20(address(smusd)), IERC20(address(mezo)));
        adapter =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500);
        adapter.initializeTokenizer(address(this));
    }

    function _deposit(uint256 amount) internal {
        smusd.mint(address(this), amount);
        smusd.approve(address(adapter), amount);
        adapter.depositSmusd(amount);
    }

    function _setAprs(uint256 gaugeAprBps, uint256 unstakedAprBps) internal {
        adapter.setAprs(gaugeAprBps, unstakedAprBps);
    }

    function testConstructorRejectsZeroTokens() public {
        vm.expectRevert("smusd=0");
        new DualTrackAdapter(IERC20(address(0)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500);

        vm.expectRevert("mezo=0");
        new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(0)), IMUSDSavingsGauge(address(gauge)), 500);
    }

    function testInitializeTokenizerOnce() public {
        DualTrackAdapter fresh =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500);

        vm.expectRevert("tokenizer=0");
        fresh.initializeTokenizer(address(0));

        fresh.initializeTokenizer(address(this));
        assertEq(fresh.tokenizer(), address(this));

        vm.expectRevert("already initialized");
        fresh.initializeTokenizer(bob);
    }

    function testOnlyTokenizerGuardsDepositsAndAprs() public {
        vm.startPrank(bob);
        vm.expectRevert("only tokenizer");
        adapter.depositSmusd(1e18);

        vm.expectRevert("only tokenizer");
        adapter.withdrawSmusd(1e18, bob);

        vm.expectRevert("only tokenizer");
        adapter.setAprs(1, 1);
        vm.stopPrank();
    }

    function testDepositUnstaked() public {
        _deposit(100e18);

        assertEq(uint256(adapter.activeMode()), 0);
        assertEq(smusd.balanceOf(address(adapter)), 100e18);
        assertEq(gauge.balanceOf(address(adapter)), 0);
        assertEq(adapter.totalSmusdControlled(), 100e18);
    }

    function testSwitchToGaugeAtThreshold() public {
        _deposit(100e18);
        _setAprs(550, 500);

        assertEq(uint256(adapter.evaluateAndSwitchMode()), 1);
        assertEq(uint256(adapter.activeMode()), 1);
        assertEq(smusd.balanceOf(address(adapter)), 0);
        assertEq(gauge.balanceOf(address(adapter)), 100e18);
        assertEq(adapter.totalSmusdControlled(), 100e18);
    }

    function testSwitchToGaugeWithNoDeposits() public {
        _setAprs(600, 500);
        assertEq(uint256(adapter.evaluateAndSwitchMode()), 1);
        assertEq(adapter.totalSmusdControlled(), 0);
    }

    function testHysteresisDeadband() public {
        _deposit(100e18);

        _setAprs(549, 500);
        adapter.evaluateAndSwitchMode();
        assertEq(uint256(adapter.activeMode()), 0);

        _setAprs(550, 500);
        adapter.evaluateAndSwitchMode();
        assertEq(uint256(adapter.activeMode()), 1);

        _setAprs(451, 500);
        adapter.evaluateAndSwitchMode();
        assertEq(uint256(adapter.activeMode()), 1);

        _setAprs(450, 500);
        adapter.evaluateAndSwitchMode();
        assertEq(uint256(adapter.activeMode()), 1);

        _setAprs(449, 500);
        adapter.evaluateAndSwitchMode();
        assertEq(uint256(adapter.activeMode()), 0);
    }

    function testSwitchBackWithNoGaugeBalance() public {
        _deposit(100e18);
        _setAprs(600, 500);
        adapter.evaluateAndSwitchMode();

        adapter.withdrawSmusd(100e18, address(this));
        assertEq(gauge.balanceOf(address(adapter)), 0);

        _setAprs(0, 500);
        adapter.evaluateAndSwitchMode();
        assertEq(uint256(adapter.activeMode()), 0);
    }

    function testGaugeZeroStaysUnstaked() public {
        DualTrackAdapter noGauge =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(0)), 500);
        noGauge.initializeTokenizer(address(this));

        smusd.mint(address(this), 100e18);
        smusd.approve(address(noGauge), 100e18);
        noGauge.depositSmusd(100e18);
        noGauge.setAprs(10_000, 0);

        assertEq(uint256(noGauge.evaluateAndSwitchMode()), 0);
        assertEq(noGauge.totalSmusdControlled(), 100e18);
    }

    function testDepositWhileGaugeModeStakes() public {
        _deposit(100e18);
        _setAprs(600, 500);
        adapter.evaluateAndSwitchMode();

        _deposit(50e18);
        assertEq(gauge.balanceOf(address(adapter)), 150e18);
        assertEq(smusd.balanceOf(address(adapter)), 0);
        assertEq(adapter.totalSmusdControlled(), 150e18);
    }

    function testWithdrawAutoUnstakesFromGauge() public {
        _deposit(100e18);
        _setAprs(600, 500);
        adapter.evaluateAndSwitchMode();

        adapter.withdrawSmusd(60e18, bob);
        assertEq(smusd.balanceOf(bob), 60e18);
        assertEq(gauge.balanceOf(address(adapter)), 40e18);
        assertEq(adapter.totalSmusdControlled(), 40e18);

        adapter.withdrawSmusd(40e18, bob);
        assertEq(smusd.balanceOf(bob), 100e18);
        assertEq(gauge.balanceOf(address(adapter)), 0);
        assertEq(adapter.totalSmusdControlled(), 0);
    }

    function testHarvestForwardsMezoToTokenizer() public {
        _deposit(100e18);
        _setAprs(600, 500);
        adapter.evaluateAndSwitchMode();

        mezo.mint(address(gauge), 10e18);
        gauge.notifyReward(address(adapter), 10e18);

        uint256 before = mezo.balanceOf(address(this));
        vm.prank(bob);
        uint256 harvested = adapter.harvestGaugeRewards();

        assertEq(harvested, 10e18);
        assertEq(mezo.balanceOf(address(this)) - before, 10e18);
        assertEq(gauge.rewards(address(adapter)), 0);
        assertEq(adapter.harvestGaugeRewards(), 0);
    }

    function testHarvestWithoutGaugeReverts() public {
        DualTrackAdapter noGauge =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(0)), 500);
        noGauge.initializeTokenizer(address(this));

        vm.expectRevert("gauge=0");
        noGauge.harvestGaugeRewards();
    }

    function testHarvestWithoutTokenizerReverts() public {
        DualTrackAdapter fresh =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500);

        vm.expectRevert("tokenizer not set");
        fresh.harvestGaugeRewards();
    }

    function testEvaluateIsPermissionless() public {
        _deposit(100e18);
        _setAprs(600, 500);

        vm.prank(bob);
        assertEq(uint256(adapter.evaluateAndSwitchMode()), 1);
        assertEq(uint256(adapter.activeMode()), 1);
    }

    function testRejectsZeroAmounts() public {
        vm.expectRevert("amount=0");
        adapter.depositSmusd(0);

        vm.expectRevert("amount=0");
        adapter.withdrawSmusd(0, address(this));

        vm.expectRevert(bytes("to=0"));
        adapter.withdrawSmusd(1, address(0));
    }

    function testFuzz_DepositWithdrawAccounting(uint96 first, uint96 second) public {
        uint256 a = bound(uint256(first), 1, 1_000e18);
        uint256 b = bound(uint256(second), 0, 1_000e18);

        _deposit(a);
        _setAprs(600, 500);
        adapter.evaluateAndSwitchMode();
        if (b != 0) _deposit(b);

        uint256 total = a + b;
        assertEq(adapter.totalSmusdControlled(), total);

        adapter.withdrawSmusd(total, bob);
        assertEq(smusd.balanceOf(bob), total);
        assertEq(gauge.balanceOf(address(adapter)), 0);
        assertEq(adapter.totalSmusdControlled(), 0);
    }

    function testFuzz_HysteresisDecision(uint256 gaugeAprBps, uint256 unstakedAprBps) public {
        uint256 gaugeApr = bound(gaugeAprBps, 0, 10_000);
        uint256 unstakedApr = bound(unstakedAprBps, 0, 10_000);

        _deposit(100e18);
        _setAprs(gaugeApr, unstakedApr);
        adapter.evaluateAndSwitchMode();

        uint256 expected = gaugeApr >= unstakedApr + 50 ? 1 : 0;
        assertEq(uint256(adapter.activeMode()), expected);
        assertEq(adapter.totalSmusdControlled(), 100e18);
    }
}
