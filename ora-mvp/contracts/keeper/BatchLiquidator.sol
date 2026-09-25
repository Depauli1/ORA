// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface ITMLiquidate {
    function liquidate(address _borrower) external;
}

interface ISortedList {
    function getFirst() external view returns (address);
    function getNext(address _id) external view returns (address);
}

interface IERC20Sweep {
    function balanceOf(address _account) external view returns (uint256);
    function transfer(address _to, uint256 _amount) external returns (bool);
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
 * an event so keepers can observe what cleared.
 *
 * Gas compensation (native ETH + orUSD on native branches, branch tokens
 * on ERC20 branches) is minted/sent to this contract by the TroveManager
 * and auto-forwarded to the caller at the end of each sweep — the keeper
 * pays the gas, so the keeper receives the compensation. Anything left
 * behind (e.g. a caller that cannot receive ETH) is recoverable via the
 * permissionless sweep functions.
 *
 * Ordering is best-effort: liquidations mutate the sorted list as the
 * walk proceeds, so a single call may skip a trove that becomes
 * liquidatable mid-sweep. Keepers run repeatedly; nothing is lost.
 */
contract BatchLiquidator {
    event TroveLiquidationAttempted(
        address indexed troveManager, address indexed borrower, bool success
    );

    // Accept native gas compensation from the TroveManager.
    receive() external payable {}

    // Liquidate an explicit list (e.g. from MultiTroveGetter). Skips failures.
    function batchLiquidateTroves(address _tm, address[] calldata _troves, address _orUSD) external {
        for (uint256 i = 0; i < _troves.length; i++) {
            _tryLiquidate(_tm, _troves[i]);
        }
        _forwardCompensation(_orUSD);
    }

    // Walk the list head-first (riskiest first), up to _n attempts.
    // The next pointer is cached before each liquidation because a
    // successful liquidation removes the node from the list.
    function liquidateTroves(address _tm, address _sortedTroves, uint256 _n, address _orUSD) external {
        address current = ISortedList(_sortedTroves).getFirst();
        for (uint256 i = 0; i < _n && current != address(0); i++) {
            address next = ISortedList(_sortedTroves).getNext(current);
            _tryLiquidate(_tm, current);
            current = next;
        }
        _forwardCompensation(_orUSD);
    }

    function _tryLiquidate(address _tm, address _borrower) internal {
        try ITMLiquidate(_tm).liquidate(_borrower) {
            emit TroveLiquidationAttempted(_tm, _borrower, true);
        } catch {
            emit TroveLiquidationAttempted(_tm, _borrower, false);
        }
    }

    // Forward this sweep's compensation to the caller. Best-effort: a
    // caller that cannot receive is left to the sweep functions below
    // rather than reverting the whole sweep.
    function _forwardCompensation(address _orUSD) internal {
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool ok, ) = payable(msg.sender).call{value: ethBal}("");
            if (!ok) { return; }
        }
        if (_orUSD != address(0)) {
            uint256 tokBal = IERC20Sweep(_orUSD).balanceOf(address(this));
            if (tokBal > 0) {
                IERC20Sweep(_orUSD).transfer(msg.sender, tokBal);
            }
        }
    }

    // Escape hatches for anything left behind (branch ERC20 compensation,
    // or pushes a contract caller could not receive). Permissionless by
    // design — callers that care use EOAs and the auto-forward above.
    function sweepETH(address payable _to) external {
        (bool ok, ) = _to.call{value: address(this).balance}("");
        require(ok, "BatchLiquidator: ETH sweep failed");
    }

    function sweepToken(address _token, address _to) external {
        uint256 bal = IERC20Sweep(_token).balanceOf(address(this));
        require(IERC20Sweep(_token).transfer(_to, bal), "BatchLiquidator: token sweep failed");
    }
}
