// SPDX-License-Identifier: MIT

// Floating pragma: this interface is imported by BOTH the 0.6.11
// BorrowerOperations contracts and the 0.8.24 OraGuardian. It uses only
// syntax valid under both compilers — keep it that way.
pragma solidity >=0.6.11 <0.9.0;

interface IOraGuardian {
    function guardian() external view returns (address);
    function borrowingPauseExpiry(address _borrowerOperations) external view returns (uint256);
    function isBorrowingPaused(address _borrowerOperations) external view returns (bool);
}
