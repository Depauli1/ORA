// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface IMockTBillFaucet {
    function faucet(uint256 _amount) external;
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/*
 * ORA RWA yield share — wmTBILL, the yield-splitting mTBILL wrapper.
 *
 * mTBILL is non-rebasing: one token's USD value is its NAV, which drifts up
 * ~5%/yr. Used raw as collateral, 100% of that yield accrues to borrowers.
 *
 * wmTBILL passes the NAV yield through MINUS a fixed protocol skim
 * (SKIM_RATE_PER_YEAR = 2%/yr): each wmTBILL share is redeemable for a
 * slowly DECREASING amount of mTBILL (the rate), and the mTBILL freed by
 * that decay accrues to the protocol fee receiver (treasury). Net effect:
 *   share USD value ≈ NAV growth (+5%/yr) − skim (2%/yr) = +3%/yr to borrowers,
 *   2%/yr of the RWA collateral base to the protocol — real revenue, in-kind.
 *
 * The branch prices wmTBILL at NAV × rate via WTBillPriceFeed.
 */
contract WTBill {
    string public constant name = "Wrapped mTBILL (yield-share)";
    string public constant symbol = "wmTBILL";
    uint8 public constant decimals = 18;

    uint256 public constant SKIM_RATE_PER_YEAR = 2e16; // 2% of collateral per year
    uint256 internal constant ONE_YEAR = 365 days;
    uint256 internal constant DECIMAL_PRECISION = 1e18;
    uint256 internal constant FAUCET_CHUNK = 100000e18; // MockTBill per-call cap

    IMockTBillFaucet public immutable underlying;   // mTBILL
    address public immutable feeReceiver;           // protocol treasury

    uint256 public totalSupply;
    mapping (address => uint256) public balanceOf;
    mapping (address => mapping (address => uint256)) public allowance;

    uint256 public rate = DECIMAL_PRECISION; // mTBILL per wmTBILL share (1e18-scaled), decays
    uint256 public lastSettle;
    uint256 public skimAccrued;              // mTBILL claimable by the fee receiver

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Wrapped(address indexed account, uint256 underlyingAmount, uint256 shares);
    event Unwrapped(address indexed account, uint256 underlyingAmount, uint256 shares);
    event SkimSettled(uint256 newRate, uint256 skimmed);
    event SkimClaimed(address indexed to, uint256 amount);

    constructor(address _underlying, address _feeReceiver) {
        require(_underlying != address(0) && _feeReceiver != address(0), "WTBill: zero address");
        underlying = IMockTBillFaucet(_underlying);
        feeReceiver = _feeReceiver;
        lastSettle = block.timestamp;
    }

    // --- Skim mechanics ---

    // Current rate, including un-settled linear decay since lastSettle
    function currentRate() public view returns (uint256) {
        uint256 dt = block.timestamp - lastSettle;
        uint256 decay = rate * SKIM_RATE_PER_YEAR * dt / ONE_YEAR / DECIMAL_PRECISION;
        return rate - decay;
    }

    function settle() public {
        uint256 newRate = currentRate();
        if (newRate == rate) { lastSettle = block.timestamp; return; }
        uint256 skimmed = totalSupply * (rate - newRate) / DECIMAL_PRECISION;
        rate = newRate;
        lastSettle = block.timestamp;
        skimAccrued = skimAccrued + skimmed;
        emit SkimSettled(newRate, skimmed);
    }

    function claimSkim() external {
        settle();
        uint256 amount = skimAccrued;
        require(amount > 0, "WTBill: nothing to claim");
        skimAccrued = 0;
        require(underlying.transfer(feeReceiver, amount), "WTBill: transfer failed");
        emit SkimClaimed(feeReceiver, amount);
    }

    // --- Wrap / unwrap ---

    function wrap(uint256 _underlyingAmount) external returns (uint256 shares) {
        settle();
        require(_underlyingAmount > 0, "WTBill: zero amount");
        shares = _underlyingAmount * DECIMAL_PRECISION / rate;
        require(underlying.transferFrom(msg.sender, address(this), _underlyingAmount), "WTBill: transfer in failed");
        _mint(msg.sender, shares);
        emit Wrapped(msg.sender, _underlyingAmount, shares);
    }

    function unwrap(uint256 _shares) external returns (uint256 underlyingAmount) {
        settle();
        require(_shares > 0, "WTBill: zero shares");
        underlyingAmount = _shares * rate / DECIMAL_PRECISION;
        _burn(msg.sender, _shares);
        require(underlying.transfer(msg.sender, underlyingAmount), "WTBill: transfer out failed");
        emit Unwrapped(msg.sender, underlyingAmount, _shares);
    }

    // Testnet convenience: mint wmTBILL directly via the MockTBill faucet,
    // so the app's faucet flow is identical to the raw-token branches.
    function faucet(uint256 _shares) external {
        settle();
        uint256 needed = _shares * rate / DECIMAL_PRECISION + 1;
        uint256 left = needed;
        while (left > 0) {
            uint256 chunk = left > FAUCET_CHUNK ? FAUCET_CHUNK : left;
            underlying.faucet(chunk);
            left = left - chunk;
        }
        _mint(msg.sender, _shares);
        emit Wrapped(msg.sender, needed, _shares);
    }

    // --- ERC20 ---

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
        allowance[_from][msg.sender] = allowance[_from][msg.sender] - _value;
        _transfer(_from, _to, _value);
        return true;
    }

    function _transfer(address _from, address _to, uint256 _value) internal {
        require(_to != address(0), "WTBill: transfer to zero address");
        balanceOf[_from] = balanceOf[_from] - _value;
        balanceOf[_to] = balanceOf[_to] + _value;
        emit Transfer(_from, _to, _value);
    }

    function _mint(address _to, uint256 _value) internal {
        totalSupply = totalSupply + _value;
        balanceOf[_to] = balanceOf[_to] + _value;
        emit Transfer(address(0), _to, _value);
    }

    function _burn(address _from, uint256 _value) internal {
        balanceOf[_from] = balanceOf[_from] - _value;
        totalSupply = totalSupply - _value;
        emit Transfer(_from, address(0), _value);
    }
}
