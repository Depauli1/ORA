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
        // Foundry only lets the test contract itself touch cheatcodes by
        // default; the handler's opWarp needs an explicit grant, otherwise
        // the vm.warp call reverts as "non-contract address" (and, oddly,
        // that revert escapes the handler's try/catch and fails the run).
        vm.allowCheatcodes(address(handler));
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
