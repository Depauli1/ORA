// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

/*
 * Test-only ERC20 with on-demand transfer failures (scaffold — excluded from
 * the coverage gate). The Tier-3 contracts wrap every external transfer in a
 * checked `require(token.transfer(...))`; those revert branches are unreachable
 * with the production tokens (which revert internally instead of returning
 * false), so they are exercised through this controllable stand-in.
 */
contract MockFlakyToken {
    string public constant name = "Flaky Token";
    string public constant symbol = "FLAKY";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Failure switches: failTransferFrom kills every transferFrom;
    // failTransferTo kills transfers to one specific recipient (so a multi-
    // transfer flow can fail at a chosen step).
    bool public failTransferFrom;
    mapping(address => bool) public failTransferTo;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function faucet(uint256 _amount) external {
        totalSupply = totalSupply + _amount;
        balanceOf[msg.sender] = balanceOf[msg.sender] + _amount;
        emit Transfer(address(0), msg.sender, _amount);
    }

    function setFailTransferFrom(bool _fail) external { failTransferFrom = _fail; }
    function setFailTransferTo(address _to, bool _fail) external { failTransferTo[_to] = _fail; }

    function transfer(address _to, uint256 _value) external returns (bool) {
        if (failTransferTo[_to]) { return false; }
        _transfer(msg.sender, _to, _value);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _value) external returns (bool) {
        if (failTransferFrom) { return false; }
        allowance[_from][msg.sender] = allowance[_from][msg.sender] - _value;
        _transfer(_from, _to, _value);
        return true;
    }

    function approve(address _spender, uint256 _value) external returns (bool) {
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    function _transfer(address _from, address _to, uint256 _value) internal {
        require(_to != address(0), "MockFlakyToken: transfer to zero address");
        balanceOf[_from] = balanceOf[_from] - _value;
        balanceOf[_to] = balanceOf[_to] + _value;
        emit Transfer(_from, _to, _value);
    }
}
