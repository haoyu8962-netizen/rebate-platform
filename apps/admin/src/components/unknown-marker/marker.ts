// F1-08at (FU-ADMIN-UNKNOWN-ON-RELOGIN, D10-2075): while a submission's result is unknown, the
// console keeps one marker without business data, so that after the session expires and the
// account signs in again the page can say a submission's result is still unknown.
// The stored value is exactly the JSON of UnknownMarker: page, the flag and the moment (from the
// injected clock) — never a number, amount, user, Idempotency-Key or request body. Storage
// (sessionStorage or localStorage) and key are the implementation's choice; a key may carry the
// account id, so another account signing in never sees the marker of the previous one.

/** The one value kept while a submission's result is unknown. */
export interface UnknownMarker {
  /** The page: its menu id / resource name (e.g. withdrawals, adjustments). */
  readonly page: string;
  /** There is one submission whose result is unknown. */
  readonly unknown: true;
  /** When the result became unknown: ISO 8601 as Date#toISOString gives it. */
  readonly at: string;
}

/** Console clock (epoch ms). */
export interface MarkerClock {
  now(): number;
}

/** Where a marker belongs: the page and the signed-in account (undefined while unknown). */
export interface MarkerScope {
  readonly page: string;
  readonly account: string | undefined;
}

/** Keeps the marker of `scope` at `clock`'s now (on entering the result-unknown state). */
export function markUnknown(scope: MarkerScope, clock: MarkerClock): void {
  void scope;
  void clock;
  throw new Error('NotImplemented: markUnknown');
}

/** Drops the marker of `scope` (closed by hand, or the unknown result was resolved). */
export function clearUnknown(scope: MarkerScope): void {
  void scope;
  throw new Error('NotImplemented: clearUnknown');
}

/** The marker kept for `scope`, if any; a malformed stored item counts as none. */
export function readUnknown(scope: MarkerScope): UnknownMarker | undefined {
  void scope;
  throw new Error('NotImplemented: readUnknown');
}
