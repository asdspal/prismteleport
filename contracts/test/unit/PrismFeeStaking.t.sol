// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismFeeStaking} from "../../src/core/PrismFeeStaking.sol";

contract MockMEZO is ERC20 {
    bool public permitResult = true;

    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPermitResult(bool value) external {
        permitResult = value;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32, bytes32)
        external
        returns (bool)
    {
        require(deadline >= block.timestamp, "expired");
        require(v == 27 || v == 28, "bad v");
        if (!permitResult) return false;
        _approve(owner, spender, value);
        return true;
    }
}

contract MockMEZOVoidPermit is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function permit(address owner, address spender, uint256 value, uint256, uint8 v, bytes32, bytes32) external {
        require(v == 27 || v == 28, "bad v");
        _approve(owner, spender, value);
    }
}

contract MockMEZOBadPermitReturn is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external pure returns (bool, bool) {
        return (true, true);
    }
}

contract MockMUSD is ERC20 {
    constructor() ERC20("MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PrismFeeStakingTest is Test {
    MockMEZO internal mezo;
    MockMUSD internal musd;
    PrismFeeStaking internal staking;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA201);
    address internal revenue = address(0xFEE);

    function setUp() public {
        mezo = new MockMEZO();
        musd = new MockMUSD();
        staking = new PrismFeeStaking(IERC20(address(mezo)), IERC20(address(musd)));
    }

    function _stake(address user, uint256 amount) internal {
        mezo.mint(user, amount);
        vm.startPrank(user);
        mezo.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function _notify(uint256 amount) internal {
        musd.mint(revenue, amount);
        vm.startPrank(revenue);
        musd.approve(address(staking), amount);
        staking.notifyRewardAmount(amount);
        vm.stopPrank();
    }

    function _expectedTier(uint256 amount) internal pure returns (uint256) {
        if (amount >= 500e18) return 5_000;
        if (amount >= 100e18) return 2_500;
        if (amount >= 10e18) return 1_000;
        return 0;
    }

    function testStakeSetsTimestampAndAmount() public {
        _stake(alice, 50e18);

        (uint256 amount, uint256 lastStake, uint256 rewardDebt, uint256 claimable) = staking.stakes(alice);
        assertEq(amount, 50e18);
        assertEq(rewardDebt, 0);
        assertEq(claimable, 0);
        assertEq(lastStake, block.timestamp);
        assertEq(staking.totalMezoStaked(), 50e18);
        assertEq(mezo.balanceOf(address(staking)), 50e18);
    }

    function testFlashStakeGetsZeroDiscount() public {
        _stake(alice, 500e18);
        assertEq(staking.getFeeDiscountBps(alice), 0, "fresh stake must not discount");

        skip(3_599);
        assertEq(staking.getFeeDiscountBps(alice), 0, "discount before cooldown");

        vm.warp(block.timestamp + 1);
        assertEq(staking.getFeeDiscountBps(alice), 5_000, "discount after one hour");
    }

    function testTierBoundaries() public {
        address[7] memory users = [
            address(0x1001),
            address(0x1002),
            address(0x1003),
            address(0x1004),
            address(0x1005),
            address(0x1006),
            address(0x1007)
        ];
        uint256[7] memory amounts = [uint256(9_999e15), 10e18, 99_999e15, 100e18, 499_999e15, 500e18, 1_000e18];

        for (uint256 i; i < users.length; ++i) {
            _stake(users[i], amounts[i]);
            skip(1 hours);
            assertEq(staking.getFeeDiscountBps(users[i]), _expectedTier(amounts[i]), "tier mismatch");
        }
    }

    function testTopUpResetsCooldown() public {
        _stake(alice, 500e18);
        skip(30 minutes);
        _stake(alice, 1e18);

        skip(30 minutes);
        assertEq(staking.getFeeDiscountBps(alice), 0, "top-up must restart cooldown");

        skip(30 minutes);
        assertEq(staking.getFeeDiscountBps(alice), 5_000);
    }

    function testUnstakeReturnsPrincipalAndKeepsRewards() public {
        _stake(alice, 100e18);
        _notify(50e18);

        skip(1 hours);
        assertEq(staking.pendingMusd(alice), 50e18);

        vm.prank(alice);
        staking.unstake(100e18);

        assertEq(mezo.balanceOf(alice), 100e18);
        assertEq(staking.totalMezoStaked(), 0);
        assertEq(staking.pendingMusd(alice), 50e18);

        vm.prank(alice);
        staking.claimRewards();
        assertEq(musd.balanceOf(alice), 50e18);
        assertEq(staking.pendingMusd(alice), 0);
    }

    function testClaimRewardsProRata() public {
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        _notify(400e18);

        assertEq(staking.pendingMusd(alice), 100e18);
        assertEq(staking.pendingMusd(bob), 300e18);

        vm.prank(alice);
        staking.claimRewards();
        vm.prank(bob);
        staking.claimRewards();

        assertEq(musd.balanceOf(alice), 100e18);
        assertEq(musd.balanceOf(bob), 300e18);
        assertEq(musd.balanceOf(address(staking)), 0);
    }

    function testNotifyBeforeStakersIsBufferedThenFolded() public {
        _notify(60e18);
        assertEq(staking.unallocatedMusdBuffer(), 60e18);
        assertEq(staking.totalMezoStaked(), 0);

        _stake(alice, 100e18);
        assertEq(staking.pendingMusd(alice), 0);

        _notify(40e18);
        assertEq(staking.unallocatedMusdBuffer(), 0);
        assertEq(staking.pendingMusd(alice), 100e18);

        vm.prank(alice);
        staking.claimRewards();
        assertEq(musd.balanceOf(alice), 100e18);
    }

    function testDustStaysBufferedUntilDistributable() public {
        _stake(alice, 1e18);
        _stake(bob, 1e18);
        _stake(carol, 1e18);

        _notify(1);
        assertEq(staking.unallocatedMusdBuffer(), 1);
        assertEq(staking.accMusdPerMezo(), 0);

        _notify(2);
        assertEq(staking.unallocatedMusdBuffer(), 0);
        assertEq(staking.pendingMusd(alice), 1);
        assertEq(staking.pendingMusd(bob), 1);
        assertEq(staking.pendingMusd(carol), 1);
    }

    function testStakeWithPermitNormalizesV() public {
        mezo.mint(alice, 10e18);
        mezo.mint(bob, 20e18);

        vm.prank(alice);
        staking.stakeWithPermit(10e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));

        vm.prank(bob);
        staking.stakeWithPermit(20e18, block.timestamp + 1 hours, 1, bytes32(0), bytes32(0));

        (uint256 aliceStake,,,) = staking.stakes(alice);
        (uint256 bobStake,,,) = staking.stakes(bob);
        assertEq(aliceStake, 10e18);
        assertEq(bobStake, 20e18);
        assertEq(staking.totalMezoStaked(), 30e18);
    }

    function testStakeWithPermitAcceptsEmptyReturn() public {
        MockMEZOVoidPermit voidMezo = new MockMEZOVoidPermit();
        PrismFeeStaking voidStaking = new PrismFeeStaking(IERC20(address(voidMezo)), IERC20(address(musd)));
        voidMezo.mint(alice, 10e18);

        vm.prank(alice);
        voidStaking.stakeWithPermit(10e18, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));

        (uint256 staked,,,) = voidStaking.stakes(alice);
        assertEq(staked, 10e18);
    }

    function testStakeWithPermitRejectsFalseReturn() public {
        mezo.setPermitResult(false);
        mezo.mint(alice, 10e18);

        vm.prank(alice);
        vm.expectRevert("permit denied");
        staking.stakeWithPermit(10e18, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));
    }

    function testStakeWithPermitRejectsUnexpectedReturnLength() public {
        MockMEZOBadPermitReturn badMezo = new MockMEZOBadPermitReturn();
        PrismFeeStaking badStaking = new PrismFeeStaking(IERC20(address(badMezo)), IERC20(address(musd)));
        badMezo.mint(alice, 10e18);

        vm.prank(alice);
        vm.expectRevert("permit bad return");
        badStaking.stakeWithPermit(10e18, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));
    }

    function testStakeWithPermitBubblesFailedCall() public {
        mezo.mint(alice, 10e18);

        vm.prank(alice);
        vm.expectRevert("permit failed");
        staking.stakeWithPermit(10e18, block.timestamp + 1 hours, 5, bytes32(0), bytes32(0));
    }

    function testRejectsZeroAndInvalidAmounts() public {
        vm.expectRevert("mezo=0");
        new PrismFeeStaking(IERC20(address(0)), IERC20(address(musd)));

        vm.expectRevert("musd=0");
        new PrismFeeStaking(IERC20(address(mezo)), IERC20(address(0)));

        vm.prank(alice);
        vm.expectRevert("amount=0");
        staking.stake(0);

        vm.prank(alice);
        vm.expectRevert("amount=0");
        staking.unstake(0);

        vm.prank(alice);
        vm.expectRevert("insufficient stake");
        staking.unstake(1);

        vm.prank(alice);
        vm.expectRevert("no rewards");
        staking.claimRewards();

        vm.prank(revenue);
        vm.expectRevert("amount=0");
        staking.notifyRewardAmount(0);
    }

    function testEvents() public {
        mezo.mint(alice, 10e18);
        vm.startPrank(alice);
        mezo.approve(address(staking), 10e18);
        vm.expectEmit(true, false, false, true, address(staking));
        emit Staked(alice, 10e18);
        staking.stake(10e18);

        vm.expectEmit(true, false, false, true, address(staking));
        emit Unstaked(alice, 10e18);
        staking.unstake(10e18);
        vm.stopPrank();
    }

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);

    function testFuzz_DiscountTiers(uint256 amount) public {
        amount = bound(amount, 1, 1_000e18);
        _stake(alice, amount);

        skip(1 hours - 1);
        assertEq(staking.getFeeDiscountBps(alice), 0);

        vm.warp(block.timestamp + 1);
        assertEq(staking.getFeeDiscountBps(alice), _expectedTier(amount));
    }

    function testFuzz_RewardConservation(uint256 a, uint256 b, uint256 reward) public {
        a = bound(a, 1e18, 1_000e18);
        b = bound(b, 1e18, 1_000e18);
        reward = bound(reward, 1e6, 1_000_000e18);

        _stake(alice, a);
        _stake(bob, b);
        _notify(reward);

        uint256 acc = staking.accMusdPerMezo();
        uint256 expectedA = (a * acc) / 1e18;
        uint256 expectedB = (b * acc) / 1e18;
        assertEq(staking.pendingMusd(alice), expectedA);
        assertEq(staking.pendingMusd(bob), expectedB);

        vm.prank(alice);
        staking.claimRewards();
        vm.prank(bob);
        staking.claimRewards();

        uint256 claimed = musd.balanceOf(alice) + musd.balanceOf(bob);
        assertEq(claimed + musd.balanceOf(address(staking)), reward);
        assertLe(staking.unallocatedMusdBuffer(), musd.balanceOf(address(staking)));
        assertGe(claimed + staking.unallocatedMusdBuffer(), reward - 1);
    }

    function testFuzz_StakeUnstakeKeepsPrincipal(uint256 amount, uint256 reward) public {
        amount = bound(amount, 1e18, 1_000e18);
        reward = bound(reward, 1e6, 1_000_000e18);

        _stake(alice, amount);
        _notify(reward);
        skip(7 days);

        vm.prank(alice);
        staking.unstake(amount);

        assertEq(mezo.balanceOf(alice), amount);
        assertEq(staking.totalMezoStaked(), 0);
        (,,, uint256 claimable) = staking.stakes(alice);
        assertEq(staking.pendingMusd(alice), claimable);

        vm.prank(alice);
        staking.claimRewards();
        assertEq(musd.balanceOf(alice) + musd.balanceOf(address(staking)), reward);
    }
}
