// Order writes of this tab that were sent and have no answer yet (F1-07ee r7, D10-3169): one
// count per order, only in memory (never in sessionStorage), and nothing else — no body, no
// account, no amount. A write dialog's request keeps counting after its page unmounted, until it
// gets an answer or its deadline passes; meanwhile a page opened again on the order does not offer
// 【放弃这次提交】 for the marker that request still holds (./useOrderMarker.ts).

type Listener = () => void;

const counts = new Map<string, number>();
const listeners = new Set<Listener>();

function changed(): void {
  for (const listener of Array.from(listeners)) listener();
}

/**
 * A write of `orderId` is sent: it counts as open until the returned function is called (its
 * answer came, or its result became unknown). Calling that function again changes nothing.
 */
export function beginWrite(orderId: string): () => void {
  counts.set(orderId, (counts.get(orderId) ?? 0) + 1);
  changed();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (counts.get(orderId) ?? 0) - 1;
    if (left > 0) counts.set(orderId, left);
    else counts.delete(orderId);
    changed();
  };
}

/** Whether a write of `orderId` was sent in this tab and has no answer yet. */
export function writePending(orderId: string): boolean {
  return (counts.get(orderId) ?? 0) > 0;
}

/** Called whenever a write of any order is sent or ends. */
export function subscribeWrites(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
