// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

// Minimal ERC20 interface for ORA's 0.8.24 contracts. Selectors match the
// 0.6.11 Dependencies/IERC20.sol used by the core — the two ABIs are
// identical on the wire; this copy exists only because 0.8 sources cannot
// import 0.6-pragma files.
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address _owner) external view returns (uint256);
    function transfer(address _to, uint256 _value) external returns (bool);
    function transferFrom(address _from, address _to, uint256 _value) external returns (bool);
    function approve(address _spender, uint256 _value) external returns (bool);
    function allowance(address _owner, address _spender) external view returns (uint256);
}
