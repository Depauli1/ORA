// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

/*
 * Test-only hostile counterparties for LeverZap (scaffold — excluded from the
 * coverage gate). The zap talks to its TroveManager/BorrowerOps/pool through
 * narrow interfaces and must not trust them: these mocks lie about positions,
 * accept every mutation, and pay out configured (possibly zero) amounts, so
 * the zap's own aggregate guards — "collateral value must exceed net debt",
 * "unwind must complete in 20 rounds", "nothing left over" — can be driven
 * through their revert branches.
 */
interface IFlakyERC20 {
    function transfer(address _to, uint256 _value) external returns (bool);
    function transferFrom(address _from, address _to, uint256 _value) external returns (bool);
}

contract HostileTM {
    uint256 public debt;
    uint256 public coll;
    uint256 public status = 1;

    function setDebtColl(uint256 _debt, uint256 _coll) external {
        debt = _debt;
        coll = _coll;
    }

    function setStatus(uint256 _status) external { status = _status; }
    function markClosed() external { status = 0; }

    function getTroveStatus(address) external view returns (uint256) { return status; }
    function getEntireDebtAndColl(address) external view returns (uint256, uint256, uint256, uint256) {
        return (debt, coll, 0, 0);
    }
}

contract HostileBO {
    HostileTM public immutable tm;

    constructor(address _tm) { tm = HostileTM(_tm); }

    function openTroveWithRate(uint256, uint256, address, address) external payable {}
    function addColl(address, address) external payable {}
    function withdrawLUSD(uint256, uint256, address, address) external {}
    function repayLUSD(uint256, address, address) external {}
    function closeTrove() external { tm.markClosed(); }
    function withdrawColl(uint256, address, address) external {}
}

contract HostilePool {
    IFlakyERC20 public immutable orUSD;
    uint256 public immutable ethOutPerSwap;
    uint256 public immutable orUsdOutPerSwap;

    constructor(address _orUSD, uint256 _ethOutPerSwap, uint256 _orUsdOutPerSwap) {
        orUSD = IFlakyERC20(_orUSD);
        ethOutPerSwap = _ethOutPerSwap;
        orUsdOutPerSwap = _orUsdOutPerSwap;
    }

    function swapOrUSDForETH(uint256 _orUSDIn, uint256) external returns (uint256) {
        orUSD.transferFrom(msg.sender, address(this), _orUSDIn);
        uint256 out = ethOutPerSwap;
        if (out > 0 && address(this).balance >= out) { payable(msg.sender).transfer(out); }
        return out;
    }

    function swapETHForOrUSD(uint256) external payable returns (uint256) {
        uint256 out = orUsdOutPerSwap;
        if (out > 0) { orUSD.transfer(msg.sender, out); }
        return out;
    }

    receive() external payable {}
}
