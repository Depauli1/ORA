// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";
import "../Dependencies/IERC20.sol";

/*
 * ORA rates engine — InterestRouter.
 *
 * TroveManagerRates mints accrued borrower interest (orUSD) to this contract.
 * Anyone may call distribute() to push the balance onward:
 *   80% -> SorUSDVault  (yield for orUSD savers)
 *   20% -> treasury     (protocol revenue)
 *
 * setAddresses is one-shot: ownership is burned once targets are wired.
 */
contract InterestRouter {
    using SafeMath for uint256;

    uint256 public constant VAULT_SHARE_BPS = 8000; // 80%

    IERC20 public orUSD;
    address public vault;
    address public treasury;
    address public owner;

    event AddressesSet(address orUSD, address vault, address treasury);
    event InterestDistributed(uint256 toVault, uint256 toTreasury);

    constructor() public {
        owner = msg.sender;
    }

    function setAddresses(address _orUSD, address _vault, address _treasury) external {
        require(msg.sender == owner, "InterestRouter: caller is not owner");
        require(_orUSD != address(0) && _vault != address(0) && _treasury != address(0),
            "InterestRouter: zero address");
        orUSD = IERC20(_orUSD);
        vault = _vault;
        treasury = _treasury;
        owner = address(0); // one-shot wiring
        emit AddressesSet(_orUSD, _vault, _treasury);
    }

    function pending() external view returns (uint256) {
        return orUSD.balanceOf(address(this));
    }

    function distribute() external {
        uint256 bal = orUSD.balanceOf(address(this));
        require(bal > 0, "InterestRouter: nothing to distribute");
        uint256 toVault = bal.mul(VAULT_SHARE_BPS).div(10000);
        uint256 toTreasury = bal.sub(toVault);
        require(orUSD.transfer(vault, toVault), "InterestRouter: vault transfer failed");
        require(orUSD.transfer(treasury, toTreasury), "InterestRouter: treasury transfer failed");
        emit InterestDistributed(toVault, toTreasury);
    }
}
