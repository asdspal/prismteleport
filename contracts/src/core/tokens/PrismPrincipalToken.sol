// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract PrismPrincipalToken is ERC20, ERC20Permit {
    address public immutable tokenizer;
    uint256 public immutable maturity;

    modifier onlyTokenizer() {
        require(msg.sender == tokenizer, "only tokenizer");
        _;
    }

    constructor(string memory name_, string memory symbol_, address tokenizer_, uint256 maturity_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        require(tokenizer_ != address(0), "tokenizer=0");
        tokenizer = tokenizer_;
        maturity = maturity_;
    }

    function mint(address to, uint256 amount) external onlyTokenizer {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyTokenizer {
        _burn(from, amount);
    }
}
