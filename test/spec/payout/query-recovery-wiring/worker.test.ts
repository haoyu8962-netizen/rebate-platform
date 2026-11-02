// B2-06i rule tests (规划/08 BR-WDR-14: 查询任务丢失的 PAYING 单也要继续查、到点转人工): the pace of the
// recovery worker. One round at once, then one every hour, each with clock.now() read afresh; a due
// round is skipped while the previous one runs; a failed round is one warn line carrying only the
// error's name; stop() waits for the round in flight (the database closes after it, D10-553).
import { expect, it, vi } from 'vitest';
import { settle } from './support.ts';
import {
  COUNTS,
  DETAIL,
  HOUR_MS,
  START,
  declaredInterval,
  failure,
  flush,
  harness,
  tick,
} from './worker-kit.ts';

const FAILED = 'payout_query_recovery_failed';
const SCANNED = 'payout_query_recovery_scanned';

it('[AC-B2-06i#1] 启动后不等定时器立刻第一轮，now 是当时的 clock.now()；不足一小时不跑；满一小时下一轮，now 现取', async () => {
  const h = harness();
  const worker = h.start();
  await flush();
  expect(h.scan).toHaveBeenCalledTimes(1);
  expect(h.round(0).handle).toBe(h.db);
  expect(h.round(0).now).toEqual(new Date(START));
  h.round(0).finish();
  await flush();

  await tick(HOUR_MS - 1);
  expect(h.scan).toHaveBeenCalledTimes(1);
  const second = new Date('2026-11-02T03:17:05.000Z');
  h.clock.set(second);
  await tick(1);
  expect(h.scan).toHaveBeenCalledTimes(2);
  expect(h.round(1).handle).toBe(h.db);
  expect(h.round(1).now).toEqual(second);
  h.round(1).finish();
  await flush();

  await tick(HOUR_MS - 1);
  expect(h.scan).toHaveBeenCalledTimes(2);
  const third = new Date('2026-11-02T04:41:30.000Z');
  h.clock.set(third);
  await tick(1);
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.round(2).now).toEqual(third);
  h.round(2).finish();

  expect(await settle(worker.stop())).toEqual({ ok: true });
  expect(declaredInterval()).toBe(HOUR_MS);
});

it('[AC-B2-06i#1] 定时器是一小时的 setInterval，已 unref；stop 后不留定时器', async () => {
  const h = harness();
  const every = vi.spyOn(globalThis, 'setInterval');
  const worker = h.start();
  await flush();
  expect(every).toHaveBeenCalledTimes(1);
  expect(every.mock.calls[0]?.[1]).toBe(HOUR_MS);
  const timer = every.mock.results[0]?.value as unknown as { hasRef(): boolean };
  expect(timer.hasRef()).toBe(false);
  every.mockRestore();
  expect(vi.getTimerCount()).toBe(1);
  h.round(0).finish();
  expect(await settle(worker.stop())).toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B2-06i#2] 上一轮没结束：到点这一轮跳过、不并发、结束时也不补跑；下一个整点照常', async () => {
  const h = harness();
  const worker = h.start();
  await flush();

  await tick(HOUR_MS);
  expect(h.scan).toHaveBeenCalledTimes(1);
  await tick(HOUR_MS / 2);
  h.round(0).finish();
  await flush();
  expect(h.scan).toHaveBeenCalledTimes(1);
  await tick(HOUR_MS / 2);
  expect(h.scan).toHaveBeenCalledTimes(2);

  await tick(HOUR_MS);
  expect(h.scan).toHaveBeenCalledTimes(2);
  h.round(1).finish();
  await flush();
  await tick(HOUR_MS);
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.mostRunning()).toBe(1);

  h.round(2).finish();
  expect(await settle(worker.stop())).toEqual({ ok: true });
});

it('[AC-B2-06i#3] 单轮抛错：只有一条 warn，只带 error_name，不含 message；不向外抛；下一轮照常', async () => {
  const h = harness();
  const worker = h.start();
  await flush();
  h.round(0).finish();
  await flush();
  h.logger.info.mockClear();

  await tick(HOUR_MS);
  h.round(1).fail(failure('SyntheticScanFailure'));
  await tick(0);
  expect(h.logger.warn.mock.calls).toStrictEqual([
    [{ error_name: 'SyntheticScanFailure' }, FAILED],
  ]);
  expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain(DETAIL);
  expect(h.logger.info).not.toHaveBeenCalled();
  expect(h.rejections).toEqual([]);

  await tick(HOUR_MS);
  expect(h.scan).toHaveBeenCalledTimes(3);
  h.round(2).finish();
  await tick(0);
  expect(h.logger.warn).toHaveBeenCalledTimes(1);
  expect(h.logger.info.mock.calls).toStrictEqual([[COUNTS, SCANNED]]);

  expect(await settle(worker.stop())).toEqual({ ok: true });
  expect(h.rejections).toEqual([]);
});

it('[AC-B2-06i#3] 第一轮抛错（异步拒绝或同步抛出）：启动照常返回，只有一条 warn；下一轮照常', async () => {
  const rejecting = harness();
  const worker = rejecting.start();
  await flush();
  rejecting.round(0).fail(failure('SyntheticFirstFailure'));
  await tick(0);
  expect(rejecting.logger.warn.mock.calls).toStrictEqual([
    [{ error_name: 'SyntheticFirstFailure' }, FAILED],
  ]);
  expect(rejecting.logger.info).not.toHaveBeenCalled();
  expect(rejecting.rejections).toEqual([]);
  await tick(HOUR_MS);
  expect(rejecting.scan).toHaveBeenCalledTimes(2);
  rejecting.round(1).finish();
  expect(await settle(worker.stop())).toEqual({ ok: true });

  const throwing = harness();
  throwing.scan.mockImplementationOnce(() => {
    throw failure('SyntheticSyncFailure');
  });
  const second = throwing.start();
  await tick(0);
  expect(throwing.logger.warn.mock.calls).toStrictEqual([
    [{ error_name: 'SyntheticSyncFailure' }, FAILED],
  ]);
  expect(JSON.stringify(throwing.logger.warn.mock.calls)).not.toContain(DETAIL);
  expect(throwing.rejections).toEqual([]);
  await tick(HOUR_MS);
  expect(throwing.scan).toHaveBeenCalledTimes(2);
  throwing.round(0).finish();
  expect(await settle(second.stop())).toEqual({ ok: true });
});

it('[AC-B2-06i#3] 抛出的不是 Error（字符串、null）：同样只记一条带错误名的 warn，不泄内容，下一轮照常', async () => {
  const h = harness();
  const worker = h.start();
  await flush();
  h.round(0).fail(DETAIL);
  await tick(0);
  expect(h.logger.warn.mock.calls).toStrictEqual([[{ error_name: expect.any(String) }, FAILED]]);
  expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain(DETAIL);

  await tick(HOUR_MS);
  h.round(1).fail(null);
  await tick(0);
  expect(h.logger.warn).toHaveBeenCalledTimes(2);
  expect(h.logger.warn.mock.calls[1]).toStrictEqual([{ error_name: expect.any(String) }, FAILED]);
  expect(h.rejections).toEqual([]);

  await tick(HOUR_MS);
  expect(h.scan).toHaveBeenCalledTimes(3);
  h.round(2).finish();
  expect(await settle(worker.stop())).toEqual({ ok: true });
});

it('[AC-B2-06i#4] stop 等在途一轮结束才 resolve；等待期间和之后都不起新轮；重复 stop 安全', async () => {
  const h = harness();
  const worker = h.start();
  await flush();
  let stopped = false;
  const stopping = settle(worker.stop()).then((outcome) => {
    stopped = true;
    return outcome;
  });
  await tick(0);
  expect(stopped).toBe(false);
  await tick(3 * HOUR_MS);
  expect(stopped).toBe(false);
  expect(h.scan).toHaveBeenCalledTimes(1);

  h.round(0).finish();
  expect(await stopping).toEqual({ ok: true });
  expect(stopped).toBe(true);
  await tick(3 * HOUR_MS);
  expect(h.scan).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(await settle(worker.stop())).toEqual({ ok: true });
  expect(h.scan).toHaveBeenCalledTimes(1);
});

it('[AC-B2-06i#4] 在途一轮期间连调两次 stop：两次都等它结束；这一轮抛错时 stop 也不 reject，只记 warn', async () => {
  const h = harness();
  const worker = h.start();
  await flush();
  const outcomes: string[] = [];
  const both = Promise.all(
    ['first', 'second'].map(async (name) => {
      const outcome = await settle(worker.stop());
      outcomes.push(name);
      return outcome;
    }),
  );
  await tick(0);
  expect(outcomes).toEqual([]);

  h.round(0).fail(failure('SyntheticStopFailure'));
  expect(await both).toEqual([{ ok: true }, { ok: true }]);
  expect(h.logger.warn.mock.calls).toStrictEqual([
    [{ error_name: 'SyntheticStopFailure' }, FAILED],
  ]);
  expect(h.rejections).toEqual([]);
});

it('[AC-B2-06i#4] 没有在途一轮时 stop 直接完成，之后整点不再有新轮', async () => {
  const h = harness();
  const worker = h.start();
  await flush();
  h.round(0).finish();
  await flush();
  expect(await settle(worker.stop())).toEqual({ ok: true });
  await tick(2 * HOUR_MS);
  expect(h.scan).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B2-06i#5] 单轮成功：每轮一条 info，字段只有 scanned、enqueued、manual 三个计数；没有 warn', async () => {
  const h = harness();
  const worker = h.start();
  await flush();
  h.round(0).finish({ scanned: 3, enqueued: 1, manual: 2 });
  await tick(0);
  expect(h.logger.info.mock.calls).toStrictEqual([
    [{ scanned: 3, enqueued: 1, manual: 2 }, SCANNED],
  ]);

  await tick(HOUR_MS);
  h.round(1).finish({ scanned: 0, enqueued: 0, manual: 0 });
  await tick(0);
  expect(h.logger.info.mock.calls).toStrictEqual([
    [{ scanned: 3, enqueued: 1, manual: 2 }, SCANNED],
    [{ scanned: 0, enqueued: 0, manual: 0 }, SCANNED],
  ]);
  expect(h.logger.warn).not.toHaveBeenCalled();

  expect(await settle(worker.stop())).toEqual({ ok: true });
});
