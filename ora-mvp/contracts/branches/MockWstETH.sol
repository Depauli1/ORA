// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

/*
 * ORA Phase 1 — mock wstETH for testnets without a canonical Lido deployment.
 * Public faucet (capped per call) so anyone can try the wstETH branch.
 */
contract MockWstETH {
    string public constant name = "Wrapped liquid staked Ether 2.0 (ORA Mock)";
    string public constant symbol = "wstETH";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public constant FAUCET_CAP = 1000e18;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // Mock exchange rate: 1 wstETH ~ 1.2 ETH (informational only)
    function stEthPerToken() external pure returns (uint256) {
        return 12e17;
    }

    function faucet(uint256 _amount) external {
        require(_amount <= FAUCET_CAP, "MockWstETH: faucet cap is 1000 per call");
        totalSupply = totalSupply + _amount;
        balanceOf[msg.sender] = balanceOf[msg.sender] + _amount;
        emit Transfer(address(0), msg.sender, _amount);
    }

    function transfer(address _to, uint256 _value) external returns (bool) {
        _transfer(msg.sender, _to, _value);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _value) external returns (bool) {
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
        require(_to != address(0), "MockWstETH: transfer to zero address");
        balanceOf[_from] = balanceOf[_from] - _value;
        balanceOf[_to] = balanceOf[_to] + _value;
        emit Transfer(_from, _to, _value);
    }
}
