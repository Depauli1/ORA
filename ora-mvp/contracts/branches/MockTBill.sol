// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";

/*
 * ORA Phase 4 — mock tokenized T-bill money-market fund share (mTBILL),
 * standing in for assets like OUSG / BUIDL / tokenized MMFs on testnets.
 *
 * Shares are non-rebasing; value accrues in the fund's NAV per share, which
 * the RWA branch reads through RWAPriceFeed. Real RWA tokens carry KYC
 * transfer restrictions — omitted here so anyone can demo the branch (on a
 * production deployment the protocol pool addresses would simply be
 * allowlisted by the issuer).
 */
contract MockTBill {
    using SafeMath for uint256;

    string public constant name = "ORA Tokenized T-Bill Fund (Mock)";
    string public constant symbol = "mTBILL";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint public constant FAUCET_CAP = 100000e18;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function faucet(uint256 _amount) external {
        require(_amount <= FAUCET_CAP, "MockTBill: faucet cap is 100000 per call");
        totalSupply = totalSupply.add(_amount);
        balanceOf[msg.sender] = balanceOf[msg.sender].add(_amount);
        emit Transfer(address(0), msg.sender, _amount);
    }

    function transfer(address _to, uint256 _value) external returns (bool) {
        _transfer(msg.sender, _to, _value);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _value) external returns (bool) {
        allowance[_from][msg.sender] = allowance[_from][msg.sender].sub(_value, "MockTBill: transfer amount exceeds allowance");
        _transfer(_from, _to, _value);
        return true;
    }

    function approve(address _spender, uint256 _value) external returns (bool) {
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    function _transfer(address _from, address _to, uint256 _value) internal {
        require(_to != address(0), "MockTBill: transfer to zero address");
        balanceOf[_from] = balanceOf[_from].sub(_value, "MockTBill: transfer amount exceeds balance");
        balanceOf[_to] = balanceOf[_to].add(_value);
        emit Transfer(_from, _to, _value);
    }
}
