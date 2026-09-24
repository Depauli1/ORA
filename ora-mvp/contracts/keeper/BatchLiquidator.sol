// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface ITMLiquidate {
    function liquidate(address _borrower) external;
}

interface ISortedList {
    function getFirst() external view returns (address);
    function getNext(address _id) external view returns (address);
}

/*
 * ORA keeper helper — batch liquidations, externalized from the
 * size-capped TroveManager forks (V2/RWA/Rates implement single-trove
 * liquidation only, to stay under the 24KB contract-size limit; their
 * liquidateTroves/batchLiquidateTroves entry points are revert-stubs
 * pointing here). Works on ANY branch, including the base ETH branch.
 *
 * Permissionless: anyone may call. Each candidate is attempted
 * individually; failures are SKIPPED (mirroring the in-protocol batch
 * semantics that skip non-liquidatable troves), and every attempt emits
 * an event so keepers can observe what cleared. No funds ever flow
 * through this contract — gas compensation goes straight to the caller.
 *
 * Ordering is best-effort: liquidations mutate the sorted list as the
 * walk proceeds, so a single call may skip a trove that becomes
 * liquidatable mid-sweep. Keepers run repeatedly; nothing is lost.
 */
contract BatchLiquidator {
    event TroveLiquidationAttempted(
        address indexed troveManager, address indexed borrower, bool success
    );

    // Liquidate an explicit list (e.g. from MultiTroveGetter). Skips failures.
    function batchLiquidateTroves(address _tm, address[] calldata _troves) external {
        for (uint256 i = 0; i < _troves.length; i++) {
            _tryLiquidate(_tm, _troves[i]);
        }
    }

    // Walk the list head-first (riskiest first), up to _n attempts.
    // The next pointer is cached before each liquidation because a
    // successful liquidation removes the node from the list.
    function liquidateTroves(address _tm, address _sortedTroves, uint256 _n) external {
        address current = ISortedList(_sortedTroves).getFirst();
        for (uint256 i = 0; i < _n && current != address(0); i++) {
            address next = ISortedList(_sortedTroves).getNext(current);
            _tryLiquidate(_tm, current);
            current = next;
        }
    }

    function _tryLiquidate(address _tm, address _borrower) internal {
        try ITMLiquidate(_tm).liquidate(_borrower) {
            emit TroveLiquidationAttempted(_tm, _borrower, true);
        } catch {
            emit TroveLiquidationAttempted(_tm, _borrower, false);
        }
    }
}
