/**
 * Ordering rules for the Submissions filter presets. Plain JS (no JSX) so
 * node:test can import it directly — same split as clientFilters.js.
 *
 * Display order IS priority: the leftmost preset is the one that auto-applies,
 * so these two functions are what make "drag a chip to the front" mean
 * "promote it", and what keep the document satisfying the DB's
 * `ufp_priority_is_first` CHECK (priority === sequence[0]).
 */

export const SLOTS = [1, 2, 3];

/**
 * Pack occupied slots to the front of `seq` (keeping their relative order),
 * trail the empties, and derive priority from whatever ends up leftmost.
 *
 * The packing is load-bearing, not cosmetic: without it, deleting the leading
 * preset leaves an empty slot at sequence[0], and priority has to go null even
 * though presets remain — the user loses their auto-applied filter by deleting
 * an unrelated one.
 *
 * @param presets array of 3, indexed by slot-1; null = empty slot
 * @param seq     current display order of slot numbers
 */
export function normalise(presets, seq) {
  const occupied = seq.filter((n) => presets[n - 1]);
  const empty = seq.filter((n) => !presets[n - 1]);
  return {
    presets,
    sequence: [...occupied, ...empty],
    priority: occupied.length ? occupied[0] : null,
  };
}

/**
 * Move display index `from` to display index `to`.
 *
 * `to` is an INSERT-BEFORE index measured against the untouched row (that's
 * what the pointer-midpoint test produces), so a rightward move needs the -1:
 * removing the dragged item first shifts every later index down by one, and
 * without the compensation the chip lands one slot short of where the drop
 * indicator showed it.
 */
export function reorder(seq, from, to) {
  const next = [...seq];
  const [moved] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, moved);
  return next;
}
