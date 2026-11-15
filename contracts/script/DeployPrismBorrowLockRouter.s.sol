// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismBorrowLockRouter} from "../src/core/PrismBorrowLockRouter.sol";
import {PrismYieldAMM} from "../src/core/PrismYieldAMM.sol";
import {IBorrowerOperationsSignatures, ITroveManager, IPriceFeed} from "../src/interfaces/IMezoCore.sol";

/// @notice Stateless Borrow & Lock router on Mezo Testnet (31611).
contract DeployPrismBorrowLockRouter is Script {
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    address internal constant TESTNET_BOPS_SIG = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address internal constant TESTNET_TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address internal constant TESTNET_PRICE_FEED = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
    address internal constant TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant TESTNET_AMM = 0xa40D6d099c8e5e86841367Ed384EDD09859bA979;

    function run() external returns (PrismBorrowLockRouter router) {
        require(block.chainid == 31611, "wrong chain");

        uint256 pk = vm.envOr("RELAYER_PRIVATE_KEY", ANVIL_KEY);
        if (pk == 0) pk = ANVIL_KEY;

        address bopsSig = vm.envOr("BORROWER_OPS_SIG_ADDRESS", TESTNET_BOPS_SIG);
        address troveManager = vm.envOr("TROVE_MANAGER_ADDRESS", TESTNET_TROVE_MANAGER);
        address priceFeed = vm.envOr("PRICE_FEED_ADDRESS", TESTNET_PRICE_FEED);
        address musdAddr = vm.envOr("MUSD_ADDRESS", TESTNET_MUSD);
        address ammAddr = vm.envOr("PRISM_YIELD_AMM_ADDRESS", TESTNET_AMM);
        require(ammAddr != address(0), "amm not set");

        vm.startBroadcast(pk);
        router = new PrismBorrowLockRouter(
            IBorrowerOperationsSignatures(bopsSig),
            ITroveManager(troveManager),
            IPriceFeed(priceFeed),
            PrismYieldAMM(ammAddr),
            IERC20(musdAddr)
        );
        vm.stopBroadcast();

        console.log("PrismBorrowLockRouter:", address(router));
        console.log("BorrowerOpsSignatures:", bopsSig);
        console.log("TroveManager:", troveManager);
        console.log("PriceFeed:", priceFeed);
        console.log("PrismYieldAMM:", ammAddr);
        console.log("MUSD:", musdAddr);
    }
}
