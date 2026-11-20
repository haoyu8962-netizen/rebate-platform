// F1-08at (D10-2075): the signed-in account of the login guard (refine's getIdentity, i.e. GET
// /admin/v1/me/permissions as the guard keeps it), never the shell's static account, and the
// marker of one page for it. A write enters the result-unknown state with mark() and leaves it
// with clear() once a settled answer came (success or a settled refusal); a 10001 (the session
// ended) settles nothing, so the marker stays for the prompt after signing in again.
import { useActiveAuthProvider } from '@refinedev/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import { clearUnknown, markUnknown, type MarkerClock, type MarkerScope } from './marker.ts';

const SYSTEM_CLOCK: MarkerClock = { now: () => Date.now() };
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
  /** A submission of this page entered the result-unknown state (now, by the clock). */
  mark(): void;
  /** The unknown submission got a settled answer: the marker goes. */
  clear(): void;
}

/** The marker of `page` for the signed-in account. */
export function useUnknownMarker(
  page: string,
  clock: MarkerClock = SYSTEM_CLOCK,
): UnknownMarkerControl {
  const account = useMarkerAccount();
  const scope = useMemo<MarkerScope>(() => ({ page, account }), [page, account]);
  const scopeRef = useRef(scope);
  const clockRef = useRef(clock);
  /** Marked before the account was known: kept once it is (the moment of the mark). */
  const pendingRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    scopeRef.current = scope;
    clockRef.current = clock;
  }, [scope, clock]);

  useEffect(() => {
    const at = pendingRef.current;
    if (at === undefined || scope.account === undefined) return;
    pendingRef.current = undefined;
    markUnknown(scope, { now: () => at });
  }, [scope]);

  return useMemo<UnknownMarkerControl>(
    () => ({
      scope,
      mark() {
        const current = scopeRef.current;
        if (current.account === undefined) {
          pendingRef.current = clockRef.current.now();
          return;
        }
        markUnknown(current, clockRef.current);
      },
      clear() {
        pendingRef.current = undefined;
        clearUnknown(scopeRef.current);
      },
    }),
    [scope],
  );
}
