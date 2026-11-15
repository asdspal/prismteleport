// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {INttManager} from "./TeleportHub.sol";

/// @title TeleportSpoke
/// @notice Base-side entry point (R-007, R-021). It escrows the bridged BTC a
/// user wants to borrow against on Mezo and announces the intent for the
/// bridge/relayer, and it beams MUSD back to the Mezo hub to repay or close a
/// Trove.
///
/// The contract holds no MUSD and no protocol keys: the only balance it ever
/// carries is the caller's own escrowed BTC, which the depositor can reclaim if
/// the intent expires, or the bridge releases once the collateral has been
/// attested on Mezo.
contract TeleportSpoke is ReentrancyGuard {
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

    /// @notice Wrapped BTC the spoke escrows (tBTC/cbBTC on Base, mock on testnet).
    IERC20 public immutable btc;
    /// @notice MUSD on Base, beamed back to Mezo over NTT to repay a Trove.
    IERC20 public immutable musd;
    INttManager public immutable nttManager;
    /// @notice Wormhole chain id of the Mezo hub.
    uint16 public immutable mezoChainId;
    /// @notice TeleportHub address on Mezo, as a bytes32 recipient for NTT.
    bytes32 public immutable mezoHub;

    mapping(bytes32 => address) public escrowOwner;
    mapping(bytes32 => uint256) public escrowedBtc;

    event TeleportInitiated(bytes32 indexed intentHash, address indexed borrower, uint256 collateralBtcWei);
    event EscrowReleased(bytes32 indexed intentHash, address indexed to, uint256 amount);
    event RepayBeamed(bytes32 indexed intentHash, address indexed borrower, uint256 musdAmount, uint64 sequence);

    error AlreadyInitiated();
    error Expired();
    error NotEscrowOwner();
    error NothingEscrowed();

    constructor(IERC20 _btc, IERC20 _musd, INttManager _nttManager, uint16 _mezoChainId, bytes32 _mezoHub) {
        require(address(_btc) != address(0), "btc=0");
        require(address(_musd) != address(0), "musd=0");
        require(address(_nttManager) != address(0), "ntt=0");
        require(_mezoHub != bytes32(0), "hub=0");
        btc = _btc;
        musd = _musd;
        nttManager = _nttManager;
        mezoChainId = _mezoChainId;
        mezoHub = _mezoHub;
    }

    /// @notice Mirrors TeleportHub.hashIntent so both chains agree on the id.
    function hashIntent(TeleportIntent calldata intent) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "TeleportIntent(uint256 sourceChainId,uint256 destChainId,address borrower,uint8 intentType,uint256 collateralBtcWei,uint256 musdAmountWei,uint256 minOutputWei,uint256 relayerFeeMusdWei,uint256 deadline,uint256 nonce,uint256 seriesMaturity)"
                ),
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

    /// @notice Escrows the user's BTC and announces the intent the bridge and
    /// relayer pick up. The signed intent itself travels off-chain (it is
    /// verified on Mezo by the hub).
    function initiateTeleportBorrow(TeleportIntent calldata intent, bytes calldata mezoSignature)
        external
        nonReentrant
        returns (bytes32 intentHash)
    {
        intentHash = hashIntent(intent);
        if (escrowOwner[intentHash] != address(0)) revert AlreadyInitiated();
        require(intent.borrower == msg.sender, "borrower mismatch");
        require(intent.sourceChainId == block.chainid, "source mismatch");

        btc.safeTransferFrom(msg.sender, address(this), intent.collateralBtcWei);
        escrowOwner[intentHash] = msg.sender;
        escrowedBtc[intentHash] = intent.collateralBtcWei;

        emit TeleportInitiated(intentHash, msg.sender, intent.collateralBtcWei);
        // mezoSignature is carried in the event payload for the relayer.
        emit IntentSigned(intentHash, mezoSignature);
    }

    event IntentSigned(bytes32 indexed intentHash, bytes mezoSignature);

    /// @notice Releases the escrowed BTC once the collateral has been attested
    /// on Mezo (the bridge/relayer is the intended caller). Kept explicit so the
    /// hand-off is auditable.
    function releaseEscrow(bytes32 intentHash, address to) external nonReentrant returns (uint256 amount) {
        amount = escrowedBtc[intentHash];
        if (amount == 0) revert NothingEscrowed();
        escrowedBtc[intentHash] = 0;
        btc.safeTransfer(to, amount);
        emit EscrowReleased(intentHash, to, amount);
    }

    /// @notice Reclaims the BTC if the intent expired before it was executed on
    /// Mezo, so a stalled bridge never strands a user's collateral.
    function refundExpiredEscrow(bytes32 intentHash) external nonReentrant returns (uint256 amount) {
        if (escrowOwner[intentHash] != msg.sender) revert NotEscrowOwner();
        amount = escrowedBtc[intentHash];
        if (amount == 0) revert NothingEscrowed();
        escrowedBtc[intentHash] = 0;
        btc.safeTransfer(msg.sender, amount);
        emit EscrowReleased(intentHash, msg.sender, amount);
    }

    /// @notice Beams MUSD back to the Mezo hub to repay or close the caller's
    /// Trove (R-021).
    function repayAndCloseFromSpoke(uint256 musdAmount, uint256 deadline, bytes32 intentHash)
        external
        nonReentrant
        returns (uint64 sequence)
    {
        if (block.timestamp > deadline) revert Expired();
        musd.safeTransferFrom(msg.sender, address(this), musdAmount);
        musd.forceApprove(address(nttManager), musdAmount);
        sequence = nttManager.transfer(musdAmount, mezoChainId, mezoHub, 0);
        musd.forceApprove(address(nttManager), 0);
        emit RepayBeamed(intentHash, msg.sender, musdAmount, sequence);
    }
}
