// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

/*
 * Test-only helper that refuses ETH (scaffold — excluded from the coverage
 * gate). Used to exercise the failed-ETH-send branches: OraSwapPool paying a
 * swapper that cannot receive, and LeverZap sweeping its exit proceeds to an
 * owner that cannot receive. Also carries a small driver surface so contracts
 * owned by it (LeverZap) can still be driven through their onlyOwner paths.
 */
interface IRejectorPool {
    function swapOrUSDForETH(uint256 _orUSDIn, uint256 _minETHOut) external returns (uint256);
}

interface IRejectorERC20 {
    function approve(address _spender, uint256 _value) external returns (bool);
}

interface IRejectorZap {
    function leverOpen(uint256 _annualRate, uint256 _ltvBps, uint256 _loops, uint256 _maxSlippageBps) external payable;
    function leverClose(uint256 _maxSlippageBps) external;
}

contract EthRejector {
    // Selective: the rejector must be able to RECEIVE ETH (to fund the calls
    // it drives) — the flag flips it into reject mode for the final sweep.
    bool public rejectEth;

    function setRejectEth(bool _reject) external { rejectEth = _reject; }

    receive() external payable {
        require(!rejectEth, "EthRejector: no ETH accepted");
    }

    /// Always-failing call target (for exec() failure branches).
    function boom() external pure {
        revert("EthRejector: boom");
    }

    /// Swap orUSD for ETH through the pool, rejecting the ETH output.
    function swapForETH(address _pool, uint256 _orUSDIn) external {
        IRejectorPool(_pool).swapOrUSDForETH(_orUSDIn, 0);
    }

    function approve(address _token, address _spender) external {
        IRejectorERC20(_token).approve(_spender, type(uint256).max);
    }

    /// Drive a LeverZap owned by this contract (open side).
    function openLevered(address _zap, uint256 _rate, uint256 _ltvBps, uint256 _loops, uint256 _slip)
        external payable
    {
        IRejectorZap(_zap).leverOpen{value: msg.value}(_rate, _ltvBps, _loops, _slip);
    }

    /// Drive a LeverZap owned by this contract (close side).
    function closeLevered(address _zap, uint256 _slip) external {
        IRejectorZap(_zap).leverClose(_slip);
    }
}
