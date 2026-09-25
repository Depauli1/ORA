// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../contracts/TestContracts/fuzz/VaultHandler.sol";

/*
 * Foundry invariant suite for the sorUSD share price + backing.
 * Runs in CI (forge test); the same state machine is executed locally by
 * test/invariant-drivers.test.js (the sandbox has no forge binary).
 */
contract SorUSDVaultInvariantTest is StdInvariant, Test {
    VaultHandler internal handler;

    function setUp() public {
        handler = new VaultHandler();
        targetContract(address(handler));
    }

    function invariant_priceFloor() public view {
        assertTrue(handler.invPriceFloor(), "share price below 1.0");
    }

    function invariant_supply() public view {
        assertTrue(handler.invSupply(), "supply conservation broke");
    }

    function invariant_backing() public view {
        assertTrue(handler.invBacking(), "phantom share value");
    }

    function invariant_deadShares() public view {
        assertTrue(handler.invDeadShares(), "dead shares moved");
    }

    // Per-op monotonicity is enforced inside the handler checkpoint (a
    // decrease reverts the op); with fail_on_revert=true that fails the run.
}
