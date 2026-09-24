// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/AggregatorV3Interface.sol";
import "../Dependencies/SafeMath.sol";

/*
 * ORA Phase 1.5 — shared Chainlink reading logic for ORA price feed adapters.
 * A feed response is valid iff: the call succeeds, answer > 0, and the round
 * is no older than the staleness timeout. Prices are scaled to 18 decimals.
 */
contract ChainlinkFeedReader {
    using SafeMath for uint256;

    function _readFeed(AggregatorV3Interface _agg, uint8 _feedDecimals, uint _timeout)
        internal
        view
        returns (uint price, bool ok)
    {
        try _agg.latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0) { return (0, false); }
            if (updatedAt > block.timestamp) { return (0, false); }
            if (block.timestamp.sub(updatedAt) > _timeout) { return (0, false); }
            return (_scalePrice(uint(answer), _feedDecimals), true);
        } catch {
            return (0, false);
        }
    }

    function _scalePrice(uint _price, uint8 _feedDecimals) internal pure returns (uint) {
        if (_feedDecimals < 18) {
            return _price.mul(10 ** uint(18 - _feedDecimals));
        }
        if (_feedDecimals > 18) {
            return _price.div(10 ** uint(_feedDecimals - 18));
        }
        return _price;
    }
}
