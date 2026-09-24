// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../Interfaces/IOraGuardian.sol";

/*
 * ORA emergency brake — per-branch borrowing pause with auto-expiry.
 *
 * The guardian (a Safe multisig on production) can halt NEW BORROWING on any
 * branch while an incident is investigated: new troves, orUSD withdrawals and
 * debt-increasing adjustments revert while a pause is active. Everything else
 * keeps working — repayments, collateral top-ups, trove closes, Stability
 * Pool deposits/withdrawals, liquidations and redemptions are NEVER paused,
 * so users can always de-risk and the protocol can always heal.
 *
 * Deliberately minimal power: the guardian CANNOT mint, move funds, upgrade
 * contracts, change parameters, or pause exits. Every pause auto-expires
 * (max 30 days), so a lost or malicious guardian key can only delay new
 * borrowing — it can never freeze the protocol or strand user funds.
 *
 * A zero-address guardian wiring in BorrowerOperations (testnets) disables
 * pausing entirely; production deploys must wire a real multisig.
 */
contract OraGuardian is IOraGuardian {
    address public override guardian;
    uint256 public constant MAX_PAUSE_DURATION = 30 days;

    // borrowerOperations => unix timestamp at which its pause lapses (0 = none)
    mapping(address => uint256) public override borrowingPauseExpiry;

    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);
    event BorrowingPaused(address indexed borrowerOps, uint256 expiry);
    event BorrowingUnpaused(address indexed borrowerOps);

    constructor(address _guardian) {
        require(_guardian != address(0), "OraGuardian: guardian is zero address");
        guardian = _guardian;
    }

    modifier onlyGuardian() {
        require(msg.sender == guardian, "OraGuardian: caller is not guardian");
        _;
    }

    function setGuardian(address _newGuardian) external onlyGuardian {
        require(_newGuardian != address(0), "OraGuardian: guardian is zero address");
        emit GuardianUpdated(guardian, _newGuardian);
        guardian = _newGuardian;
    }

    function pauseBorrowing(address _borrowerOps, uint256 _duration) external onlyGuardian {
        require(_borrowerOps != address(0), "OraGuardian: borrowerOps is zero address");
        require(_duration > 0 && _duration <= MAX_PAUSE_DURATION, "OraGuardian: bad duration");
        uint256 expiry = block.timestamp + _duration;
        borrowingPauseExpiry[_borrowerOps] = expiry;
        emit BorrowingPaused(_borrowerOps, expiry);
    }

    function unpauseBorrowing(address _borrowerOps) external onlyGuardian {
        borrowingPauseExpiry[_borrowerOps] = 0;
        emit BorrowingUnpaused(_borrowerOps);
    }

    function isBorrowingPaused(address _borrowerOps) external view override returns (bool) {
        return block.timestamp < borrowingPauseExpiry[_borrowerOps];
    }
}
