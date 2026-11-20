// F1-08at (FU-ADMIN-UNKNOWN-ON-RELOGIN, D10-2075): while a submission's result is unknown, the
// console keeps one marker without business data, so that after the session expires and the
// account signs in again the page can say a submission's result is still unknown.
// The stored value is exactly the JSON of UnknownMarker: page, the flag and the moment (from the
// injected clock) — never a number, amount, user, Idempotency-Key or request body. It is kept in
// this tab's sessionStorage under a key carrying the page and the account id, so another account
// signing in never sees the marker of the previous one; without a known account nothing is kept.

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

const PREFIX = 'couli.admin.unknown-marker';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Called whenever a marker is kept or dropped (the prompt of the page reads it again). */
export function subscribeMarkers(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed(): void {
  for (const listener of Array.from(listeners)) listener();
}

/**
 * The submissions of this tab whose result is unknown under the stored marker of a key, and the
 * moment of that marker. Only in memory: nothing more than {page, unknown, at} is ever stored.
 * FOREIGN stands for a marker this tab did not write in this run (left before a reload): no
 * submission here can resolve it, so only 【关闭】 drops it.
 */
interface Holding {
  readonly at: string;
  readonly holders: Set<object>;
}
const holders = new Map<string, Holding>();
const FOREIGN: object = Object.freeze({});

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    // Storage switched off by the browser: nothing is kept.
    return undefined;
  }
}

function keyOf(scope: MarkerScope): string | undefined {
  if (scope.account === undefined || scope.account === '' || scope.page === '') return undefined;
  return `${PREFIX}:${encodeURIComponent(scope.page)}:${encodeURIComponent(scope.account)}`;
}

/** Keeps the marker of `scope` at `clock`'s now (on entering the result-unknown state). */
export function markUnknown(scope: MarkerScope, clock: MarkerClock): void {
  const key = keyOf(scope);
  const area = storage();
  if (key === undefined || area === undefined) return;
  const ms = clock.now();
  if (!Number.isFinite(ms)) return;
  const marker: UnknownMarker = { page: scope.page, unknown: true, at: new Date(ms).toISOString() };
  try {
    area.setItem(key, JSON.stringify(marker));
  } catch {
    // Quota or a switched-off storage: the prompt after signing in again is a convenience only.
    return;
  }
  changed();
}

/** Drops the marker of `scope` whatever holds it (the prompt's 【关闭】 by hand). */
export function clearUnknown(scope: MarkerScope): void {
  const key = keyOf(scope);
  const area = storage();
  if (key === undefined) return;
  holders.delete(key);
  if (area === undefined) return;
  try {
    if (area.getItem(key) === null) return;
    area.removeItem(key);
  } catch {
    return;
  }
  changed();
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The marker kept for `scope`, if any; a malformed stored item counts as none. */
export function readUnknown(scope: MarkerScope): UnknownMarker | undefined {
  const key = keyOf(scope);
  const area = storage();
  if (key === undefined || area === undefined) return undefined;
  let raw: string | null;
  try {
    raw = area.getItem(key);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3) return undefined;
  const { page, unknown, at } = record;
  if (page !== scope.page || unknown !== true || typeof at !== 'string') return undefined;
  if (!ISO.test(at) || Number.isNaN(Date.parse(at))) return undefined;
  return { page, unknown: true, at };
}

/**
 * `holder` (one submission) entered the result-unknown state at `clock`'s now. Without a marker
 * for `scope` one is kept at that moment; with one, it stays as it is (its earlier moment wins)
 * and `holder` only joins the submissions it stands for.
 */
export function holdUnknown(scope: MarkerScope, clock: MarkerClock, holder: object): void {
  const key = keyOf(scope);
  if (key === undefined || storage() === undefined) return;
  const kept = readUnknown(scope);
  if (kept === undefined) {
    markUnknown(scope, clock);
    const written = readUnknown(scope);
    if (written !== undefined) holders.set(key, { at: written.at, holders: new Set([holder]) });
    return;
  }
  let holding = holders.get(key);
  if (holding?.at !== kept.at) {
    holding = { at: kept.at, holders: new Set([FOREIGN]) };
    holders.set(key, holding);
  }
  holding.holders.add(holder);
}

/**
 * `holder`'s unknown submission got a settled answer. The marker goes only when no other
 * submission it stands for is still unknown; a holder that never held it changes nothing.
 */
export function releaseUnknown(scope: MarkerScope, holder: object): void {
  const key = keyOf(scope);
  if (key === undefined) return;
  const holding = holders.get(key);
  if (holding?.holders.delete(holder) !== true) return;
  if (readUnknown(scope)?.at !== holding.at) {
    // Closed by hand or replaced meanwhile: that marker is not this holding's to drop.
    if (holders.get(key) === holding) holders.delete(key);
    return;
  }
  if (holding.holders.size > 0) return;
  clearUnknown(scope);
}
