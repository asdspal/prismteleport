// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismFeeStaking} from "../src/core/PrismFeeStaking.sol";

contract DeployPrismFeeStaking is Script {
    address internal constant TESTNET_MEZO = 0x7B7c000000000000000000000000000000000001;
    address internal constant TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;

    function run() external returns (PrismFeeStaking staking) {
        require(block.chainid == 31611, "wrong chain");

        address mezo = vm.envOr("MEZO_TOKEN_PRECOMPILE", TESTNET_MEZO);
        address musd = vm.envOr("MEZO_TESTNET_MUSD_ADDRESS", TESTNET_MUSD);

        vm.startBroadcast();
        staking = new PrismFeeStaking(IERC20(mezo), IERC20(musd));
        vm.stopBroadcast();

        console.log("PrismFeeStaking:", address(staking));
        console.log("MEZO:", mezo);
        console.log("MUSD:", musd);
    }
}
