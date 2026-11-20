// F1-08at (D10-2075): the signed-in account of the login guard (refine's getIdentity, i.e. GET
// /admin/v1/me/permissions as the guard keeps it), never the shell's static account, and the
// marker of one page for it. A write enters the result-unknown state with mark() and leaves it
// with clear() once a settled answer came (success or a settled refusal); a 10001 (the session
// ended) settles nothing, so the marker stays for the prompt after signing in again.
// One marker per page and account: a later unknown submission keeps the earlier moment, and a
// settled answer drops the marker only when no other submission it stands for is still unknown
// (holdUnknown / releaseUnknown); 【关闭】 on the prompt drops it whatever holds it.
import { useActiveAuthProvider } from '@refinedev/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import { holdUnknown, releaseUnknown, type MarkerClock, type MarkerScope } from './marker.ts';

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
   * This submission entered the result-unknown state (now, by the clock); an existing marker of
   * the page keeps its moment. Again while still unknown: nothing changes.
   */
  mark(): void;
  /**
   * This submission got a settled answer: the marker goes unless another submission it stands
   * for is still unknown. Without an earlier mark() of this instance: nothing changes.
   */
  clear(): void;
  /**
   * The submission is given up while its result is still unknown — the session ended (10001), or
   * the dialog was closed by 【去列表核对】 / 【核对】 (its key is dropped): its marker stays until
   * 【关闭】, and no later answer of this instance drops it; the next submission starts afresh.
   */
  leave(): void;
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
  /** This instance's submission as a holder of the marker, and the scope it holds it under. */
  const holderRef = useRef<object>({});
  const heldRef = useRef<MarkerScope | undefined>(undefined);
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

  return useMemo<UnknownMarkerControl>(
    () => ({
      scope,
      mark() {
        if (heldRef.current !== undefined || pendingRef.current?.held === true) return;
        const current = scopeRef.current;
        if (current.account === undefined) {
          pendingRef.current = {
            at: clockRef.current.now(),
            holder: holderRef.current,
            held: true,
          };
          return;
        }
        holdUnknown(current, clockRef.current, holderRef.current);
        heldRef.current = current;
      },
      clear() {
        const pending = pendingRef.current;
        if (pending?.held === true) pendingRef.current = undefined;
        const held = heldRef.current;
        heldRef.current = undefined;
        if (held !== undefined) releaseUnknown(held, holderRef.current);
      },
      leave() {
        // The old holder stays among the marker's submissions for good; the next mark() is new.
        const pending = pendingRef.current;
        if (pending !== undefined) pendingRef.current = { ...pending, held: false };
        heldRef.current = undefined;
        holderRef.current = {};
      },
    }),
    [scope],
  );
}
