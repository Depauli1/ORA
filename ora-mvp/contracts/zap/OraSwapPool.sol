// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/IERC20.sol";

/*
 * ORA demo AMM — a minimal orUSD/ETH constant-product pool (0.3% fee).
 *
 * DEMO VENUE ONLY: on a public deployment the Zapper routes through a real
 * DEX (Uniswap/Aerodrome). This pool exists so one-click leverage and the
 * peg-arbitrage story can be demonstrated on the local chain. Liquidity is
 * seeded once at deploy time and is not withdrawable (no LP shares).
 */
contract OraSwapPool {
    uint256 public constant FEE_BPS = 30; // 0.3%

    IERC20 public immutable orUSD;
    uint256 public reserveOrUSD;
    uint256 public reserveETH;

    event LiquidityAdded(address indexed from, uint256 orUSDAmount, uint256 ethAmount);
    event Swap(address indexed trader, bool ethIn, uint256 amountIn, uint256 amountOut);

    constructor(address _orUSD) {
        require(_orUSD != address(0), "OraSwapPool: zero address");
        orUSD = IERC20(_orUSD);
    }

    receive() external payable {
        revert("OraSwapPool: use swap functions");
    }

    function addLiquidity(uint256 _orUSDAmount) external payable {
        require(_orUSDAmount > 0 && msg.value > 0, "OraSwapPool: zero amounts");
        require(orUSD.transferFrom(msg.sender, address(this), _orUSDAmount), "OraSwapPool: transfer failed");
        reserveOrUSD = reserveOrUSD + _orUSDAmount;
        reserveETH = reserveETH + msg.value;
        emit LiquidityAdded(msg.sender, _orUSDAmount, msg.value);
    }

    // --- Views ---

    function getETHOut(uint256 _orUSDIn) public view returns (uint256) {
        uint256 inWithFee = _orUSDIn * (10000 - FEE_BPS);
        return inWithFee * reserveETH / (reserveOrUSD * 10000 + inWithFee);
    }

    function getOrUSDOut(uint256 _ethIn) public view returns (uint256) {
        uint256 inWithFee = _ethIn * (10000 - FEE_BPS);
        return inWithFee * reserveOrUSD / (reserveETH * 10000 + inWithFee);
    }

    // orUSD per ETH, 1e18-scaled
    function spotPrice() external view returns (uint256) {
        return reserveOrUSD * 1e18 / reserveETH;
    }

    // --- Swaps ---

    function swapOrUSDForETH(uint256 _orUSDIn, uint256 _minETHOut) external returns (uint256 ethOut) {
        ethOut = getETHOut(_orUSDIn);
        require(ethOut >= _minETHOut, "OraSwapPool: slippage");
        require(orUSD.transferFrom(msg.sender, address(this), _orUSDIn), "OraSwapPool: transfer failed");
        reserveOrUSD = reserveOrUSD + _orUSDIn;
        reserveETH = reserveETH - ethOut;
        // Paying the swap output to the swapper IS the product; reserves are
        // updated first (checks-effects-interactions).
        // slither-disable-next-line arbitrary-send-eth
        (bool ok, ) = msg.sender.call{ value: ethOut }("");
        require(ok, "OraSwapPool: ETH send failed");
        emit Swap(msg.sender, false, _orUSDIn, ethOut);
    }

    function swapETHForOrUSD(uint256 _minOrUSDOut) external payable returns (uint256 orUSDOut) {
        orUSDOut = getOrUSDOut(msg.value);
        require(orUSDOut >= _minOrUSDOut, "OraSwapPool: slippage");
        reserveETH = reserveETH + msg.value;
        reserveOrUSD = reserveOrUSD - orUSDOut;
        require(orUSD.transfer(msg.sender, orUSDOut), "OraSwapPool: transfer failed");
        emit Swap(msg.sender, true, msg.value, orUSDOut);
    }
}
