// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/IERC20.sol";

/*
 * ORA Phase 1 — per-branch fee receiver.
 *
 * Non-native collateral branches route their fees here instead of into the
 * main ORA staking contract (which pays gains in native ETH):
 *   - redemption fees arrive as branch collateral tokens (via ActivePool.sendETH)
 *   - borrowing fees arrive as freshly minted orUSD
 * TroveManager/BorrowerOperations call increaseF_ETH / increaseF_LUSD through
 * the ILQTYStaking interface; this contract matches those selectors and simply
 * accrues the amounts. Collected fees are sweepable to the ORA treasury until
 * per-branch fee distribution ships in Phase 2.
 */
contract BranchFeeReceiver is Ownable, CheckContract {
    using SafeMath for uint256;

    string constant public NAME = "BranchFeeReceiver";

    address public troveManagerAddress;
    address public borrowerOperationsAddress;

    uint public F_ETH;   // cumulative branch-collateral fees received
    uint public F_LUSD;  // cumulative orUSD fees received

    event F_ETHUpdated(uint _F_ETH);
    event F_LUSDUpdated(uint _F_LUSD);
    event FeesSwept(address _token, address _to, uint _amount);

    function setAddresses(address _troveManagerAddress, address _borrowerOperationsAddress) external onlyOwner {
        checkContract(_troveManagerAddress);
        checkContract(_borrowerOperationsAddress);
        troveManagerAddress = _troveManagerAddress;
        borrowerOperationsAddress = _borrowerOperationsAddress;
        // Ownership retained: owner may sweep accrued fees to the treasury.
    }

    // Matches ILQTYStaking.increaseF_ETH — called by TroveManager on redemptions.
    function increaseF_ETH(uint _ETHFee) external {
        _requireCallerIsTroveManagerOrBO();
        F_ETH = F_ETH.add(_ETHFee);
        emit F_ETHUpdated(F_ETH);
    }

    // Matches ILQTYStaking.increaseF_LUSD — called by TroveManager/BorrowerOperations.
    function increaseF_LUSD(uint _LUSDFee) external {
        _requireCallerIsTroveManagerOrBO();
        F_LUSD = F_LUSD.add(_LUSDFee);
        emit F_LUSDUpdated(F_LUSD);
    }

    function sweep(address _token, address _to) external onlyOwner {
        uint bal = IERC20(_token).balanceOf(address(this));
        require(IERC20(_token).transfer(_to, bal), "BranchFeeReceiver: sweep failed");
        emit FeesSwept(_token, _to, bal);
    }

    function _requireCallerIsTroveManagerOrBO() internal view {
        require(
            msg.sender == troveManagerAddress || msg.sender == borrowerOperationsAddress,
            "BranchFeeReceiver: caller is not TroveManager or BorrowerOperations");
    }
}
