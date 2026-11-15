// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PrismYieldAMM} from "../core/PrismYieldAMM.sol";
import {PrismTokenizer} from "../core/PrismTokenizer.sol";
import {PrismMicroVault} from "./PrismMicroVault.sol";
import {IBorrowerOperationsSignatures} from "../interfaces/IMezoCore.sol";

/// @notice Minimal Wormhole NTT surface used to beam MUSD back to Base.
interface INttManager {
    function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient, uint256 fee)
        external
        payable
        returns (uint64 sequence);
}

/// @title TeleportHub
/// @notice Stateless, non-custodial Mezo execution hub (R-007, R-008, R-019,
/// R-021, STRIDE-05). A user signs a `TeleportIntent` on Base; the relayer relays
/// it here with the bridged BTC as `msg.value`. The hub opens the Trove **in the
/// user's own address** (or routes through the shared `PrismMicroVault` when the
/// borrow is under Mezo's 1,800 MUSD minimum) and sends the output straight to
/// the user: PT-sMUSD for a fixed-carry lock, or MUSD beamed back to Base over
/// Wormhole NTT.
///
/// Nothing is pooled: the hub keeps no balances between calls, has no admin and
/// no upgrade path. If the on-chain leg reverts for any reason (a mid-flight BTC
/// crash moving the ICR, a stale hint, a bad `minPtOut`), the whole call is
/// caught and 100% of the BTC is credited to the borrower's rescue escrow, so a
/// relay can never strand funds.
contract TeleportHub is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum IntentType {
        BORROW_AND_LOCK_PT,
        BORROW_AND_TELEPORT_MUSD,
        MICRO_TELEPORT,
        REPAY_AND_CLOSE
    }

    struct TeleportIntent {
        uint256 sourceChainId;
        uint256 destChainId;
        address borrower;
        IntentType intentType;
        uint256 collateralBtcWei;
        uint256 musdAmountWei;
        uint256 minOutputWei;
        uint256 relayerFeeMusdWei;
        uint256 deadline;
        uint256 nonce;
        uint256 seriesMaturity;
    }

    /// @notice Mezo's minimum net debt for a standalone Trove.
    uint256 public constant MIN_TROVE_DEBT = 1_800e18;

    bytes32 public constant TELEPORT_INTENT_TYPEHASH = keccak256(
        "TeleportIntent(uint256 sourceChainId,uint256 destChainId,address borrower,uint8 intentType,uint256 collateralBtcWei,uint256 musdAmountWei,uint256 minOutputWei,uint256 relayerFeeMusdWei,uint256 deadline,uint256 nonce,uint256 seriesMaturity)"
    );

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    IERC20 public immutable musd;
    IBorrowerOperationsSignatures public immutable borrowerOpsSignatures;
    PrismMicroVault public immutable microVault;
    PrismYieldAMM public immutable amm;
    PrismTokenizer public immutable tokenizer;
    INttManager public immutable nttManager;
    uint16 public immutable baseChainId;
    bytes32 public immutable domainSeparator;

    mapping(bytes32 => bool) public processedIntents;
    mapping(address => uint256) public claimableRescueBtc;

    event TeleportExecuted(
        bytes32 indexed intentHash,
        address indexed borrower,
        IntentType intentType,
        uint256 musdBorrowed,
        uint256 routedAmount
    );
    event TeleportRoutedToRescueEscrow(bytes32 indexed intentHash, address indexed borrower, uint256 btcCredited);
    event RescueBtcWithdrawn(address indexed borrower, uint256 amount);

    error WrongDestination();
    error IntentExpired();
    error CollateralMismatch();
    error AlreadyProcessed();
    error BadSignature();
    error OnlySelfCall();
    error NothingToRescue();

    constructor(
        IERC20 _musd,
        IBorrowerOperationsSignatures _borrowerOpsSignatures,
        PrismMicroVault _microVault,
        PrismYieldAMM _amm,
        PrismTokenizer _tokenizer,
        INttManager _nttManager,
        uint16 _baseChainId
    ) {
        require(address(_musd) != address(0), "musd=0");
        require(address(_borrowerOpsSignatures) != address(0), "bos=0");
        require(address(_microVault) != address(0), "vault=0");
        require(address(_amm) != address(0), "amm=0");
        require(address(_tokenizer) != address(0), "tokenizer=0");
        require(address(_nttManager) != address(0), "ntt=0");
        musd = _musd;
        borrowerOpsSignatures = _borrowerOpsSignatures;
        microVault = _microVault;
        amm = _amm;
        tokenizer = _tokenizer;
        nttManager = _nttManager;
        baseChainId = _baseChainId;
        domainSeparator = keccak256(
            abi.encode(_EIP712_DOMAIN_TYPEHASH, keccak256("PrismTeleportHub"), keccak256("1"), block.chainid, address(this))
        );
    }

    receive() external payable {}

    /// @notice Hashes an intent exactly as the user signs it off-chain.
    function hashIntent(TeleportIntent calldata intent) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TELEPORT_INTENT_TYPEHASH,
                intent.sourceChainId,
                intent.destChainId,
                intent.borrower,
                intent.intentType,
                intent.collateralBtcWei,
                intent.musdAmountWei,
                intent.minOutputWei,
                intent.relayerFeeMusdWei,
                intent.deadline,
                intent.nonce,
                intent.seriesMaturity
            )
        );
    }

    /// @notice Digest the borrower signs (EIP-712 over this hub on this chain).
    function intentDigest(TeleportIntent calldata intent) public view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator, hashIntent(intent));
    }

    /// @notice Executes a relayed teleport. The bridged BTC arrives as `msg.value`.
    /// Never reverts on an execution failure: the BTC is credited to the
    /// borrower's rescue escrow instead (STRIDE-05).
    function executeCrossChainTeleport(
        TeleportIntent calldata intent,
        bytes calldata mezoBorrowSig,
        bytes calldata prismIntentSig,
        address upperHint,
        address lowerHint
    ) external payable nonReentrant {
        if (intent.destChainId != block.chainid) revert WrongDestination();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (intent.collateralBtcWei != msg.value) revert CollateralMismatch();

        bytes32 intentHash = hashIntent(intent);
        if (processedIntents[intentHash]) revert AlreadyProcessed();
        if (ECDSA.recover(intentDigest(intent), prismIntentSig) != intent.borrower) revert BadSignature();
        processedIntents[intentHash] = true;

        try this.executeInner{value: msg.value}(intent, mezoBorrowSig, upperHint, lowerHint) returns (uint256 routed) {
            emit TeleportExecuted(intentHash, intent.borrower, intent.intentType, intent.musdAmountWei, routed);
        } catch {
            // STRIDE-05: nothing is ever stranded; the borrower can withdraw the
            // full BTC (or re-submit a fresh intent with updated hints).
            claimableRescueBtc[intent.borrower] += msg.value;
            emit TeleportRoutedToRescueEscrow(intentHash, intent.borrower, msg.value);
        }
    }

    /// @dev External so `executeCrossChainTeleport` can wrap it in try/catch;
    /// callable only by this contract itself (Issue 1 of the step).
    function executeInner(
        TeleportIntent calldata intent,
        bytes calldata mezoBorrowSig,
        address upperHint,
        address lowerHint
    ) external payable returns (uint256 routed) {
        if (msg.sender != address(this)) revert OnlySelfCall();

        if (intent.intentType == IntentType.MICRO_TELEPORT || intent.musdAmountWei < MIN_TROVE_DEBT) {
            // Sub-minimum borrow: the shared vault opens the position in the
            // borrower's name and pays the fixed-yield excess to them directly.
            microVault.microBorrowAndLockFor{value: msg.value}(
                intent.borrower, intent.musdAmountWei, intent.seriesMaturity, intent.minOutputWei, upperHint, lowerHint
            );
            return 0;
        }

        // Standalone Trove opened in the borrower's own address, MUSD to the hub
        // only long enough to route it.
        borrowerOpsSignatures.openTroveWithSignature{value: msg.value}(
            intent.musdAmountWei, upperHint, lowerHint, intent.borrower, address(this), mezoBorrowSig, intent.deadline
        );

        if (intent.intentType == IntentType.BORROW_AND_LOCK_PT) {
            musd.forceApprove(address(amm), intent.musdAmountWei);
            routed = amm.swapExactMusdForPt(
                intent.seriesMaturity, intent.musdAmountWei, intent.minOutputWei, intent.borrower
            );
            musd.forceApprove(address(amm), 0);
        } else {
            musd.forceApprove(address(nttManager), intent.musdAmountWei);
            nttManager.transfer(intent.musdAmountWei, baseChainId, bytes32(uint256(uint160(intent.borrower))), 0);
            musd.forceApprove(address(nttManager), 0);
            routed = intent.musdAmountWei;
        }
    }

    /// @notice Withdraws BTC credited to the rescue escrow after a failed
    /// on-chain leg. The borrower keeps full ownership the whole time.
    function withdrawRescueBtc() external nonReentrant returns (uint256 amount) {
        amount = claimableRescueBtc[msg.sender];
        if (amount == 0) revert NothingToRescue();
        claimableRescueBtc[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "rescue transfer failed");
        emit RescueBtcWithdrawn(msg.sender, amount);
    }
}
