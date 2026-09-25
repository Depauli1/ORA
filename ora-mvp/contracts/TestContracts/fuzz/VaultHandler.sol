// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../../rates/SorUSDVault.sol";
import "../../branches/MockTBill.sol";

/*
 * Stateful fuzz handler for the sorUSD vault (dual-driver: Foundry in CI,
 * Hardhat locally — see WTBillHandler for the pattern). The vault accepts
 * any ERC20 asset, so the mock T-bill token stands in for orUSD; yield is
 * simulated by donating assets straight to the vault, exactly as the
 * InterestRouter does.
 */
contract VaultHandler {
    SorUSDVault public vault;
    MockTBill public asset;
    address public constant SINK = 0x0000000000000000000000000000000000000beE;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 public ghost_lastPrice = 1e18; // share price never decreases

    uint256 constant MAX_OP = 100000e18;
    uint256 constant ONE = 1e18;

    constructor() {
        asset = new MockTBill();
        vault = new SorUSDVault(address(asset));
        asset.approve(address(vault), type(uint256).max);
    }

    // --- ops (clamped, never revert except on invariant breach) ---

    function opDeposit(uint256 _amt) external {
        // first deposit must clear the 1000-wei dead-share floor
        uint256 amt = vault.totalSupply() == 0
            ? 1001 + (_amt % (MAX_OP - 1001))
            : 1 + (_amt % MAX_OP);
        // after a large yield donation a dust deposit computes to zero
        // shares and the vault correctly rejects it — skip, don't breach
        if (vault.convertToShares(amt) == 0) return;
        asset.faucet(amt);
        vault.deposit(amt);
        _checkpoint();
    }

    function opRedeem(uint256 _pct) external {
        uint256 bal = vault.balanceOf(address(this));
        if (bal == 0) return;
        uint256 shares = bal * (_pct % 101) / 100;
        if (shares == 0) return;
        vault.redeem(shares);
        _checkpoint();
    }

    function opYield(uint256 _amt) external {
        uint256 amt = 1 + (_amt % MAX_OP);
        asset.faucet(amt);
        require(asset.transfer(address(vault), amt), "VaultHandler: yield transfer failed");
        _checkpoint();
    }

    function opTransfer(uint256 _pct) external {
        uint256 bal = vault.balanceOf(address(this));
        if (bal == 0) return;
        uint256 amt = bal * (_pct % 101) / 100;
        if (amt == 0) return;
        vault.transfer(SINK, amt);
        _checkpoint();
    }

    // --- invariant views ---

    function invPriceFloor() external view returns (bool) {
        return vault.totalSupply() == 0 || vault.sharePrice() >= ONE;
    }

    function invSupply() external view returns (bool) {
        return vault.balanceOf(address(this)) + vault.balanceOf(SINK) + vault.balanceOf(DEAD)
            == vault.totalSupply();
    }

    function invBacking() external view returns (bool) {
        if (vault.totalSupply() == 0) return true;
        // no phantom value: redeeming every share pays at most totalAssets
        return vault.convertToAssets(vault.totalSupply()) <= vault.totalAssets();
    }

    function invDeadShares() external view returns (bool) {
        if (vault.totalSupply() == 0) return true;
        return vault.balanceOf(DEAD) == 1000;
    }

    function _checkpoint() internal {
        require(this.invPriceFloor(), "VaultHandler: price floor breach");
        require(vault.sharePrice() >= ghost_lastPrice, "VaultHandler: share price decreased");
        ghost_lastPrice = vault.sharePrice();
        require(this.invSupply(), "VaultHandler: supply breach");
        require(this.invBacking(), "VaultHandler: backing breach");
        require(this.invDeadShares(), "VaultHandler: dead shares breach");
    }
}
