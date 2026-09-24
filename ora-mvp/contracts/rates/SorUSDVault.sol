// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";
import "../Dependencies/IERC20.sol";

/*
 * ORA rates engine — sorUSD, the savings vault for orUSD.
 *
 * A minimal ERC-4626-style shares vault: deposit orUSD, receive sorUSD shares.
 * Interest streamed from rate-paying borrowers (via the InterestRouter) raises
 * the share price — sorUSD is a passively appreciating claim on orUSD.
 *
 * First-depositor/donation protection: the first deposit locks DEAD_SHARES
 * shares to a dead address, making share-price manipulation uneconomical.
 */
contract SorUSDVault {
    using SafeMath for uint256;

    string public constant name = "Savings orUSD";
    string public constant symbol = "sorUSD";
    uint8 public constant decimals = 18;

    IERC20 public immutable asset; // orUSD
    uint256 public totalSupply;
    mapping (address => uint256) public balanceOf;
    mapping (address => mapping (address => uint256)) public allowance;

    uint256 internal constant DEAD_SHARES = 1000;
    address internal constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, uint256 assets, uint256 shares);

    constructor(address _asset) public {
        require(_asset != address(0), "SorUSD: asset is zero address");
        asset = IERC20(_asset);
    }

    // --- Vault views ---

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function convertToShares(uint256 _assets) public view returns (uint256) {
        return totalSupply == 0 ? _assets : _assets.mul(totalSupply).div(totalAssets());
    }

    function convertToAssets(uint256 _shares) public view returns (uint256) {
        return totalSupply == 0 ? _shares : _shares.mul(totalAssets()).div(totalSupply);
    }

    // orUSD value of one sorUSD share, 1e18-scaled
    function sharePrice() external view returns (uint256) {
        return convertToAssets(1e18);
    }

    // --- Vault actions ---

    function deposit(uint256 _assets) external returns (uint256 shares) {
        require(_assets > 0, "SorUSD: zero assets");
        if (totalSupply == 0) {
            require(_assets > DEAD_SHARES, "SorUSD: first deposit too small");
            shares = _assets.sub(DEAD_SHARES);
            _mint(DEAD_ADDRESS, DEAD_SHARES);
        } else {
            shares = _assets.mul(totalSupply).div(totalAssets());
            require(shares > 0, "SorUSD: deposit computes to zero shares");
        }
        require(asset.transferFrom(msg.sender, address(this), _assets), "SorUSD: transfer in failed");
        _mint(msg.sender, shares);
        emit Deposit(msg.sender, _assets, shares);
    }

    function redeem(uint256 _shares) external returns (uint256 assets) {
        require(_shares > 0, "SorUSD: zero shares");
        assets = _shares.mul(totalAssets()).div(totalSupply);
        _burn(msg.sender, _shares);
        require(asset.transfer(msg.sender, assets), "SorUSD: transfer out failed");
        emit Withdraw(msg.sender, assets, _shares);
    }

    // --- ERC20 (shares are transferable/composable) ---

    function transfer(address _to, uint256 _value) external returns (bool) {
        _transfer(msg.sender, _to, _value);
        return true;
    }

    function approve(address _spender, uint256 _value) external returns (bool) {
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _value) external returns (bool) {
        allowance[_from][msg.sender] = allowance[_from][msg.sender].sub(_value, "SorUSD: allowance exceeded");
        _transfer(_from, _to, _value);
        return true;
    }

    // --- Internal ---

    function _transfer(address _from, address _to, uint256 _value) internal {
        require(_to != address(0), "SorUSD: transfer to zero address");
        balanceOf[_from] = balanceOf[_from].sub(_value, "SorUSD: balance exceeded");
        balanceOf[_to] = balanceOf[_to].add(_value);
        emit Transfer(_from, _to, _value);
    }

    function _mint(address _to, uint256 _value) internal {
        totalSupply = totalSupply.add(_value);
        balanceOf[_to] = balanceOf[_to].add(_value);
        emit Transfer(address(0), _to, _value);
    }

    function _burn(address _from, uint256 _value) internal {
        balanceOf[_from] = balanceOf[_from].sub(_value, "SorUSD: burn exceeds balance");
        totalSupply = totalSupply.sub(_value);
        emit Transfer(_from, address(0), _value);
    }
}
