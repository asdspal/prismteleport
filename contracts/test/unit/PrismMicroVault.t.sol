// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PrismMicroVault} from "../../src/teleport/PrismMicroVault.sol";
import {PrismYieldAMM} from "../../src/core/PrismYieldAMM.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {PrismPrincipalToken} from "../../src/core/tokens/PrismPrincipalToken.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {
    IBorrowerOperations,
    IMUSDSavingsRate,
    IMUSDSavingsGauge,
    IPriceFeed,
    IPrismFeeStaking,
    ITroveManager
} from "../../src/interfaces/IMezoCore.sol";

contract MockMUSD is ERC20 {
    constructor() ERC20("Mock MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockMEZO is ERC20 {
    constructor() ERC20("Mock MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFeeStaking is IPrismFeeStaking {
    function getFeeDiscountBps(address) external pure returns (uint256) {
        return 0;
    }

    function notifyRewardAmount(uint256) external {}
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
        return 2e18;
    }

    function getTroveDebt(address) external pure returns (uint256) {
        return 0;
    }

    function getTroveColl(address) external pure returns (uint256) {
        return 0;
    }

    function getTCR(uint256) external pure returns (uint256) {
        return 2e18;
    }
}

/// @dev Mirrors the parts of Mezo's BorrowerOperations the vault touches: the
/// master Trove accounting lives here, MUSD is minted on draw and burned on
/// repay, and BTC moves in/out with msg.value and withdrawals.
contract MockBorrowerOps is IBorrowerOperations {
    MockMUSD public immutable musdToken;
    uint256 public masterCollateral;
    uint256 public masterDebt;

    constructor(MockMUSD _musd) {
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

    function repayMUSD(uint256 amount, address, address) external {
        masterDebt -= amount;
        musdToken.burn(msg.sender, amount);
    }

    function closeTrove() external {
        masterCollateral = 0;
        masterDebt = 0;
    }

    function adjustTrove(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address,
        address
    ) external payable {
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
}

contract PrismMicroVaultTest is Test {
    uint256 internal constant SECONDS_PER_WEEK = 604800;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    /// @dev The vault's 175% micro floor expressed in bps (what microIcrBps returns).
    uint256 internal constant ICR_FLOOR_BPS = 17_500;

    MockMUSD internal musd;
    TestnetFeeInjector internal smusd;
    MockMEZO internal mezo;
    MockMUSDSavingsGauge internal gauge;
    MockFeeStaking internal feeStaking;
    DualTrackAdapter internal adapter;
    PrismSeriesFactory internal factory;
    PrismTokenizer internal tokenizer;
    PrismYieldAMM internal amm;
    MockPriceFeed internal priceFeed;
    MockTroveManager internal troveManager;
    MockBorrowerOps internal borrowerOps;
    PrismMicroVault internal vault;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal keeper = address(0xCAFE);
    address internal treasury = address(0x7BEA5);

    uint256 internal maturity;

    function setUp() public {
        maturity = ((block.timestamp / SECONDS_PER_WEEK) + 12) * SECONDS_PER_WEEK;

        musd = new MockMUSD();
        smusd = new TestnetFeeInjector(IERC20(address(musd)));
        mezo = new MockMEZO();
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
            keeper
        );
        tokenizer.initializeSeries(maturity);

        amm = new PrismYieldAMM(
            tokenizer, IERC20(address(musd)), IPrismFeeStaking(address(feeStaking)), treasury
        );

        priceFeed = new MockPriceFeed();
        troveManager = new MockTroveManager();
        borrowerOps = new MockBorrowerOps(musd);

        vault = new PrismMicroVault(
            IERC20(address(musd)),
            IMUSDSavingsRate(address(smusd)),
            IBorrowerOperations(address(borrowerOps)),
            ITroveManager(address(troveManager)),
            IPriceFeed(address(priceFeed)),
            amm,
            tokenizer
        );

        // Seed a deep, balanced AMM pool so micro swaps of up to 500 MUSD have PT
        // to buy (2,000 MUSD / 2,000 PT): 2,000 MUSD mints the PT leg and 2,000
        // MUSD funds the pool's MUSD side. Balanced reserves keep the implied
        // rate at the base 5%, exactly like the 500/500 live testnet pools.
        musd.mint(address(this), 4_000e18);
        PrismTokenizer.Series memory s = tokenizer.getSeries(maturity);
        musd.approve(address(tokenizer), 2_000e18);
        tokenizer.mintPyFromMusd(2_000e18, maturity, address(this));
        IERC20(s.ptToken).approve(address(amm), 2_000e18);
        musd.approve(address(amm), 2_000e18);
        amm.addLiquidity(maturity, 2_000e18, 2_000e18, address(this));

        // Fund the master Trove activation: 0.05 BTC at $65k supports the debt.
        vm.deal(address(this), 1 ether);
        vault.activateMasterTrove{value: 0.07 ether}(2_000e18, address(0), address(0));

        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    function _series() internal view returns (PrismTokenizer.Series memory) {
        return tokenizer.getSeries(maturity);
    }

    function testActivateMasterTrove() public view {
        assertTrue(vault.masterActive());
        assertEq(borrowerOps.masterCollateral(), 0.07 ether);
        assertEq(borrowerOps.masterDebt(), 2_000e18);
    }

    function testActivateRejectsSecondCall() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(PrismMicroVault.MasterAlreadyActive.selector);
        vault.activateMasterTrove{value: 0.07 ether}(2_000e18, address(0), address(0));
    }

    function testActivateRejectsSmallDebt() public {
        PrismMicroVault fresh = _freshVault();
        vm.expectRevert(PrismMicroVault.MasterDebtTooSmall.selector);
        fresh.activateMasterTrove{value: 0.07 ether}(1_799e18, address(0), address(0));
    }

    function testActivateRejectsThinIcr() public {
        PrismMicroVault fresh = _freshVault();
        vm.expectRevert(PrismMicroVault.MasterIcrTooLow.selector);
        fresh.activateMasterTrove{value: 0.01 ether}(2_000e18, address(0), address(0));
    }

    function _freshVault() internal returns (PrismMicroVault) {
        return new PrismMicroVault(
            IERC20(address(musd)),
            IMUSDSavingsRate(address(smusd)),
            IBorrowerOperations(address(borrowerOps)),
            ITroveManager(address(troveManager)),
            IPriceFeed(address(priceFeed)),
            amm,
            tokenizer
        );
    }

    function testMicroBorrowAndLockPaysProfitAndEscrowsPar() public {
        uint256 collateral = 0.001 ether;
        uint256 borrow = 25e18;

        vm.prank(alice);
        uint256 profit = vault.microBorrowAndLock{value: collateral}(borrow, maturity, 0, address(0), address(0));

        PrismMicroVault.MicroPosition memory p = _position(alice);
        assertEq(p.btcCollateral, collateral);
        assertEq(p.musdDebt, borrow);
        assertEq(p.escrowedPt, borrow, "par escrow backs the debt");
        assertEq(p.maturity, maturity);

        // The fixed-yield excess is paid immediately, in PT.
        assertGt(profit, 0, "positive carry at 12 weeks");
        assertEq(IERC20(_series().ptToken).balanceOf(alice), profit);
        assertEq(vault.microIcrBps(alice), (collateral * 65_000e18 * BPS) / (borrow * WAD));
        assertGt(vault.microIcrBps(alice), ICR_FLOOR_BPS);
    }

    function testMicroBorrowBelowMezoMinimumIsAllowed() public {
        // 10 MUSD is far under Mezo's 1,800 MUSD standalone minimum.
        vm.prank(alice);
        vault.microBorrowAndLock{value: 0.001 ether}(10e18, maturity, 0, address(0), address(0));
        assertEq(_position(alice).musdDebt, 10e18);
        assertEq(borrowerOps.masterDebt(), 2_010e18);
    }

    function testMicroBorrowEnforcesIcrFloor() public {
        // 0.0002 BTC at $65k is only $13, so a 25 MUSD borrow is ~52% ICR.
        vm.prank(alice);
        vm.expectRevert(PrismMicroVault.MicroIcrTooLow.selector);
        vault.microBorrowAndLock{value: 0.0002 ether}(25e18, maturity, 0, address(0), address(0));
    }

    function testMicroBorrowRejectsDustDepositAndTinyBorrow() public {
        vm.startPrank(alice);
        vm.expectRevert(PrismMicroVault.DepositTooSmall.selector);
        vault.microBorrowAndLock{value: 0.0001 ether}(25e18, maturity, 0, address(0), address(0));

        vm.expectRevert(PrismMicroVault.BorrowTooSmall.selector);
        vault.microBorrowAndLock{value: 0.01 ether}(9e18, maturity, 0, address(0), address(0));
        vm.stopPrank();
    }

    function testMicroBorrowRequiresActiveMaster() public {
        PrismMicroVault fresh = _freshVault();
        vm.prank(alice);
        vm.expectRevert(PrismMicroVault.MasterInactive.selector);
        fresh.microBorrowAndLock{value: 0.001 ether}(25e18, maturity, 0, address(0), address(0));
    }

    function testMicroBorrowAggregatesSameMaturityAndRejectsOther() public {
        vm.startPrank(alice);
        vault.microBorrowAndLock{value: 0.001 ether}(25e18, maturity, 0, address(0), address(0));
        vault.microBorrowAndLock{value: 0.001 ether}(25e18, maturity, 0, address(0), address(0));

        PrismMicroVault.MicroPosition memory p = _position(alice);
        assertEq(p.btcCollateral, 0.002 ether);
        assertEq(p.musdDebt, 50e18);
        assertEq(p.escrowedPt, 50e18);

        uint256 other = maturity + SECONDS_PER_WEEK;
        tokenizer.initializeSeries(other);
        vm.expectRevert(PrismMicroVault.MaturityMismatch.selector);
        vault.microBorrowAndLock{value: 0.001 ether}(25e18, other, 0, address(0), address(0));
        vm.stopPrank();
    }

    function testMicroBorrowRespectsMinPtOut() public {
        vm.prank(alice);
        vm.expectRevert(bytes("slippage"));
        vault.microBorrowAndLock{value: 0.001 ether}(25e18, maturity, 1_000e18, address(0), address(0));
    }

    function testCloseBeforeMaturityReturnsBtcAndPt() public {
        vm.startPrank(alice);
        vault.microBorrowAndLock{value: 0.001 ether}(25e18, maturity, 0, address(0), address(0));

        uint256 profit = IERC20(_series().ptToken).balanceOf(alice);
        uint256 btcBefore = alice.balance;

        // Repay the debt in MUSD, keep the escrowed PT, recover 100% of the BTC.
        musd.mint(alice, 25e18);
        musd.approve(address(vault), 25e18);
        (uint256 btcReturned, uint256 ptReturned) = vault.closeMicroPosition();
        vm.stopPrank();

        assertEq(btcReturned, 0.001 ether);
        assertEq(ptReturned, 25e18);
        assertEq(alice.balance, btcBefore + 0.001 ether);
        assertEq(IERC20(_series().ptToken).balanceOf(alice), profit + 25e18);
        assertEq(borrowerOps.masterCollateral(), 0.07 ether, "master collateral restored");
        assertEq(borrowerOps.masterDebt(), 2_000e18);

        PrismMicroVault.MicroPosition memory p = _position(alice);
        assertEq(p.musdDebt, 0);
        assertEq(vault.totalEscrowedPt(), 0);
    }

    function testCloseAtMaturitySettlesWithEscrowedPt() public {
        vm.prank(alice);
        vault.microBorrowAndLock{value: 0.001 ether}(25e18, maturity, 0, address(0), address(0));

        vm.warp(maturity + 1);
        uint256 btcBefore = alice.balance;
        vm.prank(alice);
        (uint256 btcReturned, uint256 ptReturned) = vault.closeMicroPosition();

        assertEq(btcReturned, 0.001 ether);
        assertEq(ptReturned, 0, "PT settled the debt instead of returning");
        assertEq(alice.balance, btcBefore + 0.001 ether);
        // No MUSD was needed from the user: the escrowed PT repaid the Trove.
        assertEq(borrowerOps.masterDebt(), 2_000e18);
        assertEq(borrowerOps.masterCollateral(), 0.07 ether);
    }

    function testMicroBorrowForKeepsCustodyWithTheBeneficiary() public {
        // A router (the cross-chain hub) funds the position but never owns it.
        vm.prank(bob);
        uint256 profit = vault.microBorrowAndLockFor{value: 0.001 ether}(
            alice, 25e18, maturity, 0, address(0), address(0)
        );

        PrismMicroVault.MicroPosition memory p = _position(alice);
        assertEq(p.btcCollateral, 0.001 ether);
        assertEq(p.musdDebt, 25e18);
        assertEq(p.escrowedPt, 25e18);
        // The profit PT goes to the beneficiary, not to the funder.
        assertEq(IERC20(_series().ptToken).balanceOf(alice), profit);
        assertEq(IERC20(_series().ptToken).balanceOf(bob), 0);

        // Alice alone can close it and gets the BTC back.
        uint256 btcBefore = alice.balance;
        musd.mint(alice, 25e18);
        vm.startPrank(alice);
        musd.approve(address(vault), 25e18);
        (uint256 btcReturned, ) = vault.closeMicroPosition();
        vm.stopPrank();
        assertEq(btcReturned, 0.001 ether);
        assertEq(alice.balance, btcBefore + 0.001 ether);
    }

    function testMicroBorrowForRejectsZeroBeneficiary() public {
        vm.prank(bob);
        vm.expectRevert(bytes("beneficiary=0"));
        vault.microBorrowAndLockFor{value: 0.001 ether}(address(0), 25e18, maturity, 0, address(0), address(0));
    }

    function testCloseWithoutPositionReverts() public {
        vm.prank(bob);
        vm.expectRevert(PrismMicroVault.NoPosition.selector);
        vault.closeMicroPosition();
    }

    function testFuzzMicroBorrowKeepsIcrAboveFloorAndEscrowsPar(uint96 collateralSeed, uint96 borrowSeed) public {
        uint256 collateral = bound(uint256(collateralSeed), vault.MIN_MICRO_DEPOSIT(), 0.02 ether);
        uint256 borrow = bound(uint256(borrowSeed), vault.MIN_MICRO_BORROW(), 60e18);
        // Skip combinations the vault is designed to reject.
        vm.assume((collateral * 65_000e18) / borrow >= vault.MICRO_ICR_FLOOR());

        vm.prank(alice);
        uint256 profit = vault.microBorrowAndLock{value: collateral}(borrow, maturity, 0, address(0), address(0));

        PrismMicroVault.MicroPosition memory p = _position(alice);
        assertEq(p.musdDebt, borrow);
        assertEq(p.escrowedPt, borrow, "escrow always equals the borrowed par");
        assertGe(vault.microIcrBps(alice), ICR_FLOOR_BPS);
        assertGe(IERC20(_series().ptToken).balanceOf(alice), profit);
    }

    function testFuzzIcrFloorIsTheOnlyGateOnSize(uint96 borrowSeed) public {
        uint256 borrow = bound(uint256(borrowSeed), vault.MIN_MICRO_BORROW(), 500e18);
        // Collateral sized to sit exactly at the floor: 175% of the borrow value.
        // coll = floor(1e18-scaled) * debt / price
        // +1 wei so integer division in the vault's floor check cannot round under.
        uint256 collateral = (borrow * 175e16) / 65_000e18 + 1;
        vm.assume(collateral >= vault.MIN_MICRO_DEPOSIT());
        vm.deal(alice, collateral);

        vm.prank(alice);
        vault.microBorrowAndLock{value: collateral}(borrow, maturity, 0, address(0), address(0));

        assertGe(vault.microIcrBps(alice), ICR_FLOOR_BPS);
        assertLt(vault.microIcrBps(alice), ICR_FLOOR_BPS + 2, "sits right on the floor");
    }

    function testPriceMoveBelowFloorBlocksNewBorrow() public {
        priceFeed.setPrice(30_000e18);
        vm.prank(alice);
        vm.expectRevert(PrismMicroVault.MicroIcrTooLow.selector);
        vault.microBorrowAndLock{value: 0.001 ether}(25e18, maturity, 0, address(0), address(0));
    }

    function _position(address user) internal view returns (PrismMicroVault.MicroPosition memory p) {
        (p.btcCollateral, p.musdDebt, p.escrowedPt, p.maturity, p.upperHint, p.lowerHint) = vault.positions(user);
    }
}
