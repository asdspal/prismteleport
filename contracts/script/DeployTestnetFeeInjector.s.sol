// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestnetFeeInjector} from "../src/mocks/TestnetFeeInjector.sol";

/// @notice Deploy the testnet-only sMUSD simulator on Mezo Testnet (31611).
/// @dev Set RELAYER_PRIVATE_KEY to a funded testnet key. When unset (or zero),
///      falls back to Anvil's first account so `forge script` works against a fork.
contract DeployTestnetFeeInjector is Script {
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;

    function run() external returns (TestnetFeeInjector injector) {
        require(block.chainid == 31611, "wrong chain");

        uint256 pk = vm.envOr("RELAYER_PRIVATE_KEY", ANVIL_KEY);
        if (pk == 0) pk = ANVIL_KEY;
        address musd = vm.envOr("MEZO_TESTNET_MUSD_ADDRESS", TESTNET_MUSD);

        vm.startBroadcast(pk);
        injector = new TestnetFeeInjector(IERC20(musd));
        vm.stopBroadcast();

        console.log("TestnetFeeInjector:", address(injector));
        console.log("MUSD:", musd);
    }
}
