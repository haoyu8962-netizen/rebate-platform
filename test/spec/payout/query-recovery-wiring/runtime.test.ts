// B2-06i rule tests: PayoutRuntime.startRecovery over fake ports, no database. It must follow
// start(decision) and can run once; it does not look at the mode. Every scan statement fails on the
// fake handle, so a round shows as the worker's warn line carrying only the error's name.
import { expect, it, vi } from 'vitest';
import {
  createPayoutRuntime,
  type PayoutRuntimeOptions,
} from '../../../../apps/api/src/modules/payout/payout-runtime.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { LIVE_CREDENTIALS, thrownBy } from '../entry/mode-kit.ts';
import { logged, settle, startedRecovery, type RecoverableRuntime } from './support.ts';

const FAILED = 'payout_query_recovery_failed';
const DB_FAILURE = 'SyntheticDbFailure';

function fakeRuntime() {
  const withSchema = vi.fn((): never => {
    const error = new Error('synthetic-detail-of-a-statement');
    error.name = DB_FAILURE;
    throw error;
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const queue = {
    register: vi.fn(),
    send: vi.fn(async () => null),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const options = {
    db: { withSchema },
    queue,
    eventBus: {},
    clock: new FixedClock('2026-11-02T02:00:00.000Z'),
    logger: Object.assign(logger, { child: () => logger }),
    config: { configValue: vi.fn(async () => null) },
    ledger: {},
    lockUsersForUpdate: vi.fn(),
    decryptPayee: vi.fn(),
  } as unknown as PayoutRuntimeOptions;
  return {
    withSchema,
    logger,
    queue,
    runtime: createPayoutRuntime(options) as RecoverableRuntime,
  };
}

it('[AC-B2-06i#9] start 之前调 startRecovery 抛错且不占用；start 之后第一次起一个 worker，第二次抛错、不起第二个', async () => {
  const fake = fakeRuntime();
  expect(thrownBy(() => fake.runtime.startRecovery?.())).toBeInstanceOf(Error);
  expect(fake.withSchema).not.toHaveBeenCalled();

  fake.runtime.start({ mode: 'dry_run' });
  const worker = startedRecovery(fake.runtime);
  expect(thrownBy(() => fake.runtime.startRecovery?.())).toBeInstanceOf(Error);

  expect(await settle(worker.stop())).toEqual({ ok: true });
  expect(fake.withSchema).toHaveBeenCalledTimes(1);
  expect(logged(fake.logger.warn, FAILED)).toStrictEqual([{ error_name: DB_FAILURE }]);
  expect(JSON.stringify(fake.logger.warn.mock.calls)).not.toContain('synthetic-detail');
  expect(fake.queue.send).not.toHaveBeenCalled();
  expect(await settle(worker.stop())).toEqual({ ok: true });
});

it('[AC-B2-06i#10] live 决定下 startRecovery 一样起：运行体不看模式，日志不含私钥', async () => {
  const fake = fakeRuntime();
  fake.runtime.start({ mode: 'live', credentials: LIVE_CREDENTIALS });
  const worker = startedRecovery(fake.runtime);
  expect(await settle(worker.stop())).toEqual({ ok: true });
  expect(fake.withSchema).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(fake.logger.warn.mock.calls)).not.toContain(LIVE_CREDENTIALS.privateKey);
  expect(JSON.stringify(fake.logger.info.mock.calls)).not.toContain(LIVE_CREDENTIALS.privateKey);
});
