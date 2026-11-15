// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBorrowerOperationsSignatures, ITroveManager, IPriceFeed} from "../interfaces/IMezoCore.sol";
import {PrismYieldAMM} from "./PrismYieldAMM.sol";

/// @title PrismBorrowLockRouter
/// @notice Stateless, zero-custody, ownerless router for 1-signature atomic
///         Borrow & Lock Fixed Carry on Mezo (R-006, R-012, R-013, STRIDE-01).
/// @dev    Borrows MUSD via BorrowerOperationsSignatures, enforces post-borrow
///         ICR >= 150% (165% in Recovery Mode), optionally reimburses a relayer
///         in MUSD (capped at 1% of borrow), swaps the remainder into PT-sMUSD
///         through PrismYieldAMM, and delivers PT to the borrower. Holds no
///         balances after the call.
contract PrismBorrowLockRouter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_ICR_NORMAL = 150e16;
    uint256 public constant MIN_ICR_RECOVERY = 165e16;
    uint256 public constant MAX_RELAYER_FEE_BPS = 100;
    uint256 public constant BPS = 10_000;

    /// @dev Signed by the borrower so a third-party relayer cannot alter terms (STRIDE-01).
    struct LockTerms {
        address borrower;
        uint256 musdBorrowAmount;
        uint256 maturity;
        uint256 minPtOut;
        uint256 relayerFeeMusd;
        uint256 nonce;
        uint256 deadline;
    }

    struct BorrowLockParams {
        address borrower;
        uint256 musdBorrowAmount;
        uint256 maturity;
        uint256 minPtOut;
        uint256 relayerFeeMusd;
        uint256 nonce;
        uint256 deadline;
        uint256 mezoDeadline;
        address upperHint;
        address lowerHint;
    }

    bytes32 public constant LOCK_TERMS_TYPEHASH = keccak256(
        "LockTerms(address borrower,uint256 musdBorrowAmount,uint256 maturity,uint256 minPtOut,uint256 relayerFeeMusd,uint256 nonce,uint256 deadline)"
    );

    IBorrowerOperationsSignatures public immutable borrowerOpsSignatures;
    ITroveManager public immutable troveManager;
    IPriceFeed public immutable priceFeed;
    PrismYieldAMM public immutable amm;
    IERC20 public immutable musd;

    mapping(address => mapping(uint256 => bool)) public usedNonces;

    event BorrowedAndLockedFixedCarry(
        address indexed borrower,
        address indexed relayer,
        uint256 indexed maturity,
        uint256 musdBorrowed,
        uint256 ptReceived,
        uint256 postBorrowIcr,
        uint256 relayerFeeMusd
    );

    constructor(
        IBorrowerOperationsSignatures _borrowerOpsSignatures,
        ITroveManager _troveManager,
        IPriceFeed _priceFeed,
        PrismYieldAMM _amm,
        IERC20 _musd
    ) EIP712("PrismBorrowLockRouter", "1") {
        require(address(_borrowerOpsSignatures) != address(0), "bops=0");
        require(address(_troveManager) != address(0), "tm=0");
        require(address(_priceFeed) != address(0), "pf=0");
        require(address(_amm) != address(0), "amm=0");
        require(address(_musd) != address(0), "musd=0");
        borrowerOpsSignatures = _borrowerOpsSignatures;
        troveManager = _troveManager;
        priceFeed = _priceFeed;
        amm = _amm;
        musd = _musd;
    }

    /// @notice Atomically borrow MUSD against an existing Trove and lock it into PT-sMUSD.
    function borrowAndLockFixedYield(
        BorrowLockParams calldata p,
        bytes calldata mezoBorrowSig,
        bytes calldata prismLockSig
    ) external nonReentrant returns (uint256 ptOut) {
        _consumeLockTerms(p, prismLockSig);

        borrowerOpsSignatures.withdrawMUSDWithSignature(
            p.musdBorrowAmount,
            p.upperHint,
            p.lowerHint,
            p.borrower,
            address(this),
            mezoBorrowSig,
            p.mezoDeadline
        );

        ptOut = _settle(p);

        // forge-lint: disable-next-line(incorrect-strict-equality)
        require(musd.balanceOf(address(this)) == 0, "musd dust");
        // forge-lint: disable-next-line(incorrect-strict-equality)
        require(address(this).balance == 0, "btc dust");
    }

    /// @notice Open a new Trove with native BTC (`msg.value`) and lock the minted MUSD into PT-sMUSD.
    function openTroveAndLockFixedYield(
        BorrowLockParams calldata p,
        bytes calldata mezoOpenSig,
        bytes calldata prismLockSig
    ) external payable nonReentrant returns (uint256 ptOut) {
        _consumeLockTerms(p, prismLockSig);

        borrowerOpsSignatures.openTroveWithSignature{value: msg.value}(
            p.musdBorrowAmount,
            p.upperHint,
            p.lowerHint,
            p.borrower,
            address(this),
            mezoOpenSig,
            p.mezoDeadline
        );

        ptOut = _settle(p);

        // forge-lint: disable-next-line(incorrect-strict-equality)
        require(musd.balanceOf(address(this)) == 0, "musd dust");
        // forge-lint: disable-next-line(incorrect-strict-equality)
        require(address(this).balance == 0, "btc dust");
    }

    /// @notice Read-only preview of a borrow-and-lock quote.
    function previewBorrowAndLock(address borrower, uint256 additionalMusdDebt, uint256 maturity)
        external
        view
        returns (uint256 ptOut, uint256 newIcr, uint256 fixedApyBps)
    {
        // forge-lint: disable-next-line(unused-return)
        (ptOut, fixedApyBps,) = amm.quoteBorrowAndLockSpread(maturity, additionalMusdDebt, 0);

        uint256 price = priceFeed.fetchPrice();
        uint256 coll = troveManager.getTroveColl(borrower);
        uint256 debt = troveManager.getTroveDebt(borrower) + additionalMusdDebt;
        newIcr = debt == 0 ? type(uint256).max : (coll * price) / debt;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _consumeLockTerms(BorrowLockParams calldata p, bytes calldata prismLockSig) internal {
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp <= p.deadline, "expired");
        require(!usedNonces[p.borrower][p.nonce], "nonce used");

        bytes32 structHash = keccak256(
            abi.encode(
                LOCK_TERMS_TYPEHASH,
                p.borrower,
                p.musdBorrowAmount,
                p.maturity,
                p.minPtOut,
                p.relayerFeeMusd,
                p.nonce,
                p.deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), prismLockSig);
        require(signer == p.borrower, "bad lock sig");

        usedNonces[p.borrower][p.nonce] = true;
    }

    function _settle(BorrowLockParams calldata p) internal returns (uint256 ptOut) {
        uint256 price = priceFeed.fetchPrice();
        require(price > 0, "no price");

        uint256 tcr = troveManager.getTCR(price);
        uint256 minIcr = tcr < MIN_ICR_NORMAL ? MIN_ICR_RECOVERY : MIN_ICR_NORMAL;
        uint256 icr = troveManager.getCurrentICR(p.borrower, price);
        require(icr >= minIcr, "icr");

        uint256 fee = 0;
        if (msg.sender != p.borrower) {
            fee = p.relayerFeeMusd;
            uint256 maxFee = (p.musdBorrowAmount * MAX_RELAYER_FEE_BPS) / BPS;
            if (fee > maxFee) fee = maxFee;
        }
        if (fee != 0) musd.safeTransfer(msg.sender, fee);

        uint256 netMusd = p.musdBorrowAmount - fee;
        musd.forceApprove(address(amm), netMusd);
        ptOut = amm.swapExactMusdForPt(p.maturity, netMusd, p.minPtOut, p.borrower);
        musd.forceApprove(address(amm), 0);

        // forge-lint: disable-next-line(reentrancy-events)
        emit BorrowedAndLockedFixedCarry(p.borrower, msg.sender, p.maturity, p.musdBorrowAmount, ptOut, icr, fee);
    }
}
