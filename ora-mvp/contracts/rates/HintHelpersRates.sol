// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

/*
 * ORA rates engine — hint helper for the rate-ordered sorted list.
 *
 * getApproxHint returns a trove address whose annual interest rate is close to
 * the target, found by random sampling. Pass the result to
 * SortedTroves.findInsertPosition(rate, hint, hint) for exact neighbours.
 */

interface ITroveManagerRatesView {
    function getTroveOwnersCount() external view returns (uint256);
    function getTroveFromTroveOwnersArray(uint256 _index) external view returns (address);
    function troveAnnualRate(address _borrower) external view returns (uint256);
}

contract HintHelpersRates {
    string constant public NAME = "HintHelpersRates";

    ITroveManagerRatesView public immutable troveManager;

    constructor(address _troveManager) {
        require(_troveManager != address(0), "HintHelpersRates: zero address");
        troveManager = ITroveManagerRatesView(_troveManager);
    }

    function getApproxHint(uint256 _annualRate, uint256 _numTrials, uint256 _inputRandomSeed)
        external
        view
        returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)
    {
        uint256 arrayLength = troveManager.getTroveOwnersCount();

        if (arrayLength == 0) {
            return (address(0), 0, _inputRandomSeed);
        }

        hintAddress = troveManager.getTroveFromTroveOwnersArray(0);
        diff = _absDiff(troveManager.troveAnnualRate(hintAddress), _annualRate);
        latestRandomSeed = _inputRandomSeed;

        uint256 i = 1;
        while (i < _numTrials) {
            latestRandomSeed = uint256(keccak256(abi.encodePacked(latestRandomSeed)));

            uint256 arrayIndex = latestRandomSeed % arrayLength;
            address currentAddress = troveManager.getTroveFromTroveOwnersArray(arrayIndex);
            uint256 currentDiff = _absDiff(troveManager.troveAnnualRate(currentAddress), _annualRate);

            if (currentDiff < diff) {
                diff = currentDiff;
                hintAddress = currentAddress;
            }
            i++;
        }
    }

    function _absDiff(uint256 _a, uint256 _b) internal pure returns (uint256) {
        return _a >= _b ? _a - _b : _b - _a;
    }
}
