// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismTokenizer} from "../src/core/PrismTokenizer.sol";
import {PrismYieldAMM} from "../src/core/PrismYieldAMM.sol";
import {IPrismFeeStaking, IBorrowerOperations} from "../src/interfaces/IMezoCore.sol";

interface ITroveManagerView {
    function getTroveStatus(address borrower) external view returns (uint256);
}

contract DeployPrismYieldAMM is Script {
    address internal constant TESTNET_TOKENIZER = 0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3;
    address internal constant TESTNET_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant TESTNET_FEE_STAKING = 0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7;
    address internal constant TESTNET_BORROWER_OPERATIONS = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;
    address internal constant TESTNET_TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;

    function run() external returns (PrismYieldAMM amm) {
        require(block.chainid == 31611, "wrong chain");

        address tokenizerAddr = vm.envOr("PRISM_TOKENIZER_ADDRESS", TESTNET_TOKENIZER);
        address musdAddr = vm.envOr("MEZO_TESTNET_MUSD_ADDRESS", TESTNET_MUSD);
        address feeStakingAddr = vm.envOr("PRISM_FEE_STAKING_ADDRESS", TESTNET_FEE_STAKING);
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);
        address borrowerOps = vm.envOr("MEZO_TESTNET_BORROWER_OPS", TESTNET_BORROWER_OPERATIONS);
        address troveManager = vm.envOr("MEZO_TESTNET_TROVE_MANAGER", TESTNET_TROVE_MANAGER);
        uint256 seed = vm.envOr("AMM_SEED_PER_POOL", uint256(500e18));
        uint256 borrowAmount = vm.envOr("AMM_BORROW_MUSD", uint256(2200e18));
        uint256 collateral = vm.envOr("AMM_TROVE_BTC", uint256(0.048 ether));
        address existingAmm = vm.envOr("PRISM_YIELD_AMM_ADDRESS", address(0));

        uint256 currentWeek = block.timestamp / 604800;
        uint256[2] memory maturities = [(currentWeek + 4) * 604800, (currentWeek + 12) * 604800];
        uint256 needed = seed * 4;

        vm.startBroadcast();

        if (IERC20(musdAddr).balanceOf(msg.sender) < needed) {
            uint256 status = ITroveManagerView(troveManager).getTroveStatus(msg.sender);
            if (status == 0) {
                IBorrowerOperations(borrowerOps).openTrove{value: collateral}(borrowAmount, address(0), address(0));
            } else {
                uint256 shortfall = needed - IERC20(musdAddr).balanceOf(msg.sender);
                IBorrowerOperations(borrowerOps).withdrawMUSD(shortfall, address(0), address(0));
            }
        }

        amm = existingAmm == address(0)
            ? new PrismYieldAMM(
                PrismTokenizer(tokenizerAddr), IERC20(musdAddr), IPrismFeeStaking(feeStakingAddr), treasury
            )
            : PrismYieldAMM(existingAmm);

        _seed(amm, PrismTokenizer(tokenizerAddr), IERC20(musdAddr), seed, maturities[0]);
        _seed(amm, PrismTokenizer(tokenizerAddr), IERC20(musdAddr), seed, maturities[1]);

        vm.stopBroadcast();

        console.log("PrismYieldAMM:", address(amm));
        console.log("PrismTokenizer:", tokenizerAddr);
        console.log("MUSD:", musdAddr);
        console.log("PrismFeeStaking:", feeStakingAddr);
        console.log("Treasury:", treasury);
        console.log("4-week maturity:", maturities[0]);
        console.log("12-week maturity:", maturities[1]);
        console.log("Seed per pool:", seed);
    }

    function _seed(PrismYieldAMM amm, PrismTokenizer tokenizer, IERC20 musd, uint256 seed, uint256 maturity) internal {
        PrismTokenizer.Series memory series = tokenizer.getSeries(maturity);
        require(series.ptToken != address(0), "series missing");

        musd.approve(address(tokenizer), seed);
        tokenizer.mintPyFromMusd(seed, maturity, msg.sender);

        IERC20(series.ptToken).approve(address(amm), seed);
        musd.approve(address(amm), seed);
        amm.addLiquidity(maturity, seed, seed, msg.sender);
    }
}
