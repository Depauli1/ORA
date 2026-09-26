// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/IERC20.sol";

interface IBORates {
    function openTroveWithRate(uint256 _LUSDAmount, uint256 _annualRate, address _upperHint, address _lowerHint) external payable;
    function addColl(address _upperHint, address _lowerHint) external payable;
    function withdrawLUSD(uint256 _maxFeePercentage, uint256 _LUSDAmount, address _upperHint, address _lowerHint) external;
    function repayLUSD(uint256 _LUSDAmount, address _upperHint, address _lowerHint) external;
    function withdrawColl(uint256 _collWithdrawal, address _upperHint, address _lowerHint) external;
    function closeTrove() external;
}

interface ITMRatesView {
    function getTroveStatus(address _borrower) external view returns (uint256);
    function getEntireDebtAndColl(address _borrower) external view returns (uint256 debt, uint256 coll, uint256 pendingDebt, uint256 pendingColl);
    function troveAnnualRate(address _borrower) external view returns (uint256);
}

interface IPriceView {
    function getPrice() external view returns (uint256);
}

interface IPool {
    function swapOrUSDForETH(uint256 _orUSDIn, uint256 _minETHOut) external returns (uint256);
    function swapETHForOrUSD(uint256 _minOrUSDOut) external payable returns (uint256);
}

/*
 * ORA Leverage Zapper — one-click leveraged ETH exposure on the rates branch.
 *
 * Liquity troves belong to one address, so each user gets their own LeverZap
 * proxy (via LeverZapFactory); the proxy owns the trove and only the user
 * commands it.
 *
 * leverOpen: deposit ETH, pick a per-loop LTV — the zap opens a trove at the
 *   user's chosen interest rate, then loops borrow → swap orUSD→ETH → add
 *   collateral, compounding exposure up to ~1/(1−LTV)×.
 * Slippage guard: _maxSlippageBps caps the TOTAL equity lost to swap costs
 *   (fees + price impact + any sandwich) across the whole atomic operation,
 *   measured against the ORACLE price — a manipulated pool cannot bypass a
 *   bound it doesn't control, and because the operation is atomic, exceeding
 *   the budget reverts everything.
 * leverClose: stepwise unwind with NO flash loans — repay what we hold,
 *   withdraw the freed collateral above a 112% safety ICR, swap it back to
 *   orUSD, repeat; close and sweep everything to the owner.
 */
contract LeverZap {
    uint256 internal constant DECIMAL_PRECISION = 1e18;
    uint256 internal constant MIN_NET_DEBT = 1800e18;
    uint256 internal constant GAS_COMP = 200e18;
    uint256 internal constant MAX_FEE = 5e16;
    uint256 internal constant UNWIND_ICR = 112e16; // keep 112% while unwinding
    uint256 internal constant MIN_STEP = 500e18;   // stop looping below this borrow size

    address public immutable owner;
    IBORates public immutable borrowerOps;
    ITMRatesView public immutable troveManager;
    IPriceView public immutable priceFeed;
    IPool public immutable pool;
    IERC20 public immutable orUSD;

    event LeverOpened(uint256 deposit, uint256 finalColl, uint256 finalDebt);
    event LeverClosed(uint256 ethReturned, uint256 orUSDReturned);

    modifier onlyOwner() {
        require(msg.sender == owner, "LeverZap: caller is not owner");
        _;
    }

    constructor(address _owner, address _bo, address _tm, address _feed, address _pool, address _orUSD) {
        owner = _owner;
        borrowerOps = IBORates(_bo);
        troveManager = ITMRatesView(_tm);
        priceFeed = IPriceView(_feed);
        pool = IPool(_pool);
        orUSD = IERC20(_orUSD);
        IERC20(_orUSD).approve(_pool, type(uint256).max);
    }

    receive() external payable {} // BO collateral withdrawals & pool swaps pay in ETH

    /* Open a leveraged position. _ltvBps = borrow per loop as bps of collateral
     * value (e.g. 6000 = 60% → ~2.5× at 6 loops). Effective leverage ≈ 1/(1−LTV). */
    function leverOpen(uint256 _annualRate, uint256 _ltvBps, uint256 _loops, uint256 _maxSlippageBps) external payable onlyOwner {
        require(msg.value > 0, "LeverZap: no ETH sent");
        require(_ltvBps > 0 && _ltvBps <= 8000, "LeverZap: LTV must be in (0, 80%]");
        require(_maxSlippageBps < 10000, "LeverZap: bad slippage");
        require(troveManager.getTroveStatus(address(this)) != 1, "LeverZap: position already open");

        uint256 price = priceFeed.getPrice();
        uint256 debt = msg.value * price / DECIMAL_PRECISION * _ltvBps / 10000;
        require(debt >= MIN_NET_DEBT, "LeverZap: deposit too small for min 1800 orUSD debt");
        borrowerOps.openTroveWithRate{ value: msg.value }(debt, _annualRate, address(0), address(0));

        // No bal < MIN_STEP guard is needed at loop entry: the first entry
        // holds the initial debt (>= MIN_NET_DEBT = 1800 orUSD > MIN_STEP) and
        // every later entry holds the previous round's `more`, which the
        // min-step break below already guarantees is >= MIN_STEP.
        for (uint256 i = 0; i < _loops; i++) {
            uint256 bal = orUSD.balanceOf(address(this));
            uint256 ethOut = pool.swapOrUSDForETH(bal, 0); // aggregate-guarded below
            borrowerOps.addColl{ value: ethOut }(address(0), address(0));
            uint256 more = ethOut * price / DECIMAL_PRECISION * _ltvBps / 10000;
            if (more < MIN_STEP) break;
            borrowerOps.withdrawLUSD(MAX_FEE, more, address(0), address(0));
        }
        // sweep any leftover orUSD into collateral so nothing sits idle
        uint256 rest = orUSD.balanceOf(address(this));
        if (rest > 0) {
            uint256 ethRest = pool.swapOrUSDForETH(rest, 0);
            borrowerOps.addColl{ value: ethRest }(address(0), address(0));
        }
        (uint256 d, uint256 c, , ) = troveManager.getEntireDebtAndColl(address(this));
        // aggregate slippage bound: remaining equity (at ORACLE price) must be
        // at least (1 - maxSlippage) of the deposited value
        uint256 collValue = c * price / DECIMAL_PRECISION;
        uint256 netDebt = d - GAS_COMP;
        require(collValue > netDebt, "LeverZap: slippage exceeded");
        require(collValue - netDebt >=
            msg.value * price / DECIMAL_PRECISION * (10000 - _maxSlippageBps) / 10000,
            "LeverZap: slippage exceeded");
        emit LeverOpened(msg.value, c, d);
    }

    /* Fully unwind: no flash loans — iteratively repay + free collateral. */
    function leverClose(uint256 _maxSlippageBps) external onlyOwner {
        require(_maxSlippageBps < 10000, "LeverZap: bad slippage");
        require(troveManager.getTroveStatus(address(this)) == 1, "LeverZap: no open position");
        // entry equity at the ORACLE price — the aggregate slippage baseline
        uint256 entryPrice = priceFeed.getPrice();
        uint256 equity0;
        {
            (uint256 d0, uint256 c0, , ) = troveManager.getEntireDebtAndColl(address(this));
            uint256 cv0 = c0 * entryPrice / DECIMAL_PRECISION;
            uint256 nd0 = d0 - GAS_COMP;
            equity0 = cv0 > nd0 ? cv0 - nd0 : 0;
        }
        for (uint256 i = 0; i < 20; i++) {
            (uint256 debt, uint256 coll, , ) = troveManager.getEntireDebtAndColl(address(this));
            uint256 bal = orUSD.balanceOf(address(this));

            if (bal >= debt - GAS_COMP) {
                borrowerOps.closeTrove();
                break;
            }
            // repay as much as allowed (net debt must stay >= 1800)
            uint256 net = debt - GAS_COMP;
            if (bal > 0 && net > MIN_NET_DEBT) {
                // r = min(bal, net - MIN_NET_DEBT) is provably > 0 here:
                // both operands are strictly positive (checked above).
                uint256 r = bal < net - MIN_NET_DEBT ? bal : net - MIN_NET_DEBT;
                borrowerOps.repayLUSD(r, address(0), address(0));
            }
            // withdraw collateral above the 112% safety line and swap it back
            (debt, coll, , ) = troveManager.getEntireDebtAndColl(address(this));
            uint256 price = priceFeed.getPrice();
            uint256 needColl = debt * UNWIND_ICR / price;
            require(coll > needColl + 1e15, "LeverZap: cannot unwind further (ICR too thin)");
            uint256 free = coll - needColl;
            borrowerOps.withdrawColl(free, address(0), address(0));
            pool.swapETHForOrUSD{ value: address(this).balance }(0); // aggregate-guarded below
        }
        require(troveManager.getTroveStatus(address(this)) != 1, unicode"LeverZap: unwind incomplete — try again or use exec()");

        // convert any surplus orUSD back to ETH so the user exits in one asset
        uint256 orUSDLeft = orUSD.balanceOf(address(this));
        if (orUSDLeft > 0) {
            pool.swapOrUSDForETH(orUSDLeft, 0);
            orUSDLeft = 0;
        }
        // aggregate slippage bound: ETH returned must be worth at least
        // (1 - maxSlippage) of the position's entry equity
        require(address(this).balance * entryPrice / DECIMAL_PRECISION >=
            equity0 * (10000 - _maxSlippageBps) / 10000,
            "LeverZap: slippage exceeded");
        uint256 ethLeft = address(this).balance;
        if (ethLeft > 0) {
            // owner is immutable and set by the factory to the zap's creator
            // slither-disable-next-line arbitrary-send-eth
            (bool ok, ) = payable(owner).call{ value: ethLeft }("");
            require(ok, "LeverZap: ETH sweep failed");
        }
        emit LeverClosed(ethLeft, orUSDLeft);
    }

    // Escape hatch: the owner can make the zap do anything (manual unwind, rescue)
    function exec(address _target, bytes calldata _data, uint256 _value) external onlyOwner returns (bytes memory) {
        // deliberate owner-only escape hatch: arbitrary call is the feature
        // slither-disable-next-line arbitrary-send-eth,low-level-calls
        (bool ok, bytes memory ret) = _target.call{ value: _value }(_data);
        require(ok, "LeverZap: exec failed");
        return ret;
    }

    function position() external view returns (uint256 debt, uint256 coll, uint256 annualRate, uint256 status) {
        (debt, coll, , ) = troveManager.getEntireDebtAndColl(address(this));
        annualRate = troveManager.troveAnnualRate(address(this));
        status = troveManager.getTroveStatus(address(this));
    }
}

contract LeverZapFactory {
    address public immutable borrowerOps;
    address public immutable troveManager;
    address public immutable priceFeed;
    address public immutable pool;
    address public immutable orUSD;

    mapping (address => address) public zapOf;

    event ZapCreated(address indexed user, address zap);

    constructor(address _bo, address _tm, address _feed, address _pool, address _orUSD) {
        borrowerOps = _bo;
        troveManager = _tm;
        priceFeed = _feed;
        pool = _pool;
        orUSD = _orUSD;
    }

    function createZap() external returns (address zap) {
        require(zapOf[msg.sender] == address(0), "LeverZapFactory: zap exists");
        zap = address(new LeverZap(msg.sender, borrowerOps, troveManager, priceFeed, pool, orUSD));
        zapOf[msg.sender] = zap;
        emit ZapCreated(msg.sender, zap);
    }
}
