// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismTokenizer} from "../src/core/PrismTokenizer.sol";
import {DualTrackAdapter} from "../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../src/core/tokens/PrismSeriesFactory.sol";
import {IMUSDSavingsRate, IPrismFeeStaking} from "../src/interfaces/IMezoCore.sol";

contract DeployPrismTokenizer is Script {
    address internal constant TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant TESTNET_SMUSD = 0xd0F748a45708E77bf00384ED1C0ACC2e968517c3;
    address internal constant TESTNET_MEZO = 0x7B7c000000000000000000000000000000000001;
    address internal constant TESTNET_ADAPTER = 0xF4E0D1C1dD0a4D9d9b5e855C02bde6CCFbc1CbA5;
    address internal constant TESTNET_FEE_STAKING = 0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7;

    function run() external returns (PrismSeriesFactory factory, PrismTokenizer tokenizer) {
        require(block.chainid == 31611, "wrong chain");

        address musd = vm.envOr("MEZO_TESTNET_MUSD_ADDRESS", TESTNET_MUSD);
        address smusd = vm.envOr("MEZO_TESTNET_SMUSD_ADDRESS", TESTNET_SMUSD);
        address mezo = vm.envOr("MEZO_TOKEN_PRECOMPILE", TESTNET_MEZO);
        address adapter = vm.envOr("DUAL_TRACK_ADAPTER_ADDRESS", TESTNET_ADAPTER);
        address feeStaking = vm.envOr("PRISM_FEE_STAKING_ADDRESS", TESTNET_FEE_STAKING);
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);
        address keeper = vm.envOr("KEEPER_ADDRESS", msg.sender);

        uint256 currentWeek = block.timestamp / 604800;
        uint256 fourWeekMaturity = (currentWeek + 4) * 604800;
        uint256 twelveWeekMaturity = (currentWeek + 12) * 604800;

        vm.startBroadcast();
        factory = new PrismSeriesFactory();
        tokenizer = new PrismTokenizer(
            IERC20(musd),
            IMUSDSavingsRate(smusd),
            DualTrackAdapter(adapter),
            factory,
            IPrismFeeStaking(feeStaking),
            IERC20(mezo),
            treasury,
            keeper
        );
        tokenizer.initializeSeries(fourWeekMaturity);
        tokenizer.initializeSeries(twelveWeekMaturity);
        vm.stopBroadcast();

        console.log("PrismSeriesFactory:", address(factory));
        console.log("PrismTokenizer:", address(tokenizer));
        console.log("DualTrackAdapter:", adapter);
        console.log("MUSD:", musd);
        console.log("sMUSD:", smusd);
        console.log("MEZO:", mezo);
        console.log("PrismFeeStaking:", feeStaking);
        console.log("Treasury:", treasury);
        console.log("Keeper:", keeper);
        console.log("4-week maturity:", fourWeekMaturity);
        console.log("12-week maturity:", twelveWeekMaturity);
    }
}
