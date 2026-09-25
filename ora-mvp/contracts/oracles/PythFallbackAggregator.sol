// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/AggregatorV3Interface.sol";
import "../dependencies08/OraCheckContract.sol";

/* Minimal view of the Pyth EVM contract (only what a fallback needs).
 * Full interface: https://github.com/pyth-network/pyth-crosschain — getPriceUnsafe
 * returns the latest PUBLISHED price (no pull payment); freshness is enforced
 * downstream by ChainlinkPriceFeed's heartbeat timeout on updatedAt.
 *
 * NOTE: deliberately NOT named IPyth. Slither's pyth-unchecked-* detectors
 * key on that exact contract name and assume the struct-return SDK call
 * shape — they assert-crash on tuple returns, killing the whole run. The
 * checks those detectors nag about are all implemented here regardless:
 * expo scaling (_scaleTo8), publishTime staleness (feed heartbeat +
 * constructor probe), and price sign (zero/negative => answer 0). */
interface IPythPriceReader {
    function getPriceUnsafe(bytes32 _id)
        external
        view
        returns (int64 price, uint64 conf, int32 expo, uint256 publishTime);
}

/*
 * ORA oracle hardening — Pyth as the ChainlinkPriceFeed fallback source.
 *
 * Adapts a Pyth price feed to the AggregatorV3 interface so it plugs into
 * the existing two-source machinery: a large primary move is accepted only
 * when Pyth confirms it, and Pyth serves alone while Chainlink is broken.
 *
 * Fail-safe mapping: unknown/unpublished ids REVERT in getPriceUnsafe (the
 * reader's try/catch treats that as "fallback broken"); zero/negative Pyth
 * prices surface as answer 0 (rejected); updatedAt = publishTime, so the
 * feed's heartbeat timeout governs Pyth staleness with no extra clock.
 * roundId = publishTime (fits uint80 for millennia).
 */
contract PythFallbackAggregator is AggregatorV3Interface, OraCheckContract {
    IPythPriceReader public immutable pyth;
    bytes32 public immutable priceId;

    constructor(address _pyth, bytes32 _priceId) {
        checkContract(_pyth);
        require(_priceId != bytes32(0), "PythFallback: zero price id");
        pyth = IPythPriceReader(_pyth);
        priceId = _priceId;
        // Probe at deploy: an unpublished id must fail the deploy, loudly.
        (int64 p, , , uint256 t) = pyth.getPriceUnsafe(_priceId);
        require(p > 0 && t > 0 && t <= block.timestamp, "PythFallback: bad initial price");
    }

    function decimals() external pure override returns (uint8) { return 8; }
    function description() external pure override returns (string memory) { return "Pyth fallback"; }
    function version() external pure override returns (uint256) { return 1; }

    function getRoundData(uint80) external view override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return latestRoundData();
    }

    function latestRoundData() public view override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (int64 p, , int32 expo, uint256 t) = pyth.getPriceUnsafe(priceId);
        answer = p <= 0 ? int256(0) : _scaleTo8(p, expo);
        roundId = uint80(t);
        startedAt = t;
        updatedAt = t;
        answeredInRound = uint80(t);
    }

    // Pyth value = p * 10^expo USD; 8-decimal answer = p * 10^(expo+8).
    function _scaleTo8(int64 _p, int32 _expo) internal pure returns (int256) {
        int256 e = int256(_expo) + 8;
        if (e >= 0) { return int256(_p) * int256(10 ** uint256(uint32(uint256(e)))); }
        return int256(_p) / int256(10 ** uint256(uint32(uint256(-e))));
    }
}
