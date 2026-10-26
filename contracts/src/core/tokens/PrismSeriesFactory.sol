// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {PrismPrincipalToken} from "./PrismPrincipalToken.sol";
import {PrismYieldToken} from "./PrismYieldToken.sol";

contract PrismSeriesFactory {
    event SeriesCreated(address indexed tokenizer, uint256 indexed maturity, address ptToken, address ytToken);

    function createSeries(uint256 maturity) external returns (address ptToken, address ytToken) {
        string memory suffix = Strings.toString(maturity);

        ptToken = address(
            new PrismPrincipalToken(
                string.concat("Prism Principal sMUSD ", suffix),
                string.concat("PT-sMUSD-", suffix),
                msg.sender,
                maturity
            )
        );
        ytToken = address(
            new PrismYieldToken(
                string.concat("Prism Yield sMUSD ", suffix), string.concat("YT-sMUSD-", suffix), msg.sender, maturity
            )
        );

        // forge-lint: disable-next-line(reentrancy-events)
        emit SeriesCreated(msg.sender, maturity, ptToken, ytToken);
    }
}
