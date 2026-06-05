import { formatPrice, ohMatchInfo } from '../utils/format.js';

// OH Price value: green benchmark when matched, else brown "Check Price" with a
// grey reason sub-text + explanatory tooltip. Shared by the table cells and the
// detail panels so the wording stays in one place (ohMatchInfo).
export default function OhPrice({ item }) {
  const oh = ohMatchInfo(item);
  if (oh.matched) {
    return <span className="val-green" title={oh.title}>{formatPrice(item.oh_price)}</span>;
  }
  return (
    <span className="val-check" title={oh.title}>
      Check Price{oh.sub && <span className="oh-reason">{oh.sub}</span>}
    </span>
  );
}
