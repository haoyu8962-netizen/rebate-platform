// B2-15s (FU-TICK-STOP-BOUND): the bounded wait of a background timer's stop for its tick in
// flight. B2-15q made onModuleDestroy wait for the tick so that the database closes after it, but a
// tick stuck at pool.connect() (PostgreSQL unreachable) would have kept context.close() from ever
// ending. A stop waits on a wall-clock setTimeout, as the chain timers around it do, not on Clock.
import type { RootLogger } from '../logging/index.ts';

/**
 * How long a stop waits for its tick in flight. Nest calls onModuleDestroy module by module, one
 * after the other, so the five timers of the worker cost 4 s at worst; with queue.stop's 5 s that
 * is 9 s, inside the 10 s of `docker stop`. A healthy slow tick can still finish after the bound:
 * handles.close comes next and waits for connections in use, at most 5 s of its own (not in the
 * 9 s).
 */
export const TICK_STOP_WAIT_MS = 800;

/**
 * Resolves when `tick` settles, or at TICK_STOP_WAIT_MS with one warn line; never rejects. The tick
 * goes on after the bound: its own catch takes a late failure, and this wait handles both outcomes,
 * so no rejection goes unhandled. The bound is unref'd and cleared with the tick, leaving no timer.
 */
export function waitForTickStop(
  tick: Promise<void>,
  timer: string,
  logger: Pick<RootLogger, 'warn'>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const bound = setTimeout(() => {
      logger.warn({ timer }, 'worker_tick_stop_timed_out');
      resolve();
    }, TICK_STOP_WAIT_MS);
    bound.unref();
    const settled = (): void => {
      clearTimeout(bound);
      resolve();
    };
    tick.then(settled, settled);
  });
}
