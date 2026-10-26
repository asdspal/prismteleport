// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismTokenizer} from "../src/core/PrismTokenizer.sol";
import {PrismYieldAMM} from "../src/core/PrismYieldAMM.sol";
import {PrismFeeStaking} from "../src/core/PrismFeeStaking.sol";
import {TestnetFeeInjector} from "../src/mocks/TestnetFeeInjector.sol";

/// @title VerifyMilestone1OnChain
/// @notice Executes the Milestone 1 lifecycle on Mezo Testnet (31611).
/// @dev Foundry's revm cannot simulate Mezo native precompiles, so this script is
///      provided for chains that emulate them. The live 31611 proof was executed
///      with `cast send`; see `deployments/31611-m1-proof.md`.
contract VerifyMilestone1OnChain is Script {
    address internal constant DEPLOYER = 0xfCe44470aC130E66849Aaa23F81D092066ff501E;
    address internal constant MEZO = 0x7B7c000000000000000000000000000000000001;
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant STAKING = 0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7;
    address internal constant TOKENIZER = 0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3;
    address internal constant AMM = 0xa40D6d099c8e5e86841367Ed384EDD09859bA979;
    address internal constant INJECTOR = 0xd0F748a45708E77bf00384ED1C0ACC2e968517c3;
    uint256 internal constant MATURITY = 1795046400;

    uint256 internal constant STAKE_AMOUNT = 50e18;
    uint256 internal constant MINT_AMOUNT = 10e18;
    uint256 internal constant SWAP_AMOUNT = 10e18;
    uint256 internal constant FEE_AMOUNT = 5e18;

    function run() external {
        require(block.timestamp < MATURITY, "4-week series matured");
        vm.startBroadcast();

        IERC20(MEZO).approve(STAKING, type(uint256).max);
        PrismFeeStaking(STAKING).stake(STAKE_AMOUNT);
        console2.log("1. staked MEZO", STAKE_AMOUNT);

        IERC20(MUSD).approve(TOKENIZER, type(uint256).max);
        PrismTokenizer(TOKENIZER).mintPyFromMusd(MINT_AMOUNT, MATURITY, DEPLOYER);
        console2.log("2. minted PY", MINT_AMOUNT);

        IERC20(MUSD).approve(AMM, type(uint256).max);
        PrismYieldAMM(AMM).swapExactMusdForPt(MATURITY, SWAP_AMOUNT, 0, DEPLOYER);
        console2.log("3. swapped MUSD for PT", SWAP_AMOUNT);

        IERC20(MUSD).approve(INJECTOR, type(uint256).max);
        TestnetFeeInjector(INJECTOR).injectWeeklyFeeYield(FEE_AMOUNT);
        console2.log("4. injected fee yield", FEE_AMOUNT);

        PrismTokenizer(TOKENIZER).claimYield(MATURITY, DEPLOYER);
        console2.log("5. claimed YT yield");

        vm.stopBroadcast();
    }
}
