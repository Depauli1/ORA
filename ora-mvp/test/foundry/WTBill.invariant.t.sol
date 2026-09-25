// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../contracts/TestContracts/fuzz/WTBillHandler.sol";

/*
 * Foundry invariant suite for wmTBILL custody + skim accounting.
 * Runs in CI (forge test); the same state machine is executed locally by
 * test/invariant-drivers.test.js (the sandbox has no forge binary).
 */
contract WTBillInvariantTest is StdInvariant, Test {
    WTBillHandler internal handler;

    function setUp() public {
        handler = new WTBillHandler();
        targetContract(address(handler));
    }

    function invariant_custody() public view {
        assertTrue(handler.invCustody(), "custody: backing < owed");
    }

    function invariant_rateBounds() public view {
        assertTrue(handler.invRateBounds(), "rate out of (0, 1]");
    }

    function invariant_supply() public view {
        assertTrue(handler.invSupply(), "supply conservation broke");
    }

    function invariant_skim() public view {
        assertTrue(handler.invSkim(), "skim accounting broke");
    }
}
