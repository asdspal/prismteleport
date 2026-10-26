// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal ERC20 used only to prove the toolchain (solc 0.8.28 + OZ 5.1.0) compiles.
contract SmokeToken is ERC20 {
    constructor() ERC20("Smoke", "SMOKE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
