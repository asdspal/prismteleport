// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TeleportHub, INttManager} from "../src/teleport/TeleportHub.sol";
import {TeleportSpoke} from "../src/teleport/TeleportSpoke.sol";
import {PrismMicroVault} from "../src/teleport/PrismMicroVault.sol";
import {PrismYieldAMM} from "../src/core/PrismYieldAMM.sol";
import {PrismTokenizer} from "../src/core/PrismTokenizer.sol";
import {IBorrowerOperationsSignatures} from "../src/interfaces/IMezoCore.sol";

/// @notice Deploys the cross-chain Teleport suite: `TeleportHub` on Mezo Testnet
/// (31611) and `TeleportSpoke` on Base Sepolia (84532).
contract DeployMezoHub is Script {
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    address internal constant TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant TESTNET_BOPS_SIG = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address internal constant TESTNET_AMM = 0xa40D6d099c8e5e86841367Ed384EDD09859bA979;
    address internal constant TESTNET_TOKENIZER = 0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3;
    /// @dev Mock/placeholder NTT manager: Mezo Testnet has no canonical MUSD NTT
    /// deployment, so the MUSD-teleport leg points at an operator-provided one.
    address internal constant TESTNET_NTT = 0x5E668D912F69db0762CD0fE00647dA9fa6b29591;
    uint16 internal constant BASE_SEPOLIA_WORMHOLE_ID = 10004;

    function run() external returns (TeleportHub hub) {
        require(block.chainid == 31611, "wrong chain");
        uint256 pk = vm.envOr("RELAYER_PRIVATE_KEY", ANVIL_KEY);
        address payable vault = payable(vm.envOr("PRISM_MICRO_VAULT_ADDRESS", address(0)));
        require(vault != address(0), "set PRISM_MICRO_VAULT_ADDRESS");

        vm.startBroadcast(pk);
        hub = new TeleportHub(
            IERC20(TESTNET_MUSD),
            IBorrowerOperationsSignatures(TESTNET_BOPS_SIG),
            PrismMicroVault(vault),
            PrismYieldAMM(TESTNET_AMM),
            PrismTokenizer(TESTNET_TOKENIZER),
            INttManager(TESTNET_NTT),
            BASE_SEPOLIA_WORMHOLE_ID
        );
        vm.stopBroadcast();

        console.log("TeleportHub:", address(hub));
    }
}

contract DeployBaseSpoke is Script {
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (TeleportSpoke spoke) {
        require(block.chainid == 84532, "wrong chain");
        uint256 pk = vm.envOr("RELAYER_PRIVATE_KEY", ANVIL_KEY);
        address btc = vm.envOr("BASE_BTC_TOKEN", address(0));
        address musd = vm.envOr("BASE_MUSD_TOKEN", address(0));
        address ntt = vm.envOr("BASE_NTT_MANAGER", address(0));
        address hub = vm.envOr("TELEPORT_HUB_ADDRESS", address(0));
        require(btc != address(0) && musd != address(0) && ntt != address(0) && hub != address(0), "missing env");

        vm.startBroadcast(pk);
        spoke = new TeleportSpoke(
            IERC20(btc), IERC20(musd), INttManager(ntt), 31611, bytes32(uint256(uint160(hub)))
        );
        vm.stopBroadcast();

        console.log("TeleportSpoke:", address(spoke));
    }
}
