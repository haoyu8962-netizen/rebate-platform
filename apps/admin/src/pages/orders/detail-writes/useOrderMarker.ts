// The order's result-unknown marker as the detail page sees it (F1-07ee r5): the marker of
// components/unknown-marker for page markerPageOf(order) and the signed-in account only, so
// another account signing in to this tab never sees it, and it survives a reload of the tab.
// - `left`: a marker that was already there when the page opened (or the account became known),
//   i.e. a write sent by an earlier mount or before a reload whose answer this page never saw.
//   While it stays, no write entry is offered; only the prompt with the moment and 【关闭】
//   (once the detail read by the page is shown; it is checked by opening the page again) are. A
//   definite answer that request still gets in this tab, or 【关闭】, drops it.
// - `present`: any marker of the order right now (this page's own open write included).
import { useEffect, useState } from 'react';
import {
  readUnknown,
  useMarkerAccount,
  type MarkerScope,
  type UnknownMarker,
} from '../../../components/unknown-marker/index.ts';
import { subscribeMarkers } from '../../../components/unknown-marker/marker.ts';
import { markerPageOf } from './model.ts';

export interface OrderMarker {
  readonly scope: MarkerScope;
  /** The marker found when the page opened for this account, while it is still kept. */
  readonly left: UnknownMarker | undefined;
  /** The marker kept now, whoever holds it. */
  readonly present: UnknownMarker | undefined;
}

interface Seen {
  readonly page: string;
  readonly account: string | undefined;
  readonly left: UnknownMarker | undefined;
  readonly present: UnknownMarker | undefined;
}

function seen(page: string, account: string | undefined): Seen {
  const marker = readUnknown({ page, account });
  return { page, account, left: marker, present: marker };
}

export function useOrderMarker(orderId: string): OrderMarker {
  const page = markerPageOf(orderId);
  const account = useMarkerAccount();
  const [state, setState] = useState<Seen>(() => seen(page, account));
  // The page opens for another order, or the account becomes known or changes: read again.
  if (state.page !== page || state.account !== account) setState(seen(page, account));
  const current = state.page === page && state.account === account ? state : seen(page, account);

  useEffect(
    () =>
      subscribeMarkers(() => {
        const marker = readUnknown({ page, account });
        setState((previous) => {
          if (previous.page !== page || previous.account !== account) return previous;
          // The left marker goes once it is gone (or replaced by a later one of this page).
          const left =
            previous.left !== undefined && marker?.at === previous.left.at ? marker : undefined;
          if (previous.present === marker && previous.left === left) return previous;
          return { page, account, left, present: marker };
        });
      }),
    [page, account],
  );

  return { scope: { page, account }, left: current.left, present: current.present };
}
