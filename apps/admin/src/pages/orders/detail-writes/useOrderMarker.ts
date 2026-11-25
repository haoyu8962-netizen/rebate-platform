// The order's result-unknown marker as the detail page sees it (F1-07ee r7): the marker of
// components/unknown-marker for page markerPageOf(order) and the signed-in account only, so
// another account signing in to this tab never sees it, and it survives a reload of the tab.
// - `left`: a marker that was already there when the page opened (or the account became known),
//   i.e. a write sent by an earlier mount or before a reload whose answer this page never saw.
//   While it stays, no write entry is offered; the prompt shows the moment and, once the detail
//   read by the page is shown and no write of the order is still waiting for its answer in this
//   tab, 【放弃这次提交】 (with a confirmation). A definite answer that request still gets in this
//   tab, or a confirmed 【放弃这次提交】, drops it; it is never taken as settled by comparing
//   versions (the marker keeps none).
// - `present`: any marker of the order right now (this page's own open write included).
// - `sending`: a write of the order sent in this tab still has no answer (./openWrites.ts).
// - `drops`: how many times `left` went away (the marker was dropped, or the account or order
//   changed), counted in the very state update that drops it; it never goes down. The page reads
//   the detail again whenever it changes and offers no entry until that read is shown.
import { useEffect, useState } from 'react';
import {
  readUnknown,
  useMarkerAccount,
  type MarkerScope,
  type UnknownMarker,
} from '../../../components/unknown-marker/index.ts';
import { subscribeMarkers } from '../../../components/unknown-marker/marker.ts';
import { markerPageOf } from './model.ts';
import { subscribeWrites, writePending } from './openWrites.ts';

export interface OrderMarker {
  readonly orderId: string;
  readonly scope: MarkerScope;
  /** The marker found when the page opened for this account, while it is still kept. */
  readonly left: UnknownMarker | undefined;
  /** The marker kept now, whoever holds it. */
  readonly present: UnknownMarker | undefined;
  /** A write of this order sent in this tab has no answer yet. */
  readonly sending: boolean;
  /** How many times `left` went away in this hook instance (never decreases). */
  readonly drops: number;
}

interface Seen {
  readonly page: string;
  readonly account: string | undefined;
  readonly left: UnknownMarker | undefined;
  readonly present: UnknownMarker | undefined;
  readonly sending: boolean;
  readonly drops: number;
}

/** What the page sees on opening for `page` and `account`; `before` is what it saw until now. */
function seen(
  orderId: string,
  page: string,
  account: string | undefined,
  before: Seen | undefined,
): Seen {
  const marker = readUnknown({ page, account });
  const drops = before === undefined ? 0 : before.drops;
  return {
    page,
    account,
    left: marker,
    present: marker,
    sending: writePending(orderId),
    // A left marker that goes with a change of account or order counts as dropped too.
    drops: before?.left !== undefined && marker === undefined ? drops + 1 : drops,
  };
}

export function useOrderMarker(orderId: string): OrderMarker {
  const page = markerPageOf(orderId);
  const account = useMarkerAccount();
  const [state, setState] = useState<Seen>(() => seen(orderId, page, account, undefined));
  let current = state;
  // The page opens for another order, or the account becomes known or changes: read again.
  if (state.page !== page || state.account !== account) {
    current = seen(orderId, page, account, state);
    setState(current);
  }

  useEffect(() => {
    const refresh = () => {
      const marker = readUnknown({ page, account });
      const sending = writePending(orderId);
      setState((previous) => {
        if (previous.page !== page || previous.account !== account) return previous;
        // The left marker goes once it is gone (or replaced by a later one of this page).
        const left =
          previous.left !== undefined && marker?.at === previous.left.at
            ? previous.left
            : undefined;
        const present = previous.present?.at === marker?.at ? previous.present : marker;
        if (previous.present === present && previous.left === left && previous.sending === sending)
          return previous;
        // Counted in this very update: no render sees the marker gone without the new count.
        const drops =
          previous.left !== undefined && left === undefined ? previous.drops + 1 : previous.drops;
        return { page, account, left, present, sending, drops };
      });
    };
    const offMarkers = subscribeMarkers(refresh);
    const offWrites = subscribeWrites(refresh);
    // Anything that changed between the render and this subscription.
    refresh();
    return () => {
      offMarkers();
      offWrites();
    };
  }, [orderId, page, account]);

  return {
    orderId,
    scope: { page, account },
    left: current.left,
    present: current.present,
    sending: current.sending,
    drops: current.drops,
  };
}
