import { useState } from 'react';
import CpMatchesModal from './CpMatchesModal.jsx';
import { starColor, starClass } from '../utils/format.js';

/**
 * Read-only star cell. The colour is set in one place only — the swatch row in
 * EditDetailsModal ("✎ Edit Details" on the Property Details column) — so the
 * star here just renders whatever star_color the row carries.
 *
 * cp_match is tracked in its own column and is NOT the star colour (a manual
 * yellow/pink/blue would hide it). It renders as 10 short ticks around the
 * star instead: green = perfect, red = partial. The two are independent.
 * Clicking a ticked star opens CpMatchesModal — every matched CP submission.
 */
export default function StarCell({ item, after = null }) {
  const [showMatches, setShowMatches] = useState(false);
  const color = starColor(item);
  const cp = item?.cp_match === 'perfect' || item?.cp_match === 'partial' ? item.cp_match : null;
  // Always a star: no colour → the faint grey one (starClass(null) = prio-off).
  const star = <span className={`prio-star ${starClass(color)}`} title="Star">★</span>;
  return (
    <td className="inv-td-star">
      <span className="star-call-wrap">
        {cp ? (
          <button type="button" className={`star-cp star-cp-${cp}`} title={`CP match: ${cp} — view matches`}
            onClick={(e) => { e.stopPropagation(); setShowMatches(true); }}>
            {star}
          </button>
        ) : star}
        {after}
      </span>
      {/* React bubbles through the tree even out of a fixed-position modal, so
          without this a backdrop click would also toggle the row's expand. */}
      {showMatches && (
        <span onClick={(e) => e.stopPropagation()}>
          <CpMatchesModal item={item} onClose={() => setShowMatches(false)} />
        </span>
      )}
    </td>
  );
}
