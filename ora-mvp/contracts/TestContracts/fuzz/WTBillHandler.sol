// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../../rwa/WTBill.sol";
import "../../branches/MockTBill.sol";

/*
 * Stateful fuzz handler for wmTBILL (dual-driver: Foundry invariant runs in
 * CI via test/foundry/WTBill.invariant.t.sol, and the Hardhat driver in
 * test/invariant-drivers.test.js executes the same state machine locally).
 *
 * Single actor (this contract) + one passive sink. Every op ends in
 * _checkpoint(), which REVERTS on any invariant breach — handlers never
 * revert otherwise (all inputs are clamped, empty ops are skipped), so
 * with fail_on_revert=true a breach fails the run instead of being
 * silently discarded.
 *
 * Time: warp() uses the Foundry cheatcode address directly (no forge-std
 * import, keeping this compilable by Hardhat). On Hardhat's EVM the call
 * hits an empty account and is a no-op; the JS driver mirrors block time
 * from ghost_warped after each call.
 */
interface ICheatCodes {
    function warp(uint256) external;
}

contract WTBillHandler {
    ICheatCodes constant vm = ICheatCodes(0x7109709ecfa91A80626Ff3989d68F67f682E52aF);

    WTBill public wtbill;
    MockTBill public underlying;
    address public constant SINK = 0x0000000000000000000000000000000000000beE;
    address public constant FEE_RECEIVER = 0x0000000000000000000000000000000000000FEE;

    uint256 public ghost_claimed; // cumulative skim paid to the fee receiver
    uint256 public ghost_warped;  // cumulative seconds warped (bounds the run)

    uint256 constant MAX_OP = 100000e18; // MockTBill per-call faucet cap
    uint256 constant MAX_WARP = 30 days; // depth 24 x 30d << 50yr rate-zero horizon
    uint256 constant ONE = 1e18;

    constructor() {
        underlying = new MockTBill();
        wtbill = new WTBill(address(underlying), FEE_RECEIVER);
        underlying.approve(address(wtbill), type(uint256).max);
    }

    // --- ops (clamped, never revert except on invariant breach) ---

    function opWrap(uint256 _amt) external {
        uint256 amt = 1 + (_amt % MAX_OP);
        underlying.faucet(amt);
        wtbill.wrap(amt);
        _checkpoint();
    }

    function opUnwrap(uint256 _pct) external {
        uint256 bal = wtbill.balanceOf(address(this));
        if (bal == 0) return;
        uint256 shares = bal * (_pct % 101) / 100;
        if (shares == 0) return;
        wtbill.unwrap(shares);
        _checkpoint();
    }

    function opFaucet(uint256 _shares) external {
        uint256 shares = 1 + (_shares % MAX_OP);
        wtbill.faucet(shares);
        _checkpoint();
    }

    function opWarp(uint256 _dt) external {
        uint256 dt = _dt % (MAX_WARP + 1);
        ghost_warped += dt;
        // forge: warps; Hardhat EDR: empty account reverts, caught, and the
        // JS driver mirrors time via evm_increaseTime instead.
        try vm.warp(block.timestamp + dt) {} catch {}
        _checkpoint();
    }

    function opSettle() external {
        wtbill.settle();
        _checkpoint();
    }

    function opClaim() external {
        if (wtbill.skimAccrued() == 0) return;
        uint256 beforeBal = underlying.balanceOf(FEE_RECEIVER);
        wtbill.claimSkim();
        ghost_claimed += underlying.balanceOf(FEE_RECEIVER) - beforeBal;
        _checkpoint();
    }

    function opTransfer(uint256 _pct) external {
        uint256 bal = wtbill.balanceOf(address(this));
        if (bal == 0) return;
        uint256 amt = bal * (_pct % 101) / 100;
        if (amt == 0) return;
        wtbill.transfer(SINK, amt);
        _checkpoint();
    }

    // --- invariant views (also asserted by the drivers after every op) ---

    function invCustody() external view returns (bool) {
        uint256 backing = underlying.balanceOf(address(wtbill));
        uint256 owed = wtbill.totalSupply() * wtbill.currentRate() / ONE + wtbill.skimAccrued();
        return backing >= owed;
    }

    function invRateBounds() external view returns (bool) {
        return wtbill.rate() <= ONE && wtbill.currentRate() <= wtbill.rate()
            && wtbill.rate() > 0 && wtbill.currentRate() > 0;
    }

    function invSupply() external view returns (bool) {
        return wtbill.balanceOf(address(this)) + wtbill.balanceOf(SINK) == wtbill.totalSupply();
    }

    function invSkim() external view returns (bool) {
        return underlying.balanceOf(FEE_RECEIVER) == ghost_claimed;
    }

    function _checkpoint() internal view {
        require(this.invCustody(), "WTBillHandler: custody breach");
        require(this.invRateBounds(), "WTBillHandler: rate bounds breach");
        require(this.invSupply(), "WTBillHandler: supply breach");
        require(this.invSkim(), "WTBillHandler: skim breach");
    }
}
