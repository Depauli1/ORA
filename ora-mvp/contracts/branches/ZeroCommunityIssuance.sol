// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

/*
 * ORA Phase 1 — zero-emission community issuance for secondary branches.
 *
 * The 32M ORA community issuance schedule is bound to the primary (ETH) branch
 * Stability Pool. Secondary branch Stability Pools point here: identical
 * ICommunityIssuance selectors, zero ORA issued. Branch-specific ORA incentives
 * arrive with Phase 2 tokenomics.
 */
contract ZeroCommunityIssuance {

    string constant public NAME = "ZeroCommunityIssuance";

    function issueLQTY() external returns (uint) {
        return 0;
    }

    function sendLQTY(address _account, uint _LQTYamount) external {
        // no-op: nothing is ever issued
    }
}
