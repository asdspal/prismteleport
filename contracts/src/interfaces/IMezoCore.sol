// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Mezo canonical contract interfaces
/// @notice Signatures verified live against Mezo Testnet (31611) and Mainnet (31612)
///         on 2026-10-26. See https://mezo.org/docs and https://github.com/mezo-org/musd.
/// @dev Where the blueprint differs from the deployed contracts, the deployed ABI wins:
///      - `BorrowerOperations` exposes `musd()`, not `musdToken()`.
///      - `BorrowerOperationsSignatures` is a separate contract from `BorrowerOperations`.
///      - sMUSD is NOT ERC-4626: deposits/withdrawals are 1:1 and yield is claimed via
///        `claimYield()` using a cumulative `yieldIndex`.
///      - `PriceFeed` exposes `fetchPrice()` only; there is no `lastGoodPrice()`.

/// @notice MUSD stablecoin. Docs: https://mezo.org/docs/users/musd
interface IMUSD is IERC20Metadata {
    function mintList(address account) external view returns (bool);
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @notice MUSD Savings Rate (sMUSD). Docs: https://mezo.org/docs/users/mezo-earn/vaults/musd-savings-vault/
/// @dev Deployed implementation: 1 MUSD in = 1 sMUSD out, 1 sMUSD out = 1 MUSD back.
///      Yield is NOT reflected in the redemption rate; it accrues in `yieldIndex`
///      (`amount * 1e18 / totalSupply` per distribution) and is paid by `claimYield()`.
interface IMUSDSavingsRate is IERC20Metadata {
    function musdToken() external view returns (address);
    function yieldToken() external view returns (address);
    function strategy() external view returns (address);
    function vaultGauge() external view returns (address);
    function pcv() external view returns (address);

    /// @notice Cumulative yield per sMUSD, scaled by 1e18. Starts at 0.
    function yieldIndex() external view returns (uint256);
    function pendingYield() external view returns (uint256);
    function claimableYield(address account) external view returns (uint256);

    /// @notice Deposit MUSD and mint sMUSD 1:1 to msg.sender.
    function deposit(uint256 amount) external;
    /// @notice Burn `amount` sMUSD from msg.sender and return MUSD 1:1.
    function withdraw(uint256 amount) external;
    /// @notice Claim accrued MUSD yield for msg.sender.
    function claimYield() external returns (uint256);

    /// @notice Pull pending strategy yield into the vault (permissionless).
    function receiveYieldFromStrategy() external;
    /// @notice Record externally transferred protocol yield (permissionless).
    function receiveProtocolYield(uint256 amount) external;
}

/// @notice Mezo BorrowerOperations. Docs: https://github.com/mezo-org/musd
interface IBorrowerOperations {
    function musd() external view returns (address);

    function openTrove(uint256 debtAmount, address upperHint, address lowerHint) external payable;

    function restrictedOpenTrove(
        address borrower,
        address recipient,
        uint256 debtAmount,
        address upperHint,
        address lowerHint
    ) external payable;

    function withdrawMUSD(uint256 amount, address upperHint, address lowerHint) external;

    function repayMUSD(uint256 amount, address upperHint, address lowerHint) external;

    function closeTrove() external;
}

/// @notice Gasless EIP-712 Trove operations. Verified at
///         Testnet 0xD757e3646AF370b15f32EB557F0F8380Df7D639e and
///         Mainnet 0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a.
interface IBorrowerOperationsSignatures {
    function borrowerOperations() external view returns (address);
    function getNonce(address user) external view returns (uint256);

    function openTroveWithSignature(
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes memory signature,
        uint256 deadline
    ) external payable;

    function withdrawMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes memory signature,
        uint256 deadline
    ) external;

    function repayMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        bytes memory signature,
        uint256 deadline
    ) external;

    function closeTroveWithSignature(address borrower, address recipient, bytes memory signature, uint256 deadline)
        external;
}

/// @notice Trove state and health. Docs: https://github.com/mezo-org/musd
interface ITroveManager {
    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);
    function getTroveDebt(address borrower) external view returns (uint256);
    function getTroveColl(address borrower) external view returns (uint256);
    function getTCR(uint256 price) external view returns (uint256);
}

/// @notice Hint computation for Trove insertion. Docs: https://github.com/mezo-org/musd
interface IHintHelpers {
    function getApproxHint(uint256 cr, uint256 numTrials, uint256 inputRandomSeed)
        external
        view
        returns (address hintAddress, uint256 diff, uint256 latestRandomSeed);

    function computeNominalCR(uint256 coll, uint256 debt) external pure returns (uint256);
    function computeCR(uint256 coll, uint256 debt, uint256 price) external pure returns (uint256);
}

/// @notice Sorted Trove list. Docs: https://github.com/mezo-org/musd
interface ISortedTroves {
    function getSize() external view returns (uint256);
    function getFirst() external view returns (address);
    function getLast() external view returns (address);
    function findInsertPosition(uint256 nicr, address prevId, address nextId) external view returns (address, address);
}

/// @notice Mezo BTC/USD oracle. Docs: https://github.com/mezo-org/musd
interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}

/// @notice Wormhole NTT manager. Docs: https://wormhole.com/docs/learn/messaging/ntt/
interface INttManager {
    function token() external view returns (address);
    function getMode() external view returns (uint8);
    function chainId() external view returns (uint16);
    function getThreshold() external view returns (uint8);
}

/// @notice MEZO/BTC ERC-20 precompiles at 0x7B7c...0001 and 0x7b7C...0000.
/// @dev The MEZO `permit` returns `bool` (unlike OpenZeppelin) and requires v in {27,28}.
interface IMezoPrecompile is IERC20Metadata {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (bool);
}
