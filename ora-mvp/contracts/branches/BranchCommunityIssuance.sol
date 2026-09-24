// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/IERC20.sol";
import "../Dependencies/LiquityMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/BaseMath.sol";
import "../Dependencies/SafeMath.sol";

/*
 * ORA Phase 2 — per-branch ORA issuance for secondary Stability Pools.
 *
 * Same yearly-halving issuance curve as the main CommunityIssuance, but the
 * supply cap is set at activation from whatever ORA the treasury funds it
 * with (the upstream contract hard-requires exactly 32M, which is bound to
 * the primary ETH-branch pool). Function names keep ICommunityIssuance
 * selectors so StabilityPoolERC20 calls it unmodified.
 */
contract BranchCommunityIssuance is Ownable, CheckContract, BaseMath {
    using SafeMath for uint;

    string constant public NAME = "BranchCommunityIssuance";

    uint constant public SECONDS_IN_ONE_MINUTE = 60;
    uint constant public ISSUANCE_FACTOR = 999998681227695000; // 50% issued after 1 year

    IERC20 public oraToken;
    address public stabilityPoolAddress;

    uint public supplyCap;       // fixed at activation from the funded balance
    uint public totalORAIssued;
    uint public deploymentTime;
    bool public active;

    event TotalORAIssuedUpdated(uint _totalORAIssued);
    event IssuanceActivated(uint _supplyCap);

    function setAddresses(address _oraTokenAddress, address _stabilityPoolAddress) external onlyOwner {
        checkContract(_oraTokenAddress);
        checkContract(_stabilityPoolAddress);
        oraToken = IERC20(_oraTokenAddress);
        stabilityPoolAddress = _stabilityPoolAddress;
    }

    // Fund this contract with ORA first; activation locks the cap and starts the curve.
    function activate() external onlyOwner {
        require(!active, "BranchCommunityIssuance: already active");
        uint balance = oraToken.balanceOf(address(this));
        require(balance > 0, "BranchCommunityIssuance: fund with ORA before activating");
        supplyCap = balance;
        deploymentTime = block.timestamp;
        active = true;
        emit IssuanceActivated(balance);
        _renounceOwnership();
    }

    // Selector-compatible with ICommunityIssuance.issueLQTY (issues ORA).
    function issueLQTY() external returns (uint) {
        _requireCallerIsStabilityPool();
        if (!active) { return 0; }

        uint latestTotalIssued = supplyCap.mul(_getCumulativeIssuanceFraction()).div(DECIMAL_PRECISION);
        uint issuance = latestTotalIssued.sub(totalORAIssued);

        totalORAIssued = latestTotalIssued;
        emit TotalORAIssuedUpdated(latestTotalIssued);
        return issuance;
    }

    // Selector-compatible with ICommunityIssuance.sendLQTY (sends ORA).
    function sendLQTY(address _account, uint _amount) external {
        _requireCallerIsStabilityPool();
        if (_amount > 0) {
            require(oraToken.transfer(_account, _amount), "BranchCommunityIssuance: ORA transfer failed");
        }
    }

    function _getCumulativeIssuanceFraction() internal view returns (uint) {
        uint timePassedInMinutes = block.timestamp.sub(deploymentTime).div(SECONDS_IN_ONE_MINUTE);
        uint power = LiquityMath._decPow(ISSUANCE_FACTOR, timePassedInMinutes);
        uint cumulativeIssuanceFraction = (uint(DECIMAL_PRECISION).sub(power));
        assert(cumulativeIssuanceFraction <= DECIMAL_PRECISION);
        return cumulativeIssuanceFraction;
    }

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "BranchCommunityIssuance: caller is not the StabilityPool");
    }
}
