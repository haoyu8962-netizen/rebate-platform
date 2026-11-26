// Which answer the order detail page may show (F1-07ee r6, BR-FUND-06): no read ever shows over
// a newer write. Each detail GET takes a ticket (its place in the order of requests) when it is
// sent; a write's success answer, once shown, makes every read sent before it stale, and no
// answer of the same order with a smaller row_version than the shown one is taken. A stale read
// is dropped, its success and its failure alike, and the page keeps what it shows.
import type { OrderDetail } from '../model.ts';

export interface DetailGate {
  /** A detail GET is sent: its ticket. */
  readonly read: () => number;
  /**
   * The answer of the read with this ticket came: its detail, or undefined when it failed.
   * True when the page may show it; false when a newer answer is already shown.
   */
  readonly takeRead: (ticket: number, detail: OrderDetail | undefined) => boolean;
  /** A write's success answer came: true when the page may show its detail. */
  readonly takeWrite: (detail: OrderDetail) => boolean;
}

interface Shown {
  readonly orderId: string;
  readonly rowVersion: number;
}

export function createDetailGate(): DetailGate {
  let sent = 0;
  // Reads with a ticket at or below this one were sent before the last write answer shown.
  let floor = 0;
  let shown: Shown | undefined;
  const older = (detail: OrderDetail): boolean =>
    shown !== undefined &&
    shown.orderId === detail.order_id &&
    detail.row_version < shown.rowVersion;
  const show = (detail: OrderDetail): void => {
    shown = { orderId: detail.order_id, rowVersion: detail.row_version };
  };
  return {
    read: () => {
      sent += 1;
      return sent;
    },
    takeRead: (ticket, detail) => {
      if (ticket <= floor) return false;
      if (detail === undefined) {
        shown = undefined;
        return true;
      }
      if (older(detail)) return false;
      show(detail);
      return true;
    },
    takeWrite: (detail) => {
      if (older(detail)) return false;
      floor = sent;
      show(detail);
      return true;
    },
  };
}
