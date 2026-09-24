// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/ICollSurplusPool.sol";
import "../Dependencies/SafeMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/IERC20.sol";
import "./ICollateralReceiver.sol";

/*
 * ORA Phase 1 — ERC20-collateral CollSurplusPool (same ICollSurplusPool interface).
 */
contract CollSurplusPoolERC20 is Ownable, CheckContract, ICollSurplusPool, ICollateralReceiver {
    using SafeMath for uint256;

    string constant public NAME = "CollSurplusPoolERC20";

    address public borrowerOperationsAddress;
    address public troveManagerAddress;
    address public activePoolAddress;
    IERC20 public collToken;

    // deposited collateral tracker
    uint256 internal ETH;
    // Collateral surplus claimable by trove owners
    mapping (address => uint) internal balances;

    // --- Contract setters ---

    function setAddresses(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _activePoolAddress
    )
        external
        override
        onlyOwner
    {
        checkContract(_borrowerOperationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);

        borrowerOperationsAddress = _borrowerOperationsAddress;
        troveManagerAddress = _troveManagerAddress;
        activePoolAddress = _activePoolAddress;

        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
    }

    // Separate setter so ICollSurplusPool.setAddresses keeps its upstream signature.
    function setCollToken(address _collTokenAddress) external onlyOwner {
        checkContract(_collTokenAddress);
        collToken = IERC20(_collTokenAddress);
        _renounceOwnership();
    }

    // --- Getters ---

    function getETH() external view override returns (uint) {
        return ETH;
    }

    function getCollateral(address _account) external view override returns (uint) {
        return balances[_account];
    }

    // --- Pool functionality ---

    function accountSurplus(address _account, uint _amount) external override {
        _requireCallerIsTroveManager();

        uint newAmount = balances[_account].add(_amount);
        balances[_account] = newAmount;

        emit CollBalanceUpdated(_account, newAmount);
    }

    function claimColl(address _account) external override {
        _requireCallerIsBorrowerOperations();
        uint claimableColl = balances[_account];
        require(claimableColl > 0, "CollSurplusPoolERC20: No collateral available to claim");

        balances[_account] = 0;
        emit CollBalanceUpdated(_account, 0);

        ETH = ETH.sub(claimableColl);
        emit EtherSent(_account, claimableColl);

        require(collToken.transfer(_account, claimableColl), "CollSurplusPoolERC20: sending collateral failed");
    }

    // Replaces receive(): called by ActivePool after transferring tokens in.
    function receiveCollateral(uint _amount) external override {
        _requireCallerIsActivePool();
        ETH = ETH.add(_amount);
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(
            msg.sender == borrowerOperationsAddress,
            "CollSurplusPoolERC20: Caller is not Borrower Operations");
    }

    function _requireCallerIsTroveManager() internal view {
        require(
            msg.sender == troveManagerAddress,
            "CollSurplusPoolERC20: Caller is not TroveManager");
    }

    function _requireCallerIsActivePool() internal view {
        require(
            msg.sender == activePoolAddress,
            "CollSurplusPoolERC20: Caller is not Active Pool");
    }
}
