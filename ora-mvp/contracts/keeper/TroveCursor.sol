// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface ITMReader {
    function getEntireDebtAndColl(address _borrower)
        external
        view
        returns (uint256 debt, uint256 coll, uint256 pendingDebt, uint256 pendingColl);
}

interface ISortedReader {
    function getFirst() external view returns (address);
    function getNext(address _id) external view returns (address);
    function getSize() external view returns (uint256);
}

/*
 * ORA keeper helper — cursor-paginated trove scans.
 *
 * MultiTroveGetter pages by OFFSET, and each offset page re-walks the list
 * from the head: a page at depth d costs O(d), the full scan O(n^2), and
 * pages past ~700 troves exceed the eth_call gas budget entirely. The
 * keeper therefore could never see more than the first ~500–700 troves —
 * and on the rates branch (sorted by rate, not risk) underwater troves can
 * sit anywhere in the list.
 *
 * This cursor resumes from an ADDRESS instead of an offset: every page
 * costs O(page size) regardless of depth, so keepers page to the end of
 * arbitrarily large lists (~21k gas/trove measured; 500/page ≈ 10.5M gas
 * per eth_call). Values are ENTIRE debt/coll (pending rewards + accrued
 * rates interest included), so ICRs computed off-chain match the protocol.
 *
 * Stateless and branch-agnostic: one deployment serves all branches.
 * _cursor = address(0) starts at the head; nextCursor = address(0) ends.
 */
contract TroveCursor {
    struct Row {
        address owner;
        uint256 debt;
        uint256 coll;
    }

    function scan(address _tm, address _sorted, address _cursor, uint256 _count)
        external
        view
        returns (Row[] memory rows, address nextCursor, uint256 size)
    {
        address cur = _cursor == address(0)
            ? ISortedReader(_sorted).getFirst()
            : _cursor;
        rows = new Row[](_count);
        uint256 n = 0;
        while (n < _count && cur != address(0)) {
            (uint256 d, uint256 c, , ) = ITMReader(_tm).getEntireDebtAndColl(cur);
            rows[n] = Row(cur, d, c);
            unchecked { ++n; }
            cur = ISortedReader(_sorted).getNext(cur);
        }
        assembly { mstore(rows, n) } // shrink to the rows actually read
        nextCursor = cur;
        size = ISortedReader(_sorted).getSize();
    }
}
