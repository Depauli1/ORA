// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface IBatchSweep {
    function liquidateTroves(address _tm, address _sorted, uint256 _n, address _orUSD) external;
}

/* Test-only (excluded from the coverage gate): a BatchLiquidator caller that
 * cannot receive ETH — exercises the best-effort compensation forward. */
contract NonPayableCaller {
    function sweep(address _bl, address _tm, address _sorted, uint256 _n, address _orUSD) external {
        IBatchSweep(_bl).liquidateTroves(_tm, _sorted, _n, _orUSD);
    }
}
