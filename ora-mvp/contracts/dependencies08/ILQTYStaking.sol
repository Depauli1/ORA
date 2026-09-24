// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

// 0.8.24 twin of Interfaces/ILQTYStaking.sol (identical selectors/events).
// Inherited by BranchStaking so the 0.6.11 core (TroveManager /
// BorrowerOperations) keeps calling it through the same interface.
interface ILQTYStaking {
    event LQTYTokenAddressSet(address _lqtyTokenAddress);
    event LUSDTokenAddressSet(address _lusdTokenAddress);
    event TroveManagerAddressSet(address _troveManager);
    event BorrowerOperationsAddressSet(address _borrowerOperationsAddress);
    event ActivePoolAddressSet(address _activePoolAddress);

    event StakeChanged(address indexed staker, uint256 newStake);
    event StakingGainsWithdrawn(address indexed staker, uint256 LUSDGain, uint256 ETHGain);
    event F_ETHUpdated(uint256 _F_ETH);
    event F_LUSDUpdated(uint256 _F_LUSD);
    event TotalLQTYStakedUpdated(uint256 _totalLQTYStaked);
    event EtherSent(address _account, uint256 _amount);
    event StakerSnapshotsUpdated(address _staker, uint256 _F_ETH, uint256 _F_LUSD);

    function setAddresses(
        address _lqtyTokenAddress,
        address _lusdTokenAddress,
        address _troveManagerAddress,
        address _borrowerOperationsAddress,
        address _activePoolAddress
    ) external;

    function stake(uint256 _LQTYamount) external;
    function unstake(uint256 _LQTYamount) external;
    function increaseF_ETH(uint256 _ETHFee) external;
    function increaseF_LUSD(uint256 _LQTYFee) external;
    function getPendingETHGain(address _user) external view returns (uint256);
    function getPendingLUSDGain(address _user) external view returns (uint256);
}
