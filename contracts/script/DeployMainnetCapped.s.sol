// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismTokenizer} from "../src/core/PrismTokenizer.sol";
import {PrismYieldAMM} from "../src/core/PrismYieldAMM.sol";
import {PrismBorrowLockRouter} from "../src/core/PrismBorrowLockRouter.sol";
import {DualTrackAdapter} from "../src/core/DualTrackAdapter.sol";
import {PrismFeeStaking} from "../src/core/PrismFeeStaking.sol";
import {PrismSeriesFactory} from "../src/core/tokens/PrismSeriesFactory.sol";
import {
    IBorrowerOperationsSignatures,
    IMUSDSavingsRate,
    IMUSDSavingsGauge,
    IPriceFeed,
    IPrismFeeStaking,
    ITroveManager
} from "../src/interfaces/IMezoCore.sol";

/// @notice Capped production deployment on Mezo Mainnet (31612) — DEC-001, R-020.
///
/// Deploys the Prism stack bound to the canonical Mainnet MUSD/sMUSD/Mezo core
/// with a hard **2,500 MUSD** issuance cap on `PrismTokenizer`, then (optionally)
/// runs the live smoke cycle. Broadcast only after the Mainnet fork rehearsal
/// (`test/fork/MainnetCappedRehearsalFork.t.sol`) passes.
contract DeployMainnetCapped is Script {
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// @notice Hard cap on new PT/YT issuance (2,500 MUSD).
    uint256 internal constant MAX_MAINNET_TVL = 2_500e18;

    // Canonical Mezo Mainnet (31612) addresses.
    address internal constant MAINNET_MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant MAINNET_SMUSD = 0xb4D498029af77680cD1eF828b967f010d06C51CC;
    address internal constant MAINNET_BORROWER_OPS = 0x44b1bac67dDA612a41a58AAf779143B181dEe031;
    address internal constant MAINNET_BOPS_SIG = 0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a;
    address internal constant MAINNET_TROVE_MANAGER = 0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193;
    address internal constant MAINNET_PRICE_FEED = 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88;
    address internal constant MAINNET_MEZO = 0x7B7c000000000000000000000000000000000001;

    function run() external {
        require(block.chainid == 31612, "wrong chain");
        uint256 pk = vm.envOr("RELAYER_PRIVATE_KEY", ANVIL_KEY);
        address treasury = vm.envOr("PRISM_TREASURY", msg.sender);
        address keeper = vm.envOr("PRISM_KEEPER", msg.sender);
        uint256 unstakedFeeAprBps = vm.envOr("PRISM_UNSTAKED_FEE_APR_BPS", uint256(500));

        vm.startBroadcast(pk);

        PrismSeriesFactory factory = new PrismSeriesFactory();
        PrismFeeStaking feeStaking = new PrismFeeStaking(IERC20(MAINNET_MEZO), IERC20(MAINNET_MUSD));
        // Mainnet sMUSD is the canonical savings-rate token (no separate gauge
        // wrapper is bound at deploy time; the adapter's unstaked track is used).
        DualTrackAdapter adapter = new DualTrackAdapter(
            IERC20(MAINNET_SMUSD), IERC20(MAINNET_MEZO), IMUSDSavingsGauge(address(0)), unstakedFeeAprBps
        );
        PrismTokenizer tokenizer = new PrismTokenizer(
            IERC20(MAINNET_MUSD),
            IMUSDSavingsRate(MAINNET_SMUSD),
            adapter,
            factory,
            IPrismFeeStaking(address(feeStaking)),
            IERC20(MAINNET_MEZO),
            treasury,
            keeper,
            MAX_MAINNET_TVL
        );
        PrismYieldAMM amm =
            new PrismYieldAMM(tokenizer, IERC20(MAINNET_MUSD), IPrismFeeStaking(address(feeStaking)), treasury);
        PrismBorrowLockRouter router = new PrismBorrowLockRouter(
            IBorrowerOperationsSignatures(MAINNET_BOPS_SIG),
            ITroveManager(MAINNET_TROVE_MANAGER),
            IPriceFeed(MAINNET_PRICE_FEED),
            amm,
            IERC20(MAINNET_MUSD)
        );
        vm.stopBroadcast();

        console.log("PrismSeriesFactory:", address(factory));
        console.log("PrismFeeStaking:", address(feeStaking));
        console.log("DualTrackAdapter:", address(adapter));
        console.log("PrismTokenizer:", address(tokenizer));
        console.log("PrismYieldAMM:", address(amm));
        console.log("PrismBorrowLockRouter:", address(router));
        console.log("maxTvlMusd:", tokenizer.maxTvlMusd());
    }
}
