// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismMicroVault} from "../src/teleport/PrismMicroVault.sol";
import {PrismYieldAMM} from "../src/core/PrismYieldAMM.sol";
import {PrismTokenizer} from "../src/core/PrismTokenizer.sol";
import {
    IBorrowerOperations,
    IMUSDSavingsRate,
    IPriceFeed,
    ITroveManager
} from "../src/interfaces/IMezoCore.sol";

/// @notice Deploys PrismMicroVault (sub-1,800 MUSD shared-Trove adapter) on Mezo
/// Testnet 31611.
///
/// The master Trove needs >= 1,800 MUSD of debt, which requires roughly 0.05 BTC
/// of collateral. If `PRISM_VAULT_MASTER_BTC` is set (e.g. `0.07ether`) the script
/// also activates the master Trove in the same broadcast; otherwise the vault
/// ships inactive and anyone may call `activateMasterTrove{value: ...}` later,
/// which is the lazy-activation path the plan allows.
contract DeployPrismMicroVault is Script {
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    address internal constant TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant TESTNET_SMUSD = 0xd0F748a45708E77bf00384ED1C0ACC2e968517c3;
    address internal constant TESTNET_BORROWER_OPS = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;
    address internal constant TESTNET_TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address internal constant TESTNET_PRICE_FEED = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
    address internal constant TESTNET_AMM = 0xa40D6d099c8e5e86841367Ed384EDD09859bA979;
    address internal constant TESTNET_TOKENIZER = 0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3;

    function run() external returns (PrismMicroVault vault) {
        require(block.chainid == 31611, "wrong chain");

        uint256 pk = vm.envOr("RELAYER_PRIVATE_KEY", ANVIL_KEY);
        if (pk == 0) pk = ANVIL_KEY;

        uint256 masterBtc = vm.envOr("PRISM_VAULT_MASTER_BTC", uint256(0));

        vm.startBroadcast(pk);
        vault = new PrismMicroVault(
            IERC20(TESTNET_MUSD),
            IMUSDSavingsRate(TESTNET_SMUSD),
            IBorrowerOperations(TESTNET_BORROWER_OPS),
            ITroveManager(TESTNET_TROVE_MANAGER),
            IPriceFeed(TESTNET_PRICE_FEED),
            PrismYieldAMM(TESTNET_AMM),
            PrismTokenizer(TESTNET_TOKENIZER)
        );

        if (masterBtc > 0) {
            vault.activateMasterTrove{value: masterBtc}(2_000e18, address(0), address(0));
        }
        vm.stopBroadcast();

        console.log("PrismMicroVault:", address(vault));
        console.log("masterActive:", vault.masterActive());
        console.log("masterBtcProvided (wei):", masterBtc);
    }
}
