// B3-05i · BR-AI-05 / BR-AI-06: card references in a tool's modelView. A tool builds its modelView
// before the run numbers its cards (numbering happens in RunContext.card, after execute returns),
// so it writes cardReference(ctx, index) where the model must see outcome.cards[index]'s card_id.
// After delivery the core replaces each reference with the delivered frame's card_id, or removes
// it when that card was not delivered, before the view reaches the model or the trace.
//
// Binding a reference to its tool call. The tool context carries no call id, and the run's signal
// must stay the run's own object (B3-05b#35), so neither can tell two calls apart. A new
// ToolContext field would not reach registry handlers either: tools/registry builds its
// ToolCallContext field by field. What every layer already forwards by reference is the
// placeholders table, so the core hands each execute call a fresh frozen copy of the run's table
// and keys the call's scope on that object's identity (a WeakMap, released with the call).
// Identity cannot be produced from model input or serialized data, so a reference can only be
// issued for a call by code holding that call's context. A wrapper that copies the table loses
// the binding and cardReference throws (the tool then fails) instead of binding to another call.
// Once the core has settled a call, its scope is closed and cardReference throws too, so a tool
// keeping an old context cannot issue references that would no longer be resolved.
import { randomBytes } from 'node:crypto';
import type { ToolContext } from './ports.ts';

/** Shared structural context accepted by both ToolContext and registry ToolCallContext. */
export type CardReferenceContext = Pick<
  ToolContext,
  'runId' | 'sessionId' | 'signal' | 'placeholders'
>;

interface CallScope {
  /** `@card-ref:<nonce>:<encodeURIComponent(callId)>:`; the index follows. */
  readonly prefix: string;
  /** Issued reference → outcome.cards index. Only these strings are ever resolved. */
  readonly issued: Map<string, number>;
  open: boolean;
}

/** Scope of each live tool call, keyed by the per-call placeholders table (see header). */
const scopes = new WeakMap<object, CallScope>();

/** Marks a value whose card was not delivered: its field / element is removed. */
const DROPPED: unique symbol = Symbol('dropped');

/**
 * B3-05i / BR-AI-05: tools inject this function as deps.cardReference(ctx, index).
 * index addresses outcome.cards, not embedded products or the session sequence.
 * An issued reference is opaque, scoped to one execute call, and never a real cN id.
 * Wire format: @card-ref:<nonce>:<encodeURIComponent(callId)>:<index>, where nonce is
 * 32 lowercase hex characters from server-side cryptographic randomness for this call.
 * Only issued tokens may be resolved (a matching string pattern is insufficient).
 * Core resolves whole string values recursively after confirmed card delivery, removing
 * object fields / array elements for undelivered cards, before model or trace exposure.
 * No-reference modelView and failed / rejected outcomes retain their existing behavior.
 *
 * Only a whole string value is a reference. A reference spliced into a longer string, or used as
 * an object key, is not resolved and is kept like any other text (a substring match would let
 * look-alike model or catalog text be rewritten); tools must put references in values of their
 * own. Strings issued for another call are kept unchanged too. Valid only on the context the
 * core passed to OrchestratorTools.execute (or a copy keeping its placeholders object), and only
 * until that execute call has been settled; otherwise it throws.
 */
export function cardReference(ctx: CardReferenceContext, index: number): string {
  const scope = scopes.get(ctx.placeholders);
  if (scope === undefined) {
    throw new Error('cardReference: not the context of a running orchestrator tool call');
  }
  if (!scope.open) throw new Error('cardReference: this tool call has already been settled');
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('cardReference: index must be a non-negative integer');
  }
  const reference = `${scope.prefix}${index}`;
  scope.issued.set(reference, index);
  return reference;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copy of value with resolved references; DROPPED when value itself was a dropped reference. */
function resolveDeep(value: unknown, ids: ReadonlyMap<string, string | null>): unknown {
  if (typeof value === 'string') {
    if (!ids.has(value)) return value;
    return ids.get(value) ?? DROPPED;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value as readonly unknown[]) {
      const resolved = resolveDeep(item, ids);
      if (resolved !== DROPPED) out.push(resolved);
    }
    return out;
  }
  if (plainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveDeep(item, ids);
      if (resolved === DROPPED) continue;
      // defineProperty: a "__proto__" key from parsed JSON stays an own data field.
      Object.defineProperty(out, key, {
        value: resolved,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * Core only: the reference scope of one OrchestratorTools.execute call. Record each
 * outcome.cards entry in order with delivered(), then resolve the modelView and trace records.
 */
export interface CardCall {
  /** Whether the tool issued any reference; without one every value is returned unchanged. */
  readonly used: boolean;
  /** The next outcome.cards entry: its delivered frame card_id, or null when not delivered. */
  delivered(cardId: string | null): void;
  /** No reference can be issued for this call afterwards. */
  close(): void;
  view(modelView: unknown): unknown;
  records<T extends object>(entries: readonly T[], keys: readonly (keyof T & string)[]): T[];
}

class ToolCallReferences implements CardCall {
  readonly #scope: CallScope;
  readonly #delivered: (string | null)[] = [];

  constructor(scope: CallScope) {
    this.#scope = scope;
  }

  get used(): boolean {
    return this.#scope.issued.size > 0;
  }

  delivered(cardId: string | null): void {
    this.#delivered.push(cardId);
  }

  close(): void {
    this.#scope.open = false;
  }

  /** Issued reference → delivered card_id, null for a card not (confirmed) delivered. */
  #ids(): ReadonlyMap<string, string | null> {
    this.close();
    const ids = new Map<string, string | null>();
    for (const [reference, index] of this.#scope.issued) {
      ids.set(reference, this.#delivered[index] ?? null);
    }
    return ids;
  }

  /**
   * The model's copy of a modelView. Without issued references the view itself is returned
   * (B3-05b behaviour). Otherwise the view is first read as the model would read it (its JSON
   * form, so toJSON and dropped undefined fields apply), then every whole-string reference of
   * this call becomes the delivered card_id; a reference to an undelivered card removes its
   * object field or array element (a root reference becomes null). The tool's object is never
   * modified. For failed / rejected outcomes nothing was delivered: their views come back
   * unchanged unless they carry this call's references, which are removed.
   */
  view(modelView: unknown): unknown {
    if (!this.used) return modelView;
    const ids = this.#ids();
    const json = JSON.stringify(modelView);
    if (json === undefined) return modelView;
    const resolved = resolveDeep(JSON.parse(json) as unknown, ids);
    return resolved === DROPPED ? null : resolved;
  }

  /**
   * Trace records (card_sources, link_registrations) with the same resolution. A record whose
   * identifying field (`keys`) is a reference to an undelivered card is left out whole: it
   * describes nothing that was delivered. Without issued references the records are unchanged.
   */
  records<T extends object>(entries: readonly T[], keys: readonly (keyof T & string)[]): T[] {
    if (!this.used) return [...entries];
    const ids = this.#ids();
    const out: T[] = [];
    for (const entry of entries) {
      const record = entry as Record<string, unknown>;
      if (keys.some((key) => resolveDeep(record[key], ids) === DROPPED)) continue;
      out.push(resolveDeep(entry, ids) as T);
    }
    return out;
  }
}

/**
 * Core only: opens the scope of one execute call. `table` must be a fresh object handed to that
 * call alone as ToolContext.placeholders; its identity binds cardReference to the call.
 * B3-05n: also the no-model path's own tool calls (degraded/routing.ts), on the guarded context
 * the core handed it, which numbers the cards it delivers.
 */
export function openCardCall(callId: string, table: Readonly<Record<string, string>>): CardCall {
  if (scopes.has(table)) throw new Error('openCardCall: placeholders table already bound');
  const nonce = randomBytes(16).toString('hex');
  const scope: CallScope = {
    prefix: `@card-ref:${nonce}:${encodeURIComponent(callId)}:`,
    issued: new Map<string, number>(),
    open: true,
  };
  scopes.set(table, scope);
  return new ToolCallReferences(scope);
}
