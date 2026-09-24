// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IDefaultPool.sol";
import "../Dependencies/SafeMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/IERC20.sol";
import "./ICollateralReceiver.sol";

/*
 * ORA Phase 1 — ERC20-collateral DefaultPool (same IDefaultPool interface).
 */
contract DefaultPoolERC20 is Ownable, CheckContract, IDefaultPool, ICollateralReceiver {
    using SafeMath for uint256;

    string constant public NAME = "DefaultPoolERC20";

    address public troveManagerAddress;
    address public activePoolAddress;
    IERC20 public collToken;

    uint256 internal ETH;  // collateral token balance tracker
    uint256 internal LUSDDebt;

    // --- Dependency setters ---

    function setAddresses(
        address _troveManagerAddress,
        address _activePoolAddress,
        address _collTokenAddress
    )
        external
        onlyOwner
    {
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);
        checkContract(_collTokenAddress);

        troveManagerAddress = _troveManagerAddress;
        activePoolAddress = _activePoolAddress;
        collToken = IERC20(_collTokenAddress);

        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);

        _renounceOwnership();
    }

    // --- Getters ---

    function getETH() external view override returns (uint) {
        return ETH;
    }

    function getLUSDDebt() external view override returns (uint) {
        return LUSDDebt;
    }

    // --- Pool functionality ---

    function sendETHToActivePool(uint _amount) external override {
        _requireCallerIsTroveManager();
        address activePool = activePoolAddress; // cache to save an SLOAD
        ETH = ETH.sub(_amount);
        emit DefaultPoolETHBalanceUpdated(ETH);
        emit EtherSent(activePool, _amount);

        require(collToken.transfer(activePool, _amount), "DefaultPoolERC20: sending collateral failed");
        ICollateralReceiver(activePool).receiveCollateral(_amount);
    }

    function increaseLUSDDebt(uint _amount) external override {
        _requireCallerIsTroveManager();
        LUSDDebt = LUSDDebt.add(_amount);
        emit DefaultPoolLUSDDebtUpdated(LUSDDebt);
    }

    function decreaseLUSDDebt(uint _amount) external override {
        _requireCallerIsTroveManager();
        LUSDDebt = LUSDDebt.sub(_amount);
        emit DefaultPoolLUSDDebtUpdated(LUSDDebt);
    }

    // Replaces receive(): called by ActivePool after transferring tokens in.
    function receiveCollateral(uint _amount) external override {
        _requireCallerIsActivePool();
        ETH = ETH.add(_amount);
        emit DefaultPoolETHBalanceUpdated(ETH);
    }

    // --- 'require' functions ---

    function _requireCallerIsActivePool() internal view {
        require(msg.sender == activePoolAddress, "DefaultPoolERC20: Caller is not the ActivePool");
    }

    function _requireCallerIsTroveManager() internal view {
        require(msg.sender == troveManagerAddress, "DefaultPoolERC20: Caller is not the TroveManager");
    }
}
