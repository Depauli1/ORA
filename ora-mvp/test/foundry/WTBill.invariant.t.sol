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
        // default; the handler's opWarp needs an explicit grant (and the
        // handler's own warpsEnabled flag — Hardhat's EVM, which runs the
        // same handler in test/invariant-drivers.test.js, has no cheatcode
        // dispatcher, so the flag keeps the JS driver off the VM address).
        vm.allowCheatcodes(address(handler));
        handler.enableWarps();
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
