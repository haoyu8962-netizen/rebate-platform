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
// F1-08atb money r3 S1 (D10-3166 ③ / D10-3172): the holding is a MarkerHandle — one submission,
// one holder for the handle's whole life. The hook's own methods work on a default handle that is
// replaced after clear() / leave() / sessionEnded() (the next mark() is a new submission, as
// before); open() gives a page an independent handle, so a page whose submission is (key, body)
// (调账) can keep several and settle each with its own answer.
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

const KEY_CONFLICT = 20901;

/**
 * Whether an answer to a write is 20901 (the same Idempotency-Key with another body). F1-08atb
 * money r2 S1: it says nothing about the submission stored under that key, so after an
 * undetermined answer under the key the earlier submission stays unknown — its marker is kept
 * (mark(); its handle goes with the key), never released by this answer.
 */
export function keyConflict(cause: unknown): boolean {
  return cause instanceof AdminApiError && cause.kind === 'api' && cause.code === KEY_CONFLICT;
}

export interface MarkerHandle {
  /**
   * This submission's request goes out (a first send or a resend): notes the account it goes out
   * under and the count of 【关闭】 so far; nothing is stored.
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
   * when no other submission holds it. Without a mark() of it: nothing changes. The holder stays
   * the same: a later mark() of this handle is the same submission holding again.
   */
  clear(): void;
  /**
   * An answer of this submission ended the session (10001), which settles nothing: when it had
   * marked its result unknown, or 【关闭】 was pressed while its request (begin()) was under way,
   * it holds the marker — afresh at now if 【关闭】 dropped it meanwhile — and is given up: the
   * holding stays until 【关闭】 and every later call of this handle changes nothing.
   */
  sessionEnded(): void;
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
  /**
   * A handle of one more submission, independent of the default one above and of every other
   * handle: its own holder, request under way and mark before the account was known.
   */
  open(): MarkerHandle;
}

/** One submission's handle with its giving up (the hook's leave() of the default handle). */
interface Handle extends MarkerHandle {
  leave(): void;
}

/** The refs a handle reads at call time (the page's current scope and clock). */
interface HandleContext {
  readonly scope: { readonly current: MarkerScope };
  readonly clock: { readonly current: MarkerClock };
  /**
   * Handles that marked before the account was known, with the moment of that mark: kept for
   * the account once it is, each by its own holder at its own moment.
   */
  readonly waiting: Map<HandleState, number>;
}

interface HandleState {
  /** This submission as a holder of the marker (the same for the handle's whole life). */
  readonly holder: object;
  /** The scope it marked under (undefined: it does not hold). */
  held: MarkerScope | undefined;
  /**
   * Its request under way (begin()): the scope it was sent under and the count of 【关闭】 at that
   * moment; undefined once it was settled or given up.
   */
  flight: { scope: MarkerScope; closes: number } | undefined;
  /** Given up (leave() / sessionEnded()): a holding it has stays, nothing it does changes it. */
  left: boolean;
}

function createHandle(context: HandleContext): Handle {
  const state: HandleState = { holder: {}, held: undefined, flight: undefined, left: false };
  const { waiting } = context;
  const mark = () => {
    if (state.left || waiting.has(state)) return;
    // The scope the submission first marked under (the account that made it), else the one its
    // request went out under, else the current.
    const flown = state.flight?.scope;
    const target =
      state.held ?? (flown?.account !== undefined ? flown : undefined) ?? context.scope.current;
    if (target.account === undefined) {
      waiting.set(state, context.clock.current.now());
      return;
    }
    // Idempotent while this holder holds the stored marker; held afresh once 【关闭】 dropped it.
    holdUnknown(target, context.clock.current, state.holder);
    state.held = target;
  };
  const leave = () => {
    // The holding stays among the marker's holders for good (a mark still waiting for the
    // account is kept for it as well).
    state.left = true;
    state.held = undefined;
    state.flight = undefined;
  };
  return {
    begin() {
      if (state.left) return;
      const target = state.held ?? context.scope.current;
      state.flight = { scope: target, closes: closesOf(target) };
    },
    mark,
    clear() {
      if (state.left) return;
      waiting.delete(state);
      const held = state.held;
      state.held = undefined;
      state.flight = undefined;
      if (held !== undefined) releaseUnknown(held, state.holder);
    },
    leave,
    sessionEnded() {
      if (state.left) return;
      const flight = state.flight;
      // 【关闭】 while this request was under way: the prompt it stood behind is gone, so the
      // session ending now leaves this submission's result for the prompt after signing in.
      const closedMeanwhile = flight !== undefined && closesOf(flight.scope) !== flight.closes;
      if (state.held !== undefined || waiting.has(state) || closedMeanwhile) mark();
      leave();
    },
  };
}

/** Keeps every mark made before the account was known, the earliest first (its moment wins). */
function keepWaiting(waiting: Map<HandleState, number>, scope: MarkerScope): void {
  const marks = Array.from(waiting).sort((a, b) => a[1] - b[1]);
  waiting.clear();
  for (const [state, at] of marks) {
    holdUnknown(scope, { now: () => at }, state.holder);
    if (!state.left) state.held = scope;
  }
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
  /** Marks made before the account was known, by handle (see HandleContext). */
  const waitingRef = useRef<Map<HandleState, number> | undefined>(undefined);
  /** The handle of the hook's own methods: the current submission; replaced once it is done. */
  const defaultRef = useRef<Handle | undefined>(undefined);
  useEffect(() => {
    scopeRef.current = scope;
    clockRef.current = clock;
  }, [scope, clock]);

  useEffect(() => {
    const waiting = waitingRef.current;
    if (waiting === undefined || waiting.size === 0 || scope.account === undefined) return;
    keepWaiting(waiting, scope);
  }, [scope]);

  return useMemo<UnknownMarkerControl>(() => {
    const open = (): Handle =>
      createHandle({
        scope: scopeRef,
        clock: clockRef,
        waiting: (waitingRef.current ??= new Map<HandleState, number>()),
      });
    const current = (): Handle => (defaultRef.current ??= open());
    /** The default handle is done: the next mark() is a new submission. */
    const renew = () => {
      defaultRef.current = open();
    };
    return {
      scope,
      begin() {
        current().begin();
      },
      mark() {
        current().mark();
      },
      clear() {
        current().clear();
        renew();
      },
      leave() {
        current().leave();
        renew();
      },
      sessionEnded() {
        current().sessionEnded();
        renew();
      },
      open,
    };
  }, [scope]);
}
