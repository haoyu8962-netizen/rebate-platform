// B3-05n · BR-AI-14 细则「无模型降级」: the intent the no-model path routes a message to (① page_guide,
// ② rule_qa, ③ order_query, ④ earnings_query, ⑤ handoff, ⑥ search) is the run's trace intent, so
// the next run's 承接 (previousIntent, agent_runs.intent) reads it: 「查一下我的订单」 (③) then
// 「返了吗」 stays ③.
//
// The core calls the degraded path through DegradedPath.run only (its one entry, B3-03q#5), so the
// intent cannot travel as an argument or in run's result. Like card-references.ts, the core binds
// a slot to the identity of the guarded RunContext it hands that run call (a WeakMap, released
// with the context); the path registers its intent on that very object with routeDegradedIntent.
// Identity cannot be produced from input or serialized data, so only code holding this run's
// context can register for it; a wrapper that copies the context loses the binding and the call
// throws instead of registering for another run. The core reads the slot when it records the
// trace (also when the user stopped the run before the path returned), then closes it: later
// registrations change nothing. An intent the model already gave is never replaced.
import type { RunContext } from '../../stream/run/index.ts';
import { DEGRADED_INTENTS } from './ports.ts';
import type { DegradedIntent } from './ports.ts';

interface RouteSlot {
  /** The model's intent is kept: registrations are ignored. */
  readonly fixed: boolean;
  intent: DegradedIntent | null;
  open: boolean;
}

/** Slot of each degraded run call, keyed by the context the core handed it (see header). */
const slots = new WeakMap<object, RouteSlot>();

/**
 * Degraded path: the intent it serves this message as, registered as soon as it knows (before any
 * output). `ctx` must be the context the core passed to DegradedPath.run (the same object). Returns
 * whether the intent will be the run's: false when the model already gave one or the trace is
 * already recorded. Throws for another context or an intent outside DEGRADED_INTENTS.
 */
export function routeDegradedIntent(ctx: RunContext, intent: DegradedIntent): boolean {
  const slot = slots.get(ctx);
  if (slot === undefined) {
    throw new Error('routeDegradedIntent: not the context of a running degraded path');
  }
  if (!(DEGRADED_INTENTS as readonly string[]).includes(intent)) {
    throw new RangeError('routeDegradedIntent: not a no-model intent');
  }
  if (slot.fixed || !slot.open) return false;
  slot.intent = intent;
  return true;
}

/** Core only: the intent slot of one DegradedPath.run call. */
export interface DegradedRoute {
  /** The registered intent (null: none, or the model's is kept); no registration counts after. */
  close(): DegradedIntent | null;
}

/**
 * Core only: binds a slot to `ctx`, a fresh object handed to that run call alone. `fixed` when the
 * model already gave the run's intent.
 */
export function openDegradedRoute(ctx: RunContext, fixed: boolean): DegradedRoute {
  if (slots.has(ctx)) throw new Error('openDegradedRoute: context already bound');
  const slot: RouteSlot = { fixed, intent: null, open: true };
  slots.set(ctx, slot);
  return {
    close() {
      slot.open = false;
      return slot.fixed ? null : slot.intent;
    },
  };
}
