// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/IERC20.sol";
import "../dependencies08/OraMath.sol";
import "../dependencies08/OraOwnable.sol";
import "../dependencies08/OraCheckContract.sol";

/*
 * ORA Phase 2 — per-branch ORA issuance for secondary Stability Pools.
 *
 * Same yearly-halving issuance curve as the main CommunityIssuance, but the
 * supply cap is set at activation from whatever ORA the treasury funds it
 * with (the upstream contract hard-requires exactly 32M, which is bound to
 * the primary ETH-branch pool). Function names keep ICommunityIssuance
 * selectors so StabilityPoolERC20 calls it unmodified.
 */
contract BranchCommunityIssuance is OraOwnable, OraCheckContract {
    string constant public NAME = "BranchCommunityIssuance";

    uint256 constant public SECONDS_IN_ONE_MINUTE = 60;
    uint256 constant public ISSUANCE_FACTOR = 999998681227695000; // 50% issued after 1 year

    IERC20 public oraToken;
    address public stabilityPoolAddress;

    uint256 public supplyCap;       // fixed at activation from the funded balance
    uint256 public totalORAIssued;
    uint256 public deploymentTime;
    bool public active;

    event TotalORAIssuedUpdated(uint256 _totalORAIssued);
    event IssuanceActivated(uint256 _supplyCap);

    function setAddresses(address _oraTokenAddress, address _stabilityPoolAddress) external onlyOwner {
        checkContract(_oraTokenAddress);
        checkContract(_stabilityPoolAddress);
        oraToken = IERC20(_oraTokenAddress);
        stabilityPoolAddress = _stabilityPoolAddress;
    }

    // Fund this contract with ORA first; activation locks the cap and starts
    // the curve. No `active` re-check is needed: the only successful path
    // renounces ownership below, so onlyOwner already rejects every re-entry.
    function activate() external onlyOwner {
        uint256 balance = oraToken.balanceOf(address(this));
        require(balance > 0, "BranchCommunityIssuance: fund with ORA before activating");
        supplyCap = balance;
        deploymentTime = block.timestamp;
        active = true;
        emit IssuanceActivated(balance);
        _renounceOwnership();
    }

    // Selector-compatible with ICommunityIssuance.issueLQTY (issues ORA).
    function issueLQTY() external returns (uint256) {
        _requireCallerIsStabilityPool();
        if (!active) { return 0; }

        uint256 latestTotalIssued = supplyCap * _getCumulativeIssuanceFraction() / OraMath.DECIMAL_PRECISION;
        uint256 issuance = latestTotalIssued - totalORAIssued;

        totalORAIssued = latestTotalIssued;
        emit TotalORAIssuedUpdated(latestTotalIssued);
        return issuance;
    }

    // Selector-compatible with ICommunityIssuance.sendLQTY (sends ORA).
    function sendLQTY(address _account, uint256 _amount) external {
        _requireCallerIsStabilityPool();
        if (_amount > 0) {
            require(oraToken.transfer(_account, _amount), "BranchCommunityIssuance: ORA transfer failed");
        }
    }

    function _getCumulativeIssuanceFraction() internal view returns (uint256) {
        uint256 timePassedInMinutes = (block.timestamp - deploymentTime) / SECONDS_IN_ONE_MINUTE;
        uint256 power = OraMath._decPow(ISSUANCE_FACTOR, timePassedInMinutes);
        uint256 cumulativeIssuanceFraction = OraMath.DECIMAL_PRECISION - power;
        assert(cumulativeIssuanceFraction <= OraMath.DECIMAL_PRECISION);
        return cumulativeIssuanceFraction;
    }

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "BranchCommunityIssuance: caller is not the StabilityPool");
    }
}
