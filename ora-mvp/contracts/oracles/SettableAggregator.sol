// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/AggregatorV3Interface.sol";

/*
 * ORA Phase 1.5 — Chainlink-compatible aggregator with public setters,
 * for testnets where a real feed doesn't exist (e.g. stETH/ETH on Base
 * Sepolia) and for demoing the depeg circuit breaker. TESTNET ONLY.
 */
contract SettableAggregator is AggregatorV3Interface {

    uint8 private immutable _decimals;
    string private _description;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;

    constructor(uint8 decimals_, string memory description_, int256 initialAnswer_) public {
        _decimals = decimals_;
        _description = description_;
        _set(initialAnswer_);
    }

    function setAnswer(int256 answer_) external {
        _set(answer_);
    }

    // Age the latest round for staleness testing.
    function makeStale(uint256 age_) external {
        require(age_ <= block.timestamp, "SettableAggregator: age too large");
        _updatedAt = block.timestamp - age_;
    }

    function _set(int256 answer_) internal {
        _roundId++;
        _answer = answer_;
        _updatedAt = block.timestamp;
    }

    function decimals() external view override returns (uint8) { return _decimals; }
    function description() external view override returns (string memory) { return _description; }
    function version() external view override returns (uint256) { return 1; }

    function getRoundData(uint80)
        external view override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function latestRoundData()
        external view override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
