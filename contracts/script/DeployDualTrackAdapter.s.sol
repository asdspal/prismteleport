// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DualTrackAdapter} from "../src/core/DualTrackAdapter.sol";
import {MockMUSDSavingsGauge} from "../src/mocks/MockMUSDSavingsGauge.sol";
import {IMUSDSavingsGauge} from "../src/interfaces/IMezoCore.sol";

contract DeployDualTrackAdapter is Script {
    address internal constant TESTNET_MEZO = 0x7B7c000000000000000000000000000000000001;
    address internal constant TESTNET_SMUSD = 0xd0F748a45708E77bf00384ED1C0ACC2e968517c3;

    function run() external returns (MockMUSDSavingsGauge gauge, DualTrackAdapter adapter) {
        require(block.chainid == 31611, "wrong chain");

        address mezo = vm.envOr("MEZO_TOKEN_PRECOMPILE", TESTNET_MEZO);
        address smusd = vm.envOr("MEZO_TESTNET_SMUSD_ADDRESS", TESTNET_SMUSD);
        uint256 unstakedFeeAprBps = vm.envOr("UNSTAKED_FEE_APR_BPS", uint256(500));

        vm.startBroadcast();
        gauge = new MockMUSDSavingsGauge(IERC20(smusd), IERC20(mezo));
        adapter =
            new DualTrackAdapter(IERC20(smusd), IERC20(mezo), IMUSDSavingsGauge(address(gauge)), unstakedFeeAprBps);
        vm.stopBroadcast();

        console.log("MockMUSDSavingsGauge:", address(gauge));
        console.log("DualTrackAdapter:", address(adapter));
        console.log("sMUSD:", smusd);
        console.log("MEZO:", mezo);
        console.log("unstakedFeeAprBps:", unstakedFeeAprBps);
    }
}
