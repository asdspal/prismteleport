// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SmokeToken} from "../../src/SmokeToken.sol";

contract SetupSmokeTest is Test {
    SmokeToken internal token;
    address internal alice = address(0xA11CE);

    function setUp() public {
        token = new SmokeToken();
    }

    function testToolchainCompilesAndMintBurn() public {
        token.mint(alice, 1_000e18);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(token.totalSupply(), 1_000e18);

        token.burn(alice, 400e18);
        assertEq(token.balanceOf(alice), 600e18);
        assertEq(token.totalSupply(), 600e18);
    }

    function testMetadata() public view {
        assertEq(token.decimals(), 18);
        assertEq(token.name(), "Smoke");
        assertEq(token.symbol(), "SMOKE");
    }
}
