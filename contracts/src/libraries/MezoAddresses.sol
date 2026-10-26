// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Mezo canonical addresses
/// @notice Chain-ID-aware resolver for Mezo Testnet (31611) and Mainnet (31612).
/// @dev Verified on-chain on 2026-10-26. `smusd` is zero on Testnet because the
///      Savings Rate vault is not deployed there (GAP-001; see TestnetFeeInjector).
library MezoAddresses {
    uint256 internal constant MEZO_TESTNET = 31611;
    uint256 internal constant MEZO_MAINNET = 31612;

    struct Addresses {
        address musd;
        address smusd;
        address borrowerOperations;
        address borrowerOperationsSignatures;
        address troveManager;
        address hintHelpers;
        address sortedTroves;
        address priceFeed;
        address nttManager;
        address mezoToken;
        address btcPrecompile;
    }

    function getAddresses(uint256 chainId) internal pure returns (Addresses memory a) {
        a.mezoToken = 0x7B7c000000000000000000000000000000000001;
        a.btcPrecompile = 0x7b7C000000000000000000000000000000000000;

        if (chainId == MEZO_TESTNET) {
            a.musd = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
            a.smusd = address(0);
            a.borrowerOperations = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;
            a.borrowerOperationsSignatures = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
            a.troveManager = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
            a.hintHelpers = 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6;
            a.sortedTroves = 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA;
            a.priceFeed = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
            a.nttManager = 0x20888B20e2F5F405d44261dA96467a1b1acE15be;
        } else if (chainId == MEZO_MAINNET) {
            a.musd = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
            a.smusd = 0xb4D498029af77680cD1eF828b967f010d06C51CC;
            a.borrowerOperations = 0x44b1bac67dDA612a41a58AAf779143B181dEe031;
            a.borrowerOperationsSignatures = 0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a;
            a.troveManager = 0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193;
            a.hintHelpers = 0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3;
            a.sortedTroves = 0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f;
            a.priceFeed = 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88;
            a.nttManager = 0x7efb386675d75280D39Aae42964A6776DE0ee0bD;
        } else {
            revert("MezoAddresses: unsupported chain");
        }
    }
}
