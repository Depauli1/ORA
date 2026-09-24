// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/OraMath.sol";
import "../dependencies08/OraOwnable.sol";
import "../dependencies08/OraCheckContract.sol";
import "../dependencies08/ILQTYStaking.sol";
import "../dependencies08/IERC20.sol";

/*
 * ORA Phase 2 — per-branch ORA staking / fee distribution.
 * Port of LQTYStaking for ERC20-collateral branches: stake ORA, earn the
 * branch's collateral-token redemption fees + orUSD borrowing fees. ORA is
 * pulled via transferFrom (LQTYToken.sendToLQTYStaking is bound to the
 * primary staking contract), and collateral gains are paid as ERC20.
 */
contract BranchStaking is ILQTYStaking, OraOwnable, OraCheckContract {
    // --- Data ---
    string constant public NAME = "BranchStaking";

    // ORA Phase 2: branch collateral token (e.g. wstETH)
    IERC20 public collToken;

    mapping( address => uint256) public stakes;
    uint256 public totalLQTYStaked;

    uint256 public F_ETH;  // Running sum of ETH fees per-LQTY-staked
    uint256 public F_LUSD; // Running sum of LQTY fees per-LQTY-staked

    // User snapshots of F_ETH and F_LUSD, taken at the point at which their latest deposit was made
    mapping (address => Snapshot) public snapshots;

    struct Snapshot {
        uint256 F_ETH_Snapshot;
        uint256 F_LUSD_Snapshot;
    }

    IERC20 public lqtyToken;
    IERC20 public lusdToken;

    address public troveManagerAddress;
    address public borrowerOperationsAddress;
    address public activePoolAddress;

    // --- Events (inherited from ILQTYStaking) ---

    // --- Functions ---

    // Must be called before setAddresses (which renounces ownership).
    function setCollToken(address _collTokenAddress) external onlyOwner {
        checkContract(_collTokenAddress);
        collToken = IERC20(_collTokenAddress);
    }

    function setAddresses
    (
        address _lqtyTokenAddress,
        address _lusdTokenAddress,
        address _troveManagerAddress,
        address _borrowerOperationsAddress,
        address _activePoolAddress
    )
        external
        onlyOwner
        override
    {
        checkContract(_lqtyTokenAddress);
        checkContract(_lusdTokenAddress);
        checkContract(_troveManagerAddress);
        checkContract(_borrowerOperationsAddress);
        checkContract(_activePoolAddress);

        lqtyToken = IERC20(_lqtyTokenAddress);
        lusdToken = IERC20(_lusdTokenAddress);
        troveManagerAddress = _troveManagerAddress;
        borrowerOperationsAddress = _borrowerOperationsAddress;
        activePoolAddress = _activePoolAddress;

        emit LQTYTokenAddressSet(_lqtyTokenAddress);
        emit LQTYTokenAddressSet(_lusdTokenAddress);
        emit TroveManagerAddressSet(_troveManagerAddress);
        emit BorrowerOperationsAddressSet(_borrowerOperationsAddress);
        emit ActivePoolAddressSet(_activePoolAddress);

        _renounceOwnership();
    }

    // If caller has a pre-existing stake, send any accumulated ETH and LUSD gains to them.
    function stake(uint256 _LQTYamount) external override {
        _requireNonZeroAmount(_LQTYamount);

        uint256 currentStake = stakes[msg.sender];

        uint256 ETHGain;
        uint256 LUSDGain;
        // Grab any accumulated ETH and LUSD gains from the current stake
        if (currentStake != 0) {
            ETHGain = _getPendingETHGain(msg.sender);
            LUSDGain = _getPendingLUSDGain(msg.sender);
        }

       _updateUserSnapshots(msg.sender);

        uint256 newStake = currentStake + _LQTYamount;

        // Increase user’s stake and total LQTY staked
        stakes[msg.sender] = newStake;
        totalLQTYStaked = totalLQTYStaked + _LQTYamount;
        emit TotalLQTYStakedUpdated(totalLQTYStaked);

        // Transfer LQTY from caller to this contract
        require(lqtyToken.transferFrom(msg.sender, address(this), _LQTYamount), "BranchStaking: ORA transferFrom failed");

        emit StakeChanged(msg.sender, newStake);
        emit StakingGainsWithdrawn(msg.sender, LUSDGain, ETHGain);

         // Send accumulated LUSD and ETH gains to the caller
        if (currentStake != 0) {
            require(lusdToken.transfer(msg.sender, LUSDGain), "BranchStaking: LUSD transfer failed");
            _sendETHGainToUser(ETHGain);
        }
    }

    // Unstake the LQTY and send the it back to the caller, along with their accumulated LUSD & ETH gains.
    // If requested amount > stake, send their entire stake.
    function unstake(uint256 _LQTYamount) external override {
        uint256 currentStake = stakes[msg.sender];
        _requireUserHasStake(currentStake);

        // Grab any accumulated ETH and LUSD gains from the current stake
        uint256 ETHGain = _getPendingETHGain(msg.sender);
        uint256 LUSDGain = _getPendingLUSDGain(msg.sender);

        _updateUserSnapshots(msg.sender);

        if (_LQTYamount > 0) {
            uint256 LQTYToWithdraw = OraMath._min(_LQTYamount, currentStake);

            uint256 newStake = currentStake - LQTYToWithdraw;

            // Decrease user's stake and total LQTY staked
            stakes[msg.sender] = newStake;
            totalLQTYStaked = totalLQTYStaked - LQTYToWithdraw;
            emit TotalLQTYStakedUpdated(totalLQTYStaked);

            // Transfer unstaked LQTY to user
            require(lqtyToken.transfer(msg.sender, LQTYToWithdraw), "BranchStaking: LQTY transfer failed");

            emit StakeChanged(msg.sender, newStake);
        }

        emit StakingGainsWithdrawn(msg.sender, LUSDGain, ETHGain);

        // Send accumulated LUSD and ETH gains to the caller
        require(lusdToken.transfer(msg.sender, LUSDGain), "BranchStaking: LUSD transfer failed");
        _sendETHGainToUser(ETHGain);
    }

    // --- Reward-per-unit-staked increase functions. Called by Liquity core contracts ---

    function increaseF_ETH(uint256 _ETHFee) external override {
        _requireCallerIsTroveManager();
        uint256 ETHFeePerLQTYStaked;

        if (totalLQTYStaked > 0) {ETHFeePerLQTYStaked = _ETHFee * OraMath.DECIMAL_PRECISION / totalLQTYStaked;}

        F_ETH = F_ETH + ETHFeePerLQTYStaked;
        emit F_ETHUpdated(F_ETH);
    }

    function increaseF_LUSD(uint256 _LUSDFee) external override {
        _requireCallerIsBorrowerOperations();
        uint256 LUSDFeePerLQTYStaked;

        if (totalLQTYStaked > 0) {LUSDFeePerLQTYStaked = _LUSDFee * OraMath.DECIMAL_PRECISION / totalLQTYStaked;}

        F_LUSD = F_LUSD + LUSDFeePerLQTYStaked;
        emit F_LUSDUpdated(F_LUSD);
    }

    // --- Pending reward functions ---

    function getPendingETHGain(address _user) external view override returns (uint256) {
        return _getPendingETHGain(_user);
    }

    function _getPendingETHGain(address _user) internal view returns (uint256) {
        uint256 F_ETH_Snapshot = snapshots[_user].F_ETH_Snapshot;
        uint256 ETHGain = stakes[_user] * (F_ETH - F_ETH_Snapshot) / OraMath.DECIMAL_PRECISION;
        return ETHGain;
    }

    function getPendingLUSDGain(address _user) external view returns (uint256) {
        return _getPendingLUSDGain(_user);
    }

    function _getPendingLUSDGain(address _user) internal view returns (uint256) {
        uint256 F_LUSD_Snapshot = snapshots[_user].F_LUSD_Snapshot;
        uint256 LUSDGain = stakes[_user] * (F_LUSD - F_LUSD_Snapshot) / OraMath.DECIMAL_PRECISION;
        return LUSDGain;
    }

    // --- Internal helper functions ---

    function _updateUserSnapshots(address _user) internal {
        snapshots[_user].F_ETH_Snapshot = F_ETH;
        snapshots[_user].F_LUSD_Snapshot = F_LUSD;
        emit StakerSnapshotsUpdated(_user, F_ETH, F_LUSD);
    }

    function _sendETHGainToUser(uint256 ETHGain) internal {
        emit EtherSent(msg.sender, ETHGain);
        if (ETHGain > 0) {
            require(collToken.transfer(msg.sender, ETHGain), "BranchStaking: sending collateral gain failed");
        }
    }

    // --- 'require' functions ---

    function _requireCallerIsTroveManager() internal view {
        require(msg.sender == troveManagerAddress, "LQTYStaking: caller is not TroveM");
    }

    function _requireCallerIsBorrowerOperations() internal view {
        require(msg.sender == borrowerOperationsAddress, "LQTYStaking: caller is not BorrowerOps");
    }

     function _requireCallerIsActivePool() internal view {
        require(msg.sender == activePoolAddress, "LQTYStaking: caller is not ActivePool");
    }

    function _requireUserHasStake(uint256 currentStake) internal pure {
        require(currentStake > 0, 'LQTYStaking: User must have a non-zero stake');
    }

    function _requireNonZeroAmount(uint256 _amount) internal pure {
        require(_amount > 0, 'LQTYStaking: Amount must be non-zero');
    }

}
