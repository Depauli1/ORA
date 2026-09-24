// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/AggregatorV3Interface.sol";

/*
 * ORA Phase 1.5 — shared Chainlink reading logic for ORA price feed adapters.
 * A feed response is valid iff: the call succeeds, answer > 0, and the round
 * is no older than the staleness timeout. Prices are scaled to 18 decimals.
 */
contract ChainlinkFeedReader {

    function _readFeed(AggregatorV3Interface _agg, uint8 _feedDecimals, uint256 _timeout)
        internal
        view
        returns (uint256 price, bool ok)
    {
        try _agg.latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0) { return (0, false); }
            if (updatedAt > block.timestamp) { return (0, false); }
            if (block.timestamp - updatedAt > _timeout) { return (0, false); }
            return (_scalePrice(uint256(answer), _feedDecimals), true);
        } catch {
            return (0, false);
        }
    }

    function _scalePrice(uint256 _price, uint8 _feedDecimals) internal pure returns (uint256) {
        if (_feedDecimals < 18) {
            return _price * (10 ** uint256(18 - _feedDecimals));
        }
        if (_feedDecimals > 18) {
            return _price / (10 ** uint256(_feedDecimals - 18));
        }
        return _price;
    }
}
