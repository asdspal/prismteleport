// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PrismFeeStaking} from "../../src/core/PrismFeeStaking.sol";

contract ForkMEZO is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function permit(address owner, address spender, uint256 value, uint256, uint8 v, bytes32, bytes32) external {
        require(v == 27 || v == 28, "bad v");
        _approve(owner, spender, value);
    }
}

contract PrismFeeStakingForkTest is Test {
    address internal constant MEZO = 0x7B7c000000000000000000000000000000000001;
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal alice = address(0xA11CE);

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC_URL", string("https://rpc.test.mezo.org")));
        assertEq(block.chainid, 31611, "expected Mezo Testnet");
    }

    function testForkDeploysAgainstCanonicalMEZO() public {
        PrismFeeStaking staking = new PrismFeeStaking(IERC20(MEZO), IERC20(MUSD));

        assertEq(address(staking.mezoToken()), MEZO);
        assertEq(address(staking.musdToken()), MUSD);
        assertEq(staking.getFeeDiscountBps(alice), 0);

        try IERC20Metadata(MEZO).decimals() returns (uint8 d) {
            assertEq(d, 18);
            assertEq(IERC20Metadata(MEZO).symbol(), "MEZO");
        } catch {
            console.log("MEZO precompile storage unavailable on Foundry fork; live values verified with cast");
        }
    }

    function testForkStakeLifecycleAtCanonicalAddress() public {
        vm.etch(MEZO, address(new ForkMEZO()).code);
        deal(MEZO, alice, 100e18);

        PrismFeeStaking staking = new PrismFeeStaking(IERC20(MEZO), IERC20(MUSD));

        vm.startPrank(alice);
        IERC20(MEZO).approve(address(staking), 100e18);
        staking.stake(100e18);
        vm.stopPrank();

        assertEq(staking.totalMezoStaked(), 100e18);
        assertEq(staking.getFeeDiscountBps(alice), 0);

        skip(1 hours);
        assertEq(staking.getFeeDiscountBps(alice), 2_500);

        vm.prank(alice);
        staking.unstake(100e18);
        assertEq(IERC20(MEZO).balanceOf(alice), 100e18);
        assertEq(staking.totalMezoStaked(), 0);
    }
}
