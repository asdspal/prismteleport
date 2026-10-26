// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";

contract MockMUSD is ERC20 {
    constructor() ERC20("MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TestnetFeeInjectorTest is Test {
    MockMUSD internal musd;
    TestnetFeeInjector internal injector;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal funder = address(0xF00D);

    function setUp() public {
        musd = new MockMUSD();
        injector = new TestnetFeeInjector(musd);
        musd.mint(alice, 1_000_000e18);
        musd.mint(bob, 1_000_000e18);
        musd.mint(funder, 1_000_000e18);
        vm.prank(alice);
        musd.approve(address(injector), type(uint256).max);
        vm.prank(bob);
        musd.approve(address(injector), type(uint256).max);
        vm.prank(funder);
        musd.approve(address(injector), type(uint256).max);
    }

    function testDepositMintsOneToOne() public {
        vm.prank(alice);
        injector.deposit(1_000e18);

        assertEq(injector.balanceOf(alice), 1_000e18);
        assertEq(injector.totalSupply(), 1_000e18);
        assertEq(injector.yieldPerShare(), 1e18);
        assertEq(musd.balanceOf(address(injector)), 1_000e18);
    }

    function testWithdrawReturnsPrincipal() public {
        vm.startPrank(alice);
        injector.deposit(1_000e18);
        injector.withdraw(400e18);
        vm.stopPrank();

        assertEq(injector.balanceOf(alice), 600e18);
        assertEq(musd.balanceOf(alice), 1_000_000e18 - 600e18);
    }

    function testInjectIncreasesYieldIndexAndClaimable() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.prank(bob);
        injector.deposit(1_000e18);

        vm.prank(funder);
        injector.injectWeeklyFeeYield(100e18);

        assertEq(injector.yieldIndex(), 0.05e18);
        assertEq(injector.yieldPerShare(), 1.05e18);
        assertEq(injector.claimableYield(alice), 50e18);
        assertEq(injector.claimableYield(bob), 50e18);

        vm.prank(alice);
        assertEq(injector.claimYield(), 50e18);
        assertEq(injector.claimableYield(alice), 0);
        assertEq(musd.balanceOf(alice), 1_000_000e18 - 1_000e18 + 50e18);
    }

    function testMultiUserProportionalRedemption() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.prank(bob);
        injector.deposit(3_000e18);

        vm.prank(funder);
        injector.injectWeeklyFeeYield(200e18);

        vm.startPrank(alice);
        injector.claimYield();
        injector.withdraw(1_000e18);
        vm.stopPrank();

        vm.startPrank(bob);
        injector.claimYield();
        injector.withdraw(3_000e18);
        vm.stopPrank();

        assertEq(musd.balanceOf(alice), 1_000_000e18 + 50e18);
        assertEq(musd.balanceOf(bob), 1_000_000e18 + 150e18);
        assertEq(injector.totalSupply(), 0);
        assertLe(injector.totalClaimable(), 2);
        assertEq(musd.balanceOf(address(injector)), 0);
    }

    function testTransferKeepsEarnedYieldWithSender() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.prank(funder);
        injector.injectWeeklyFeeYield(50e18);

        vm.prank(alice);
        injector.transfer(bob, 500e18);

        assertEq(injector.claimableYield(alice), 50e18);
        assertEq(injector.claimableYield(bob), 0);

        vm.warp(block.timestamp + 60);
        vm.prank(funder);
        injector.injectWeeklyFeeYield(20e18);

        assertEq(injector.claimableYield(alice), 60e18);
        assertEq(injector.claimableYield(bob), 10e18);
    }

    function testReceiveYieldFromStrategyDistributesDonatedExcess() public {
        vm.prank(alice);
        injector.deposit(1_000e18);

        musd.mint(address(injector), 100e18);
        injector.receiveYieldFromStrategy();

        assertEq(injector.yieldIndex(), 0.1e18);
        assertEq(injector.claimableYield(alice), 100e18);
    }

    function testInjectionCapReverts() public {
        vm.prank(alice);
        injector.deposit(1_000e18);

        vm.prank(alice);
        vm.expectRevert("fee cap");
        injector.injectWeeklyFeeYield(50e18 + 1);
    }

    function testInjectionCooldownReverts() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.startPrank(funder);
        injector.injectWeeklyFeeYield(10e18);
        vm.expectRevert("cooldown");
        injector.injectWeeklyFeeYield(10e18);
        vm.warp(block.timestamp + 60);
        injector.injectWeeklyFeeYield(10e18);
        vm.stopPrank();
    }

    function testFuzz_FeeInjectionConservesAssets(uint96 depositA, uint96 depositB, uint96 feeYield) public {
        uint256 a = bound(uint256(depositA), 1e6, 1e23);
        uint256 b = bound(uint256(depositB), 1e6, 1e23);
        uint256 supply = a + b;
        uint256 fee = bound(uint256(feeYield), 1, (supply * injector.MAX_FEE_BPS()) / injector.FEE_BPS_DENOMINATOR());

        vm.prank(alice);
        injector.deposit(a);
        vm.prank(bob);
        injector.deposit(b);

        vm.prank(funder);
        injector.injectWeeklyFeeYield(fee);

        vm.startPrank(alice);
        injector.claimYield();
        injector.withdraw(a);
        vm.stopPrank();

        vm.startPrank(bob);
        injector.claimYield();
        injector.withdraw(b);
        vm.stopPrank();

        assertEq(injector.totalSupply(), 0);
        assertLe(injector.totalClaimable(), 2);
        assertLe(musd.balanceOf(address(injector)), fee);
    }
}

contract TestnetFeeInjectorEdgeTest is Test {
    MockMUSD internal musd;
    TestnetFeeInjector internal injector;
    address internal alice = address(0xA11CE);

    function setUp() public {
        musd = new MockMUSD();
        injector = new TestnetFeeInjector(musd);
        musd.mint(alice, 1_000_000e18);
        vm.prank(alice);
        musd.approve(address(injector), type(uint256).max);
    }

    function testYieldTokenGetter() public view {
        assertEq(injector.yieldToken(), address(musd));
    }

    function testReceiveProtocolYieldRoutesThroughCap() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.prank(alice);
        injector.receiveProtocolYield(50e18);
        assertEq(injector.yieldIndex(), 0.05e18);
    }

    function testZeroAmountsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert("amount=0");
        injector.deposit(0);
        vm.expectRevert("amount=0");
        injector.withdraw(0);
        vm.expectRevert("amount=0");
        injector.injectWeeklyFeeYield(0);
        vm.stopPrank();
    }

    function testInjectWithoutSupplyReverts() public {
        vm.prank(alice);
        vm.expectRevert("no supply");
        injector.injectWeeklyFeeYield(1);
    }

    function testConstructorRejectsZeroAddress() public {
        vm.expectRevert("musd=0");
        new TestnetFeeInjector(IERC20(address(0)));
    }

    function testClaimWithoutYieldReturnsZero() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.prank(alice);
        assertEq(injector.claimYield(), 0);
    }

    function testStrategyHookNoExcessDoesNothing() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        injector.receiveYieldFromStrategy();
        assertEq(injector.yieldIndex(), 0);
    }

    function testTinyInjectionRoundsToZero() public {
        vm.prank(alice);
        injector.deposit(1e23);
        vm.prank(alice);
        injector.injectWeeklyFeeYield(1);
        assertEq(injector.yieldIndex(), 0);
        assertEq(injector.totalClaimable(), 0);
    }

    function testWithdrawMoreThanBalanceReverts() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.prank(alice);
        vm.expectRevert();
        injector.withdraw(1_001e18);
    }

    function testSelfTransferKeepsYield() public {
        vm.prank(alice);
        injector.deposit(1_000e18);
        vm.prank(alice);
        injector.injectWeeklyFeeYield(50e18);
        vm.prank(alice);
        injector.transfer(alice, 100e18);
        assertEq(injector.balanceOf(alice), 1_000e18);
        assertEq(injector.claimableYield(alice), 50e18);
    }
}
