// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

/* Test-only Pyth stand-in (excluded from the coverage gate). Mimics the real
 * contract's revert-on-unknown-id behavior for getPriceUnsafe. */
contract MockPyth {
    struct P { int64 price; uint64 conf; int32 expo; uint256 publishTime; bool exists; }
    mapping(bytes32 => P) public prices;

    function setPrice(bytes32 _id, int64 _price, uint64 _conf, int32 _expo, uint256 _publishTime) external {
        prices[_id] = P(_price, _conf, _expo, _publishTime, true);
    }

    function getPriceUnsafe(bytes32 _id)
        external
        view
        returns (int64 price, uint64 conf, int32 expo, uint256 publishTime)
    {
        P memory p = prices[_id];
        require(p.exists, "MockPyth: unknown price id");
        return (p.price, p.conf, p.expo, p.publishTime);
    }
}
