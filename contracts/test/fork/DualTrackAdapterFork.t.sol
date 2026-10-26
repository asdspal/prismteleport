// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {IMUSDSavingsGauge} from "../../src/interfaces/IMezoCore.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";

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

contract DualTrackAdapterForkTest is Test {
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant SMUSD = 0xd0F748a45708E77bf00384ED1C0ACC2e968517c3;
    address internal constant MEZO = 0x7B7c000000000000000000000000000000000001;

    address internal alice = address(0xA11CE);

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC_URL", string("https://rpc.test.mezo.org")));
        assertEq(block.chainid, 31611, "expected Mezo Testnet");
    }

    function testForkGaugeLifecycleAgainstDeployedTestnetSMUSD() public {
        vm.etch(MUSD, address(new ForkMUSD()).code);
        deal(MUSD, alice, 0);
        ForkMUSD(MUSD).mint(alice, 100e18);
        vm.etch(MEZO, address(new ForkMEZO()).code);

        MockMUSDSavingsGauge gauge = new MockMUSDSavingsGauge(IERC20(SMUSD), IERC20(MEZO));
        DualTrackAdapter adapter =
            new DualTrackAdapter(IERC20(SMUSD), IERC20(MEZO), IMUSDSavingsGauge(address(gauge)), 500);
        adapter.initializeTokenizer(alice);

        vm.startPrank(alice);
        IERC20(MUSD).approve(SMUSD, 100e18);
        TestnetFeeInjector(SMUSD).deposit(100e18);
        assertEq(IERC20(SMUSD).balanceOf(alice), 100e18);

        IERC20(SMUSD).approve(address(adapter), 100e18);
        adapter.depositSmusd(100e18);
        assertEq(adapter.totalSmusdControlled(), 100e18);

        adapter.setAprs(600, 500);
        assertEq(uint256(adapter.evaluateAndSwitchMode()), 1);
        assertEq(IERC20(SMUSD).balanceOf(address(gauge)), 100e18);
        vm.stopPrank();

        ForkMEZO(MEZO).mint(address(gauge), 10e18);
        gauge.notifyReward(address(adapter), 10e18);
        uint256 before = IERC20(MEZO).balanceOf(alice);

        vm.prank(address(0xB0B));
        uint256 harvested = adapter.harvestGaugeRewards();
        assertEq(harvested, 10e18);
        assertEq(IERC20(MEZO).balanceOf(alice) - before, 10e18);

        vm.prank(alice);
        adapter.withdrawSmusd(100e18, alice);
        assertEq(adapter.totalSmusdControlled(), 0);
        assertEq(IERC20(SMUSD).balanceOf(alice), 100e18);

        vm.prank(alice);
        TestnetFeeInjector(SMUSD).withdraw(100e18);
        assertEq(IERC20(MUSD).balanceOf(alice), 100e18);
    }
}
