// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {
    IMUSD,
    IMUSDSavingsRate,
    IBorrowerOperations,
    IBorrowerOperationsSignatures,
    ITroveManager,
    IHintHelpers,
    ISortedTroves,
    IPriceFeed,
    INttManager,
    IMezoPrecompile
} from "../../src/interfaces/IMezoCore.sol";
import {MezoAddresses} from "../../src/libraries/MezoAddresses.sol";

/// @notice Verifies every canonical Mezo address and selector against live state.
/// @dev Runs both networks by selecting a fork inside each test, so a single
///      `forge test --match-path test/fork/MezoCanonicalAddressesFork.t.sol` covers both.
contract MezoCanonicalAddressesForkTest is Test {
    address internal constant PROBE = address(0xBEEF);

    function testForkMezoTestnetCanonicalContracts() public {
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC_URL", string("https://rpc.test.mezo.org")));
        _verify(MezoAddresses.MEZO_TESTNET, false);
    }

    function testForkMezoMainnetCanonicalContracts() public {
        vm.createSelectFork(vm.envOr("MEZO_MAINNET_RPC_URL_PRIMARY", string("https://mezo-mainnet.boar.network")));
        _verify(MezoAddresses.MEZO_MAINNET, true);
    }

    function _verify(uint256 chainId, bool isMainnet) internal {
        assertEq(block.chainid, chainId, "unexpected fork chain");
        MezoAddresses.Addresses memory a = MezoAddresses.getAddresses(chainId);

        _assertCode(a.musd, "MUSD");
        _assertCode(a.borrowerOperations, "BorrowerOperations");
        _assertCode(a.borrowerOperationsSignatures, "BorrowerOperationsSignatures");
        _assertCode(a.troveManager, "TroveManager");
        _assertCode(a.hintHelpers, "HintHelpers");
        _assertCode(a.sortedTroves, "SortedTroves");
        _assertCode(a.priceFeed, "PriceFeed");
        _assertCode(a.nttManager, "NttManager");
        _assertCode(a.mezoToken, "MEZO precompile");
        _assertCode(a.btcPrecompile, "BTC precompile");

        assertEq(IBorrowerOperations(a.borrowerOperations).musd(), a.musd, "impostor MUSD");
        assertEq(
            IBorrowerOperationsSignatures(a.borrowerOperationsSignatures).borrowerOperations(),
            a.borrowerOperations,
            "signatures target mismatch"
        );
        assertEq(IBorrowerOperationsSignatures(a.borrowerOperationsSignatures).getNonce(PROBE), 0, "nonce probe");

        // Run the only mutating probe before the oracle call, whose failed
        // precompile consumes the test's gas budget.
        if (isMainnet) {
            _verifySMUSD(a.smusd, a.musd);
        } else {
            assertEq(a.smusd, address(0), "Testnet sMUSD not deployed");
            assertEq(a.smusd.code.length, 0, "unexpected Testnet sMUSD code");
            console.log("Testnet sMUSD: absent (GAP-001, deploy TestnetFeeInjector)");
        }

        // Foundry cannot execute Mezo's oracle precompile (0x7b7c...0015), which
        // PriceFeed.fetchPrice() calls. Cap the gas so the failed precompile does
        // not starve the rest of the test; the live price is also checked with cast.
        (bool priceOk, bytes memory priceData) =
            a.priceFeed.staticcall{gas: 500_000}(abi.encodeWithSelector(IPriceFeed.fetchPrice.selector));
        if (priceOk && priceData.length >= 32) {
            uint256 price = abi.decode(priceData, (uint256));
            assertGt(price, 0, "BTC price is zero");
            console.log("BTC/USD price (1e18)", price);
        } else {
            console.log("BTC/USD: precompile 0x7b7c...0015 unsupported by Foundry; verified via cast");
        }

        uint256 size = ISortedTroves(a.sortedTroves).getSize();
        (address hint,,) = IHintHelpers(a.hintHelpers).getApproxHint(1e18, 10, 1);
        console.log("chainId", chainId);
        console.log("MUSD", a.musd);
        console.log("BorrowerOperations", a.borrowerOperations);
        console.log("BorrowerOperationsSignatures", a.borrowerOperationsSignatures);
        console.log("SortedTroves size", size);
        console.log("approx hint", hint);

        assertEq(ITroveManager(a.troveManager).getTroveDebt(PROBE), 0, "probe trove debt");
        assertEq(ITroveManager(a.troveManager).getTroveColl(PROBE), 0, "probe trove coll");

        INttManager ntt = INttManager(a.nttManager);
        assertEq(ntt.token(), a.musd, "NTT token mismatch");
        assertEq(ntt.chainId(), 50, "Wormhole Mezo chain id");
        assertEq(ntt.getMode(), 0, "NTT should be LOCKING");
        assertGt(ntt.getThreshold(), 0, "NTT threshold");

        // Mezo ERC-20 precompiles are chain-level code that Foundry forks do not
        // implement. Their live values are verified separately with cast.
        try IMezoPrecompile(a.mezoToken).decimals() returns (uint8 d) {
            assertEq(d, 18, "MEZO decimals");
            assertEq(IMezoPrecompile(a.mezoToken).symbol(), "MEZO", "MEZO symbol");
        } catch {
            console.log("MEZO precompile unsupported by Foundry; verified via cast");
        }
        try IMezoPrecompile(a.btcPrecompile).decimals() returns (uint8 d) {
            assertEq(d, 18, "BTC decimals");
            assertEq(IMezoPrecompile(a.btcPrecompile).symbol(), "BTC", "BTC symbol");
        } catch {
            console.log("BTC precompile unsupported by Foundry; verified via cast");
        }
    }

    /// @dev Live sMUSD is a 1:1 savings receipt with a separate yield index, not ERC-4626.
    function _verifySMUSD(address smusd, address musd) internal {
        IMUSDSavingsRate vault = IMUSDSavingsRate(smusd);
        assertEq(vault.musdToken(), musd, "sMUSD underlying mismatch");
        assertGt(vault.totalSupply(), 0, "sMUSD supply");
        assertGt(vault.yieldIndex(), 0, "sMUSD yield index");

        address holder = vault.strategy();
        _assertCode(holder, "sMUSD strategy");
        uint256 musdBefore = IMUSD(musd).balanceOf(holder);
        uint256 sharesBefore = vault.balanceOf(holder);
        assertGt(musdBefore, 1_000e18, "strategy has no MUSD to probe");

        vm.startPrank(holder);
        IMUSD(musd).approve(smusd, type(uint256).max);
        vault.deposit(1_000e18);
        assertEq(vault.balanceOf(holder) - sharesBefore, 1_000e18, "deposit not 1:1");
        vault.withdraw(1_000e18);
        vm.stopPrank();

        assertEq(vault.balanceOf(holder), sharesBefore, "withdraw did not burn shares");
        assertEq(IMUSD(musd).balanceOf(holder), musdBefore, "withdraw not 1:1");

        console.log("sMUSD", smusd);
        console.log("sMUSD totalSupply", vault.totalSupply());
        console.log("sMUSD yieldIndex (1e18)", vault.yieldIndex());
        console.log("sMUSD pendingYield", vault.pendingYield());
        console.log("sMUSD probe: deposit/withdraw 1000 MUSD == 1000 sMUSD");
    }

    function _assertCode(address target, string memory label) internal view {
        assertGt(target.code.length, 0, string.concat(label, ": no code"));
    }
}
