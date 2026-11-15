// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PrismYieldAMM} from "../core/PrismYieldAMM.sol";
import {PrismTokenizer} from "../core/PrismTokenizer.sol";
import {
    IBorrowerOperations,
    IMUSDSavingsRate,
    IPriceFeed,
    ITroveManager
} from "../interfaces/IMezoCore.sol";

/// @title PrismMicroVault
/// @notice Sub-minimum shared-Trove adapter (R-011, DEC-002): Mezo rejects any
/// Trove under 1,800 MUSD of net debt, which locks out small borrowers. The vault
/// keeps one master Trove and lets anyone open a micro position against it with
/// as little as 0.0002 BTC / 10 MUSD, provided the *sub-account* stays above a
/// 175% ICR floor. The borrowed MUSD is swapped into PT-sMUSD: the fixed-yield
/// excess is paid to the user immediately, while `musdBorrowAmount` of PT stays
/// escrowed as the par-value backing for that user's debt (1 PT = 1 MUSD at
/// maturity, so the micro loan settles itself).
contract PrismMicroVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct MicroPosition {
        uint256 btcCollateral;
        uint256 musdDebt;
        uint256 escrowedPt;
        uint256 maturity;
        address upperHint;
        address lowerHint;
    }

    /// @notice Smallest micro borrow the vault accepts (10 MUSD).
    uint256 public constant MIN_MICRO_BORROW = 10e18;
    /// @notice Smallest BTC deposit the vault accepts (~0.0002 BTC).
    uint256 public constant MIN_MICRO_DEPOSIT = 0.0002 ether;
    /// @notice Per-user ICR floor, above the router's 150% borrow floor.
    uint256 public constant MICRO_ICR_FLOOR = 175e16;
    /// @notice Mezo's minimum net debt for the master Trove itself.
    uint256 public constant MIN_MASTER_DEBT = 1_800e18;
    /// @notice Safety margin required when activating the master Trove.
    uint256 public constant MIN_MASTER_ICR = 2e18;

    IERC20 public immutable musd;
    IMUSDSavingsRate public immutable smusd;
    IBorrowerOperations public immutable borrowerOps;
    ITroveManager public immutable troveManager;
    IPriceFeed public immutable priceFeed;
    PrismYieldAMM public immutable amm;
    PrismTokenizer public immutable tokenizer;

    /// @notice True once the master Trove exists (lazy activation, see below).
    bool public masterActive;

    mapping(address => MicroPosition) public positions;

    uint256 public totalMicroCollateral;
    uint256 public totalMicroDebt;
    uint256 public totalEscrowedPt;

    event MasterTroveActivated(uint256 debtAmount, uint256 collateral);
    event MicroBorrowAndLock(
        address indexed user,
        uint256 maturity,
        uint256 btcDeposited,
        uint256 musdBorrowed,
        uint256 ptOut,
        uint256 profitToUser
    );
    event MicroFundedBy(address indexed funder, address indexed beneficiary, uint256 btcDeposited);
    event MicroPositionClosed(
        address indexed user,
        uint256 maturity,
        uint256 btcReturned,
        uint256 ptReturned,
        bool settledAtMaturity
    );

    error MasterInactive();
    error MasterAlreadyActive();
    error DepositTooSmall();
    error BorrowTooSmall();
    error MaturityMismatch();
    error MicroIcrTooLow();
    error MasterDebtTooSmall();
    error MasterIcrTooLow();
    error NoMicroCarry();
    error NoPosition();

    constructor(
        IERC20 _musd,
        IMUSDSavingsRate _smusd,
        IBorrowerOperations _borrowerOps,
        ITroveManager _troveManager,
        IPriceFeed _priceFeed,
        PrismYieldAMM _amm,
        PrismTokenizer _tokenizer
    ) {
        require(address(_musd) != address(0), "musd=0");
        require(address(_smusd) != address(0), "smusd=0");
        require(address(_borrowerOps) != address(0), "borrowerOps=0");
        require(address(_troveManager) != address(0), "troveManager=0");
        require(address(_priceFeed) != address(0), "priceFeed=0");
        require(address(_amm) != address(0), "amm=0");
        require(address(_tokenizer) != address(0), "tokenizer=0");
        musd = _musd;
        smusd = _smusd;
        borrowerOps = _borrowerOps;
        troveManager = _troveManager;
        priceFeed = _priceFeed;
        amm = _amm;
        tokenizer = _tokenizer;
    }

    /// @dev The vault receives BTC back from the master Trove on every close, and
    /// Mezo's ActivePool pings recipients with a zero-value call.
    receive() external payable {}

    /// @notice Opens the master Trove. Anyone may call it (the deployer may not
    /// hold the ~0.05 BTC a 1,800 MUSD Trove needs), and the caller's BTC becomes
    /// the vault's shared collateral.
    function activateMasterTrove(uint256 debtAmount, address upperHint, address lowerHint)
        external
        payable
        nonReentrant
    {
        if (masterActive) revert MasterAlreadyActive();
        if (debtAmount < MIN_MASTER_DEBT) revert MasterDebtTooSmall();

        uint256 price = priceFeed.fetchPrice();
        if ((msg.value * price) / debtAmount < MIN_MASTER_ICR) revert MasterIcrTooLow();

        borrowerOps.openTrove{value: msg.value}(debtAmount, upperHint, lowerHint);
        masterActive = true;
        emit MasterTroveActivated(debtAmount, msg.value);
    }

    /// @notice Opens or tops up a micro position: deposit BTC, borrow MUSD against
    /// the master Trove, lock it into PT-sMUSD and receive the fixed-yield excess
    /// straight away.
    /// @return profitToUser PT-sMUSD sent to the caller (`ptOut - musdBorrowAmount`).
    function microBorrowAndLock(
        uint256 musdBorrowAmount,
        uint256 maturity,
        uint256 minPtOut,
        address upperHint,
        address lowerHint
    ) external payable nonReentrant returns (uint256 profitToUser) {
        return _microBorrowAndLock(msg.sender, msg.sender, musdBorrowAmount, maturity, minPtOut, upperHint, lowerHint);
    }

    /// @notice Opens a micro position **for someone else**, so a router (for
    /// example the cross-chain TeleportHub) can never take custody: the position,
    /// its escrowed PT and its BTC are keyed to `onBehalfOf`, who closes it
    /// directly. Griefing is impossible by construction, because the only way to
    /// open a position is to hand over BTC.
    function microBorrowAndLockFor(
        address onBehalfOf,
        uint256 musdBorrowAmount,
        uint256 maturity,
        uint256 minPtOut,
        address upperHint,
        address lowerHint
    ) external payable nonReentrant returns (uint256 profitToUser) {
        require(onBehalfOf != address(0), "beneficiary=0");
        return _microBorrowAndLock(onBehalfOf, msg.sender, musdBorrowAmount, maturity, minPtOut, upperHint, lowerHint);
    }

    function _microBorrowAndLock(
        address beneficiary,
        address funder,
        uint256 musdBorrowAmount,
        uint256 maturity,
        uint256 minPtOut,
        address upperHint,
        address lowerHint
    ) internal returns (uint256 profitToUser) {
        if (!masterActive) revert MasterInactive();
        if (msg.value < MIN_MICRO_DEPOSIT) revert DepositTooSmall();
        if (musdBorrowAmount < MIN_MICRO_BORROW) revert BorrowTooSmall();

        MicroPosition storage p = positions[beneficiary];
        if (p.maturity != 0 && p.maturity != maturity) revert MaturityMismatch();

        uint256 price = priceFeed.fetchPrice();
        uint256 newCollateral = p.btcCollateral + msg.value;
        uint256 newDebt = p.musdDebt + musdBorrowAmount;
        if ((newCollateral * price) / newDebt < MICRO_ICR_FLOOR) revert MicroIcrTooLow();

        // Draw the MUSD onto the master Trove, then lock it into the fixed leg.
        borrowerOps.adjustTrove{value: msg.value}(0, musdBorrowAmount, true, upperHint, lowerHint);

        IERC20 pt = IERC20(tokenizer.getSeries(maturity).ptToken);
        musd.forceApprove(address(amm), musdBorrowAmount);
        uint256 ptOut = amm.swapExactMusdForPt(maturity, musdBorrowAmount, minPtOut, address(this));
        musd.forceApprove(address(amm), 0);

        // The escrow must be able to repay the debt at par, and anything above it
        // is the user's locked carry, paid out immediately.
        if (ptOut < musdBorrowAmount) revert NoMicroCarry();
        profitToUser = ptOut - musdBorrowAmount;

        p.btcCollateral = newCollateral;
        p.musdDebt = newDebt;
        p.escrowedPt += musdBorrowAmount;
        p.maturity = maturity;
        p.upperHint = upperHint;
        p.lowerHint = lowerHint;

        totalMicroCollateral += msg.value;
        totalMicroDebt += musdBorrowAmount;
        totalEscrowedPt += musdBorrowAmount;

        if (profitToUser > 0) pt.safeTransfer(beneficiary, profitToUser);

        emit MicroBorrowAndLock(beneficiary, maturity, msg.value, musdBorrowAmount, ptOut, profitToUser);
        if (funder != beneficiary) emit MicroFundedBy(funder, beneficiary, msg.value);
    }

    /// @notice Closes a micro position and returns 100% of the user's BTC.
    /// Before maturity the caller repays the debt in MUSD and keeps the escrowed
    /// PT; at or after maturity the escrowed PT settles the debt by itself
    /// (PT -> sMUSD -> MUSD, both at par).
    /// @return btcReturned BTC sent back to the caller.
    /// @return ptReturned PT sent back to the caller (0 when settled at maturity).
    function closeMicroPosition() external nonReentrant returns (uint256 btcReturned, uint256 ptReturned) {
        MicroPosition memory p = positions[msg.sender];
        if (p.musdDebt == 0) revert NoPosition();

        bool atMaturity = block.timestamp >= p.maturity;
        address upperHint = p.upperHint;
        address lowerHint = p.lowerHint;

        // Checks-effects-interactions: clear the position before touching the Trove.
        delete positions[msg.sender];
        totalMicroCollateral -= p.btcCollateral;
        totalMicroDebt -= p.musdDebt;
        totalEscrowedPt -= p.escrowedPt;

        if (atMaturity) {
            // PT redeems into sMUSD at par, and sMUSD withdraws 1:1 for MUSD.
            // forge-lint: disable-next-line(unused-return)
            tokenizer.redeemPtAfterMaturity(p.escrowedPt, p.maturity, address(this));
            smusd.withdraw(p.escrowedPt);
        } else {
            // The user repays the debt in MUSD and keeps the escrowed PT.
            musd.safeTransferFrom(msg.sender, address(this), p.musdDebt);
        }

        borrowerOps.adjustTrove(p.btcCollateral, p.musdDebt, false, upperHint, lowerHint);

        btcReturned = p.btcCollateral;
        if (!atMaturity) {
            ptReturned = p.escrowedPt;
            IERC20(tokenizer.getSeries(p.maturity).ptToken).safeTransfer(msg.sender, ptReturned);
        }

        (bool ok, ) = msg.sender.call{value: btcReturned}("");
        require(ok, "btc return failed");

        // forge-lint: disable-next-line(reentrancy-events)
        emit MicroPositionClosed(msg.sender, p.maturity, btcReturned, ptReturned, atMaturity);
    }

    /// @notice Live ICR of a micro position at the current oracle price, in bps.
    function microIcrBps(address user) external view returns (uint256) {
        MicroPosition storage p = positions[user];
        if (p.musdDebt == 0) return 0;
        return (p.btcCollateral * priceFeed.fetchPrice() * 10_000) / (p.musdDebt * 1e18);
    }
}
