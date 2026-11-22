// F1-08at (D10-2075): the signed-in account of the login guard (refine's getIdentity, i.e. GET
// /admin/v1/me/permissions as the guard keeps it), never the shell's static account, and the
// marker of one page for it. A write enters the result-unknown state with mark() and leaves it
// with clear() once a settled answer came (success or a settled refusal); a 10001 (the session
// ended) settles nothing, so the marker stays for the prompt after signing in again.
// F1-08atb (FU-UNKNOWN-MARKER-MULTI-SUBMIT, D10-2508): the marker is held per submission. Every
// submission of an instance is its own holder; a settled answer releases only that holder, and
// the marker goes when no holder is left (the earlier moment of a joined marker is kept). 【关闭】
// on the prompt drops the marker and the holders it stood for (marker.ts clearUnknown); a
// submission still under way then holds it afresh, at the clock's now, when its answer leaves the
// result unknown or ends the session (mark() / sessionEnded()), and a settled answer of it leaves
// nothing. The pages call these for every answer, also after they were left (unmounted).
// F1-08atb money r1 S1-1: every send (a first send as well as 【重试】) calls begin() as its request
// goes out, noting the submission, the account it was made under and the count of 【关闭】 then —
// nothing is stored by it. A 10001 answering a send during which 【关闭】 was pressed holds the
// marker at the clock's now even if this submission had never marked: 【关闭】 does not take away
// the claim of a submission that was under way while the prompt stood.
import { useActiveAuthProvider } from '@refinedev/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import {
  closesOf,
  holdUnknown,
  releaseUnknown,
  type MarkerClock,
  type MarkerScope,
} from './marker.ts';

const NOT_SIGNED_IN = 10001;

function accountOf(identity: unknown): string | undefined {
  if (typeof identity !== 'object' || identity === null) return undefined;
  const id = (identity as Record<string, unknown>)['admin_id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** The admin_id of the signed-in account (undefined until the guard answered, or without one). */
export function useMarkerAccount(): string | undefined {
  const auth = useActiveAuthProvider();
  const getIdentity = auth?.getIdentity;
  /** The answer and the getIdentity it came from (an answer of another provider is not used). */
  const [answer, setAnswer] = useState<{
    readonly source: unknown;
    readonly account: string | undefined;
  }>();
  useEffect(() => {
    if (getIdentity === undefined) return;
    let live = true;
    getIdentity().then(
      (identity: unknown) => {
        if (live) setAnswer({ source: getIdentity, account: accountOf(identity) });
      },
      () => {
        if (live) setAnswer({ source: getIdentity, account: undefined });
      },
    );
    return () => {
      live = false;
    };
  }, [getIdentity]);
  if (getIdentity === undefined || answer?.source !== getIdentity) return undefined;
  return answer.account;
}

/** Whether an answer to a write ended the session (it settles nothing about the write). */
export function endsSession(cause: unknown): boolean {
  return cause instanceof AdminApiError && cause.code === NOT_SIGNED_IN;
}

export interface UnknownMarkerControl {
  /** The page and the signed-in account. */
  readonly scope: MarkerScope;
  /**
   * The request of this submission goes out (a first send or a resend under its key): notes the
   * submission, its account and the count of 【关闭】 so far; nothing is stored. Call it right
   * before every send, also when the page marks before sending.
   */
  begin(): void;
  /**
   * This submission's result is unknown (now, by the clock): it holds the marker; an existing
   * marker of the page keeps its earlier moment and this submission joins it. Again while it
   * still holds: nothing changes. Dropped meanwhile by 【关闭】: held afresh at now.
   */
  mark(): void;
  /**
   * This submission got a settled answer: it releases only its own holding; the marker goes
   * when no other submission holds it. Without a mark() of this submission: nothing changes.
   * The next mark() is a new submission.
   */
  clear(): void;
  /**
   * The submission is given up while its result is still unknown — the dialog was closed by
   * 【去列表核对】 / 【核对】 (its key is dropped): a marker it holds stays until 【关闭】, and no later
   * answer of this instance drops it; the next submission starts afresh. Not an answer: a
   * marker already dropped by 【关闭】 is not written again.
   */
  leave(): void;
  /**
   * An answer of this submission ended the session (10001), which settles nothing: when this
   * submission had marked its result unknown (or kept the marker before sending), or 【关闭】 was
   * pressed while its request (begin()) was under way, it holds the marker — afresh at now if
   * 【关闭】 dropped it meanwhile — and is given up as with leave(); otherwise nothing is kept.
   */
  sessionEnded(): void;
}

/**
 * The marker of `page` for the signed-in account; its moment comes from `clock`, the page's
 * injected clock (CONSOLE_CLOCK when the page was given none), never from the time read here.
 */
export function useUnknownMarker(page: string, clock: MarkerClock): UnknownMarkerControl {
  const account = useMarkerAccount();
  const scope = useMemo<MarkerScope>(() => ({ page, account }), [page, account]);
  const scopeRef = useRef(scope);
  const clockRef = useRef(clock);
  /**
   * Marked before the account was known: kept once it is, at the moment of the mark, by `holder`;
   * `held`: still this instance's submission (false once left).
   */
  const pendingRef = useRef<{ at: number; holder: object; held: boolean } | undefined>(undefined);
  /** The current submission of this instance as a holder of the marker. */
  const holderRef = useRef<object>({});
  /** The scope the current submission marked under (undefined: it has not marked). */
  const heldRef = useRef<MarkerScope | undefined>(undefined);
  /**
   * The current submission's request under way (begin()): the scope it was sent under and the
   * count of 【关闭】 at that moment; undefined once its submission was settled or given up.
   */
  const flightRef = useRef<{ scope: MarkerScope; closes: number } | undefined>(undefined);
  useEffect(() => {
    scopeRef.current = scope;
    clockRef.current = clock;
  }, [scope, clock]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === undefined || scope.account === undefined) return;
    pendingRef.current = undefined;
    holdUnknown(scope, { now: () => pending.at }, pending.holder);
    if (pending.held) heldRef.current = scope;
  }, [scope]);

  return useMemo<UnknownMarkerControl>(() => {
    const mark = () => {
      if (pendingRef.current?.held === true) return;
      // The scope the submission first marked under (the account that made it), else the one its
      // request went out under, else the current.
      const flown = flightRef.current?.scope;
      const target =
        heldRef.current ?? (flown?.account !== undefined ? flown : undefined) ?? scopeRef.current;
      if (target.account === undefined) {
        pendingRef.current = {
          at: clockRef.current.now(),
          holder: holderRef.current,
          held: true,
        };
        return;
      }
      // Idempotent while this holder holds the stored marker; held afresh once 【关闭】 dropped it.
      holdUnknown(target, clockRef.current, holderRef.current);
      heldRef.current = target;
    };
    const leave = () => {
      // The old holder stays among the marker's holders for good; the next mark() is new.
      const pending = pendingRef.current;
      if (pending !== undefined) pendingRef.current = { ...pending, held: false };
      heldRef.current = undefined;
      flightRef.current = undefined;
      holderRef.current = {};
    };
    return {
      scope,
      begin() {
        const target = heldRef.current ?? scopeRef.current;
        flightRef.current = { scope: target, closes: closesOf(target) };
      },
      mark,
      clear() {
        const pending = pendingRef.current;
        if (pending?.held === true) pendingRef.current = undefined;
        const held = heldRef.current;
        const holder = holderRef.current;
        heldRef.current = undefined;
        flightRef.current = undefined;
        // Each submission is its own holder: the next one never shares this holding.
        holderRef.current = {};
        if (held !== undefined) releaseUnknown(held, holder);
      },
      leave,
      sessionEnded() {
        const flight = flightRef.current;
        // 【关闭】 while this request was under way: the prompt it stood behind is gone, so the
        // session ending now leaves this submission's result for the prompt after signing in.
        const closedMeanwhile = flight !== undefined && closesOf(flight.scope) !== flight.closes;
        if (heldRef.current !== undefined || pendingRef.current?.held === true || closedMeanwhile)
          mark();
        leave();
      },
    };
  }, [scope]);
}
