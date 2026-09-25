// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/OraMath.sol";

/* Test-only (excluded from the coverage gate): exposes OraMath's internal
 * functions so every branch (incl. the _decPow overflow cap) is directly
 * unit-testable. */
contract OraMathHarness {
    function min(uint256 _a, uint256 _b) external pure returns (uint256) { return OraMath._min(_a, _b); }
    function decMul(uint256 _x, uint256 _y) external pure returns (uint256) { return OraMath.decMul(_x, _y); }
    function decPow(uint256 _base, uint256 _minutes) external pure returns (uint256) {
        return OraMath._decPow(_base, _minutes);
    }
}
