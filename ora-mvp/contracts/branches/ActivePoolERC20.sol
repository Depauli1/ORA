// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IActivePool.sol";
import "../Dependencies/SafeMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/IERC20.sol";
import "./ICollateralReceiver.sol";

/*
 * ORA Phase 1 — ERC20-collateral ActivePool.
 * Same IActivePool interface as the native-ETH pool (so TroveManager is reused
 * unchanged), but collateral is an ERC20 token (e.g. wstETH). "ETH" naming is
 * kept for interface parity; it denotes units of the branch collateral token.
 */
contract ActivePoolERC20 is Ownable, CheckContract, IActivePool, ICollateralReceiver {
    using SafeMath for uint256;

    string constant public NAME = "ActivePoolERC20";

    address public borrowerOperationsAddress;
    address public troveManagerAddress;
    address public stabilityPoolAddress;
    address public defaultPoolAddress;
    address public collSurplusPoolAddress;
    IERC20 public collToken;

    uint256 internal ETH;  // collateral token balance tracker
    uint256 internal LUSDDebt;

    // --- Contract setters ---

    function setAddresses(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _stabilityPoolAddress,
        address _defaultPoolAddress,
        address _collSurplusPoolAddress,
        address _collTokenAddress
    )
        external
        onlyOwner
    {
        checkContract(_borrowerOperationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_collTokenAddress);

        borrowerOperationsAddress = _borrowerOperationsAddress;
        troveManagerAddress = _troveManagerAddress;
        stabilityPoolAddress = _stabilityPoolAddress;
        defaultPoolAddress = _defaultPoolAddress;
        collSurplusPoolAddress = _collSurplusPoolAddress;
        collToken = IERC20(_collTokenAddress);

        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);

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

    function sendETH(address _account, uint _amount) external override {
        _requireCallerIsBOorTroveMorSP();
        ETH = ETH.sub(_amount);
        emit ActivePoolETHBalanceUpdated(ETH);
        emit EtherSent(_account, _amount);

        require(collToken.transfer(_account, _amount), "ActivePoolERC20: sending collateral failed");

        // Notify pool-type recipients so their internal accounting stays in sync
        // (replaces the native-ETH receive() hook).
        if (
            _account == stabilityPoolAddress ||
            _account == defaultPoolAddress ||
            _account == collSurplusPoolAddress
        ) {
            ICollateralReceiver(_account).receiveCollateral(_amount);
        }
    }

    function increaseLUSDDebt(uint _amount) external override {
        _requireCallerIsBOorTroveM();
        LUSDDebt = LUSDDebt.add(_amount);
        emit ActivePoolLUSDDebtUpdated(LUSDDebt);
    }

    function decreaseLUSDDebt(uint _amount) external override {
        _requireCallerIsBOorTroveMorSP();
        LUSDDebt = LUSDDebt.sub(_amount);
        emit ActivePoolLUSDDebtUpdated(LUSDDebt);
    }

    // Replaces receive(): called after collateral tokens have been transferred in.
    function receiveCollateral(uint _amount) external override {
        _requireCallerIsBorrowerOperationsOrDefaultPool();
        ETH = ETH.add(_amount);
        emit ActivePoolETHBalanceUpdated(ETH);
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOperationsOrDefaultPool() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == defaultPoolAddress,
            "ActivePoolERC20: Caller is neither BO nor Default Pool");
    }

    function _requireCallerIsBOorTroveMorSP() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == troveManagerAddress ||
            msg.sender == stabilityPoolAddress,
            "ActivePoolERC20: Caller is neither BorrowerOperations nor TroveManager nor StabilityPool");
    }

    function _requireCallerIsBOorTroveM() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == troveManagerAddress,
            "ActivePoolERC20: Caller is neither BorrowerOperations nor TroveManager");
    }
}
