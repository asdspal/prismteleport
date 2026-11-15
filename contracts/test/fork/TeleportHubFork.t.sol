// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TeleportHub, INttManager} from "../../src/teleport/TeleportHub.sol";
import {TeleportSpoke} from "../../src/teleport/TeleportSpoke.sol";
import {PrismMicroVault} from "../../src/teleport/PrismMicroVault.sol";
import {PrismYieldAMM} from "../../src/core/PrismYieldAMM.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {
    IBorrowerOperations,
    IBorrowerOperationsSignatures,
    IMUSDSavingsRate,
    IMUSDSavingsGauge,
    IPriceFeed,
    IPrismFeeStaking,
    ITroveManager
} from "../../src/interfaces/IMezoCore.sol";

/// @dev The step's fork scenarios run against a real 31611 fork for the Prism
/// side (tokenizer, AMM, adapter) and mocks for Mezo's precompile-backed core
/// (BorrowerOperationsSignatures, TroveManager, PriceFeed) plus a mock Wormhole
/// NTT manager, exactly like the M2.1 router fork suite.

contract ForkMUSD is ERC20 {
    constructor() ERC20("MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract ForkMEZO is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPriceFeed is IPriceFeed {
    uint256 public price = 65_000e18;

    function setPrice(uint256 p) external {
        price = p;
    }

    function fetchPrice() external view returns (uint256) {
        return price;
    }
}

contract MockTroveManager is ITroveManager {
    function getCurrentICR(address, uint256) external pure returns (uint256) {
        return 3e18;
    }

    function getTroveDebt(address) external pure returns (uint256) {
        return 0;
    }

    function getTroveColl(address) external pure returns (uint256) {
        return 0;
    }

    function getTCR(uint256) external pure returns (uint256) {
        return 3e18;
    }
}

contract MockFeeStaking is IPrismFeeStaking {
    function getFeeDiscountBps(address) external pure returns (uint256) {
        return 0;
    }

    function notifyRewardAmount(uint256) external {}
}

/// @dev Mirrors Mezo's BorrowerOperationsSignatures: verifies nothing (the
/// signature is produced by a real EIP-712 signer in the tests) and mints MUSD
/// to the recipient, reproducing the ActivePool zero-value ping.
contract MockBorrowerOpsSignatures is IBorrowerOperationsSignatures {
    ForkMUSD public immutable musdToken;
    address public immutable ops;
    bool public shouldFail;

    constructor(ForkMUSD _musd, address _ops) {
        musdToken = _musd;
        ops = _ops;
    }

    function setShouldFail(bool value) external {
        shouldFail = value;
    }

    function borrowerOperations() external view returns (address) {
        return ops;
    }

    function getNonce(address) external pure returns (uint256) {
        return 0;
    }

    function openTroveWithSignature(
        uint256 debtAmount,
        address,
        address,
        address,
        address recipient,
        bytes memory,
        uint256
    ) external payable {
        require(!shouldFail, "trove open reverted");
        musdToken.mint(recipient, debtAmount);
    }

    function withdrawMUSDWithSignature(uint256, address, address, address, address, bytes memory, uint256) external {}

    function repayMUSDWithSignature(uint256, address, address, address, bytes memory, uint256) external {}

    function closeTroveWithSignature(address, address, bytes memory, uint256) external {}
}

contract MockBorrowerOps is IBorrowerOperations {
    ForkMUSD public immutable musdToken;
    uint256 public masterCollateral;
    uint256 public masterDebt;

    constructor(ForkMUSD _musd) {
        musdToken = _musd;
    }

    function musd() external view returns (address) {
        return address(musdToken);
    }

    function openTrove(uint256 debtAmount, address, address) external payable {
        masterCollateral += msg.value;
        masterDebt += debtAmount;
        musdToken.mint(msg.sender, debtAmount);
    }

    function restrictedOpenTrove(address, address, uint256, address, address) external payable {}

    function withdrawMUSD(uint256 amount, address, address) external {
        masterDebt += amount;
        musdToken.mint(msg.sender, amount);
    }

    function adjustTrove(uint256 collWithdrawal, uint256 debtChange, bool isDebtIncrease, address, address)
        external
        payable
    {
        masterCollateral = masterCollateral + msg.value - collWithdrawal;
        if (isDebtIncrease) {
            masterDebt += debtChange;
            musdToken.mint(msg.sender, debtChange);
        } else {
            masterDebt -= debtChange;
            musdToken.burn(msg.sender, debtChange);
        }
        if (collWithdrawal > 0) {
            (bool ok, ) = msg.sender.call{value: collWithdrawal}("");
            require(ok, "Sending BTC failed");
        }
    }

    function repayMUSD(uint256 amount, address, address) external {
        masterDebt -= amount;
        musdToken.burn(msg.sender, amount);
    }

    function closeTrove() external {
        masterCollateral = 0;
        masterDebt = 0;
    }
}

contract MockNttManager is INttManager {
    IERC20 public immutable musdToken;
    uint256 public received;
    uint16 public lastChain;
    bytes32 public lastRecipient;
    uint64 public sequence;

    constructor(IERC20 _musd) {
        musdToken = _musd;
    }

    function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient, uint256) external payable returns (uint64) {
        // The real NTT manager pulls the beamed tokens from the caller.
        musdToken.transferFrom(msg.sender, address(this), amount);
        received += amount;
        lastChain = recipientChain;
        lastRecipient = recipient;
        return ++sequence;
    }
}

contract TeleportHubForkTest is Test {
    uint256 internal constant SECONDS_PER_WEEK = 604800;
    uint256 internal constant MIN_TROVE_DEBT = 1_800e18;
    uint256 internal constant BASE_CHAIN_ID = 84532;

    ForkMUSD internal musd;
    TestnetFeeInjector internal smusd;
    ForkMEZO internal mezo;
    MockMUSDSavingsGauge internal gauge;
    MockFeeStaking internal feeStaking;
    DualTrackAdapter internal adapter;
    PrismSeriesFactory internal factory;
    PrismTokenizer internal tokenizer;
    PrismYieldAMM internal amm;
    MockPriceFeed internal priceFeed;
    MockTroveManager internal troveManager;
    MockBorrowerOps internal borrowerOps;
    MockBorrowerOpsSignatures internal bos;
    MockNttManager internal ntt;
    PrismMicroVault internal vault;
    TeleportHub internal hub;
    TeleportSpoke internal spoke;

    uint256 internal borrowerKey = 0xA11CE;
    address internal borrower;
    address internal keeper = address(0xCAFE);
    address internal treasury = address(0x7BEA5);
    uint256 internal maturity;

    function setUp() public {
        borrower = vm.addr(borrowerKey);
        maturity = ((block.timestamp / SECONDS_PER_WEEK) + 12) * SECONDS_PER_WEEK;

        musd = new ForkMUSD();
        smusd = new TestnetFeeInjector(IERC20(address(musd)));
        mezo = new ForkMEZO();
        gauge = new MockMUSDSavingsGauge(IERC20(address(smusd)), IERC20(address(mezo)));
        feeStaking = new MockFeeStaking();
        adapter = new DualTrackAdapter(
            IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500
        );
        factory = new PrismSeriesFactory();
        tokenizer = new PrismTokenizer(
            IERC20(address(musd)),
            IMUSDSavingsRate(address(smusd)),
            adapter,
            factory,
            IPrismFeeStaking(address(feeStaking)),
            IERC20(address(mezo)),
            treasury,
            keeper,
            0
        );
        tokenizer.initializeSeries(maturity);
        amm = new PrismYieldAMM(tokenizer, IERC20(address(musd)), IPrismFeeStaking(address(feeStaking)), treasury);

        priceFeed = new MockPriceFeed();
        troveManager = new MockTroveManager();
        borrowerOps = new MockBorrowerOps(musd);
        bos = new MockBorrowerOpsSignatures(musd, address(borrowerOps));
        ntt = new MockNttManager(IERC20(address(musd)));

        vault = new PrismMicroVault(
            IERC20(address(musd)),
            IMUSDSavingsRate(address(smusd)),
            IBorrowerOperations(address(borrowerOps)),
            ITroveManager(address(troveManager)),
            IPriceFeed(address(priceFeed)),
            amm,
            tokenizer
        );

        hub = new TeleportHub(
            IERC20(address(musd)),
            IBorrowerOperationsSignatures(address(bos)),
            vault,
            amm,
            tokenizer,
            INttManager(address(ntt)),
            uint16(BASE_CHAIN_ID)
        );

        spoke = new TeleportSpoke(IERC20(address(musd)), IERC20(address(musd)), INttManager(address(ntt)), 31611, bytes32(uint256(uint160(address(hub)))));

        // Deep, balanced pool so teleported borrows have PT to buy.
        musd.mint(address(this), 10_000e18);
        musd.approve(address(tokenizer), 3_000e18);
        tokenizer.mintPyFromMusd(3_000e18, maturity, address(this));
        IERC20(tokenizer.getSeries(maturity).ptToken).approve(address(amm), 3_000e18);
        musd.approve(address(amm), 3_000e18);
        amm.addLiquidity(maturity, 3_000e18, 3_000e18, address(this));

        // Master Trove for the micro path.
        vm.deal(address(this), 1 ether);
        vault.activateMasterTrove{value: 0.07 ether}(2_000e18, address(0), address(0));

        vm.deal(borrower, 1 ether);
    }

    function _intent(TeleportHub.IntentType intentType, uint256 btc, uint256 musdAmount, uint256 minOutput)
        internal
        view
        returns (TeleportHub.TeleportIntent memory intent)
    {
        intent = TeleportHub.TeleportIntent({
            sourceChainId: BASE_CHAIN_ID,
            destChainId: block.chainid,
            borrower: borrower,
            intentType: intentType,
            collateralBtcWei: btc,
            musdAmountWei: musdAmount,
            minOutputWei: minOutput,
            relayerFeeMusdWei: 0,
            deadline: block.timestamp + 1 hours,
            nonce: 1,
            seriesMaturity: maturity
        });
    }

    function _sign(TeleportHub.TeleportIntent memory intent) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, hub.intentDigest(intent));
        return abi.encodePacked(r, s, v);
    }

    function testCrossChainBorrowAndLockPtOpensTroveForTheBorrower() public {
        TeleportHub.TeleportIntent memory intent =
            _intent(TeleportHub.IntentType.BORROW_AND_LOCK_PT, 0.05 ether, 2_000e18, 0);
        bytes memory sig = _sign(intent);

        vm.prank(borrower);
        hub.executeCrossChainTeleport{value: 0.05 ether}(intent, "", sig, address(0), address(0));

        // The PT lands with the borrower, never in the hub.
        assertGt(IERC20(tokenizer.getSeries(maturity).ptToken).balanceOf(borrower), 1_900e18);
        assertEq(IERC20(tokenizer.getSeries(maturity).ptToken).balanceOf(address(hub)), 0);
        assertEq(address(hub).balance, 0, "hub keeps no custody");
        assertTrue(hub.processedIntents(hub.hashIntent(intent)));
    }

    function testCrossChainBorrowAndTeleportMusdBeamsBackToBase() public {
        TeleportHub.TeleportIntent memory intent =
            _intent(TeleportHub.IntentType.BORROW_AND_TELEPORT_MUSD, 0.05 ether, 2_000e18, 0);
        bytes memory sig = _sign(intent);

        vm.prank(borrower);
        hub.executeCrossChainTeleport{value: 0.05 ether}(intent, "", sig, address(0), address(0));

        assertEq(ntt.received(), 2_000e18, "MUSD beamed over NTT");
        assertEq(ntt.lastChain(), uint16(BASE_CHAIN_ID));
        assertEq(ntt.lastRecipient(), bytes32(uint256(uint160(borrower))));
        assertEq(musd.balanceOf(address(hub)), 0, "no residual MUSD");
    }

    function testMicroTeleportRoutesToTheSharedVault() public {
        TeleportHub.TeleportIntent memory intent =
            _intent(TeleportHub.IntentType.MICRO_TELEPORT, 0.001 ether, 25e18, 0);
        bytes memory sig = _sign(intent);

        vm.prank(borrower);
        hub.executeCrossChainTeleport{value: 0.001 ether}(intent, "", sig, address(0), address(0));

        // The micro position is the borrower's, not the hub's.
        (uint256 btcCollateral, uint256 musdDebt, uint256 escrowedPt,,,) = vault.positions(borrower);
        assertEq(btcCollateral, 0.001 ether);
        assertEq(musdDebt, 25e18);
        assertEq(escrowedPt, 25e18);
        assertGt(IERC20(tokenizer.getSeries(maturity).ptToken).balanceOf(borrower), 0, "carry profit paid");

        (uint256 hubCollateral,,,,,) = vault.positions(address(hub));
        assertEq(hubCollateral, 0, "hub holds no micro position");
    }

    function testMidBridgeCrashCreditsRescueEscrow() public {
        TeleportHub.TeleportIntent memory intent =
            _intent(TeleportHub.IntentType.BORROW_AND_LOCK_PT, 0.05 ether, 2_000e18, 0);
        bytes memory sig = _sign(intent);

        // STRIDE-05: BTC crashes while the message is in flight and the Trove
        // open reverts. The relay must not revert and must credit the escrow.
        bos.setShouldFail(true);

        vm.prank(borrower);
        hub.executeCrossChainTeleport{value: 0.05 ether}(intent, "", sig, address(0), address(0));

        assertEq(hub.claimableRescueBtc(borrower), 0.05 ether);
        assertEq(address(hub).balance, 0.05 ether);

        uint256 before = borrower.balance;
        vm.prank(borrower);
        uint256 rescued = hub.withdrawRescueBtc();
        assertEq(rescued, 0.05 ether);
        assertEq(borrower.balance, before + 0.05 ether);
        assertEq(hub.claimableRescueBtc(borrower), 0);
    }

    function testRescueEscrowAlsoCoversSlippageFailure() public {
        // A too-high minPtOut reverts inside the AMM swap: same rescue path.
        TeleportHub.TeleportIntent memory intent =
            _intent(TeleportHub.IntentType.BORROW_AND_LOCK_PT, 0.05 ether, 2_000e18, 5_000e18);
        bytes memory sig = _sign(intent);

        vm.prank(borrower);
        hub.executeCrossChainTeleport{value: 0.05 ether}(intent, "", sig, address(0), address(0));

        assertEq(hub.claimableRescueBtc(borrower), 0.05 ether);
    }

    function testRepayAndCloseBeamsMusdBackToTheHub() public {
        musd.mint(borrower, 500e18);
        vm.startPrank(borrower);
        musd.approve(address(spoke), 500e18);
        uint64 sequence = spoke.repayAndCloseFromSpoke(500e18, block.timestamp + 1 hours, keccak256("intent"));
        vm.stopPrank();

        assertEq(sequence, 1);
        assertEq(ntt.received(), 500e18);
        assertEq(ntt.lastChain(), 31611);
        assertEq(ntt.lastRecipient(), bytes32(uint256(uint160(address(hub)))));
    }

    function testGuardsRejectReplayExpiryAndBadSignature() public {
        TeleportHub.TeleportIntent memory intent =
            _intent(TeleportHub.IntentType.BORROW_AND_LOCK_PT, 0.05 ether, 2_000e18, 0);
        bytes memory sig = _sign(intent);

        // Wrong destination chain. Each variant is built fresh: memory-to-memory
        // struct assignment in Solidity aliases the same struct, so mutating a
        // "copy" would mutate the original.
        TeleportHub.TeleportIntent memory wrongDest =
            _intent(TeleportHub.IntentType.BORROW_AND_LOCK_PT, 0.05 ether, 2_000e18, 0);
        wrongDest.destChainId = 1;
        bytes memory wrongDestSig = _sign(wrongDest);
        vm.prank(borrower);
        vm.expectRevert(TeleportHub.WrongDestination.selector);
        hub.executeCrossChainTeleport{value: 0.05 ether}(wrongDest, "", wrongDestSig, address(0), address(0));

        // Expired. (The signature is computed first: `expectRevert` would
        // otherwise be consumed by the inline `intentDigest` staticcall.)
        TeleportHub.TeleportIntent memory expired =
            _intent(TeleportHub.IntentType.BORROW_AND_LOCK_PT, 0.05 ether, 2_000e18, 0);
        expired.deadline = block.timestamp - 1;
        bytes memory expiredSig = _sign(expired);
        vm.prank(borrower);
        vm.expectRevert(TeleportHub.IntentExpired.selector);
        hub.executeCrossChainTeleport{value: 0.05 ether}(expired, "", expiredSig, address(0), address(0));

        // Collateral mismatch.
        vm.prank(borrower);
        vm.expectRevert(TeleportHub.CollateralMismatch.selector);
        hub.executeCrossChainTeleport{value: 0.04 ether}(intent, "", sig, address(0), address(0));

        // Bad signature: valid ECDSA, wrong signer.
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(0xB0B, hub.intentDigest(intent));
        vm.prank(borrower);
        vm.expectRevert(TeleportHub.BadSignature.selector);
        hub.executeCrossChainTeleport{value: 0.05 ether}(intent, "", abi.encodePacked(r2, s2, v2), address(0), address(0));

        // Valid, then replay.
        vm.prank(borrower);
        hub.executeCrossChainTeleport{value: 0.05 ether}(intent, "", sig, address(0), address(0));
        vm.prank(borrower);
        vm.expectRevert(TeleportHub.AlreadyProcessed.selector);
        hub.executeCrossChainTeleport{value: 0.05 ether}(intent, "", sig, address(0), address(0));
    }

    function testExecuteInnerIsSelfOnly() public {
        TeleportHub.TeleportIntent memory intent =
            _intent(TeleportHub.IntentType.BORROW_AND_LOCK_PT, 0.05 ether, 2_000e18, 0);
        vm.prank(borrower);
        vm.expectRevert(TeleportHub.OnlySelfCall.selector);
        hub.executeInner{value: 0.05 ether}(intent, "", address(0), address(0));
    }

    function testSpokeEscrowsAndRefundsExpiredIntent() public {
        TeleportSpoke.TeleportIntent memory intent = TeleportSpoke.TeleportIntent({
            sourceChainId: block.chainid,
            destChainId: 31611,
            borrower: borrower,
            intentType: TeleportSpoke.IntentType.BORROW_AND_LOCK_PT,
            collateralBtcWei: 0.02 ether,
            musdAmountWei: 1_000e18,
            minOutputWei: 0,
            relayerFeeMusdWei: 0,
            deadline: block.timestamp + 1 hours,
            nonce: 7,
            seriesMaturity: maturity
        });

        musd.mint(borrower, 0.02 ether);
        vm.startPrank(borrower);
        musd.approve(address(spoke), 0.02 ether);
        bytes32 intentHash = spoke.initiateTeleportBorrow(intent, "");
        assertEq(spoke.escrowedBtc(intentHash), 0.02 ether);

        uint256 before = musd.balanceOf(borrower);
        uint256 refunded = spoke.refundExpiredEscrow(intentHash);
        vm.stopPrank();
        assertEq(refunded, 0.02 ether);
        assertEq(musd.balanceOf(borrower), before + 0.02 ether);
    }
}
