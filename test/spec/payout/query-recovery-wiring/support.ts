// Shared by the B2-06i rule tests. PayoutRuntime has no startRecovery yet, so the tests reach it
// through a local type and an optional call: on the skeleton that is an assertion failure, never a
// TypeError.
import { expect } from 'vitest';
import type { PayoutRuntime } from '../../../../apps/api/src/modules/payout/payout-runtime.ts';

export interface RecoveryWorkerLike {
  stop(): Promise<void>;
}

export type RecoverableRuntime = PayoutRuntime & { startRecovery?: () => RecoveryWorkerLike };

/** startRecovery() of a runtime that must have it. */
export function startedRecovery(runtime: RecoverableRuntime): RecoveryWorkerLike {
  const worker = runtime.startRecovery?.();
  expect(typeof worker?.stop).toBe('function');
  return worker as RecoveryWorkerLike;
}

/** What a promise came to, as a value: a rejection is then asserted on, not raised. */
export type Settled = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export async function settle(run: Promise<unknown>): Promise<Settled> {
  try {
    await run;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A gate: `wait()` resolves once `open()` was called. */
export function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open: () => release(), wait: () => opened };
}

/** The fields of every log call with this message, in order. */
export function logged(
  log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
  message: string,
): unknown[] {
  return log.mock.calls.filter((call) => call[1] === message).map((call) => call[0]);
}
