// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

/*
 * ORA Phase 1 — replaces the native-ETH receive() hook between pools for
 * ERC20-collateral branches: the sender transfers tokens, then notifies the
 * receiving pool so its internal accounting stays in sync.
 */
interface ICollateralReceiver {
    function receiveCollateral(uint _amount) external;
}
