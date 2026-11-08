import { expect, it } from 'vitest';
import {
  expectFault,
  expectOpen,
  fastPolicy,
  fault,
  GovernanceError,
  registry,
  rejected,
  rig,
  success,
  trip,
} from './kit.ts';

it('[AC-B1-14d#9] 在线采用覆盖时限，order_sync 仍为每次 10 秒与两次重试', async () => {
  const r = rig(registry(), fault('timeout'));
  const online = r.search();
  const offline = r.search('order_sync');
  await r.advance(80);
  expectFault(online, 'timeout');
  expect(offline.settled).toBe('pending');
  expect(r.take.mock.calls).toEqual([['online'], ['order_sync']]);
  const offlineSignal = r.transport.mock.calls[1]![0].signal;
  await r.advance(9919);
  expect(offlineSignal?.aborted).toBe(false);
  expect(offline.settled).toBe('pending');
  await r.advance(1);
  expect(offlineSignal?.aborted).toBe(true);
  await r.advance(199);
  expect(r.transport).toHaveBeenCalledTimes(2);
  await r.advance(1);
  expect(r.transport).toHaveBeenCalledTimes(3);
  await r.advance(10_400);
  expect(r.transport).toHaveBeenCalledTimes(4);
  await r.advance(9999);
  expect(offline.settled).toBe('pending');
  await r.advance(1);
  expectFault(offline, 'timeout');
  expect(r.calledAt).toEqual([0, 0, 10_200, 20_600]);
  expect(r.take.mock.calls).toEqual([['online'], ['order_sync'], ['order_sync'], ['order_sync']]);
  expect(r.scheduler.pending).toBe(0);
});

it('[AC-B1-14d#10] 在线打开不影响离线；离线仍可重试成功，且不重置在线熔断', async () => {
  // openMs 大于离线重试的 200 ms，让两者能在同一个打开周期内观察。
  const r = rig(registry({ breaker: { openMs: 900 } }), fault('server_error'));
  await trip(r);
  const offline = r.search('order_sync');
  await r.advance(0);
  expect(offline.settled).toBe('pending');
  expect(r.transport).toHaveBeenCalledTimes(3);
  r.upstream.reply = success();
  await r.advance(199);
  expect(r.transport).toHaveBeenCalledTimes(3);
  await r.advance(1);
  expect(offline.settled).toBe('resolved');
  expect(offline.value?.items).toHaveLength(1);
  expect(r.take.mock.calls).toEqual([['online'], ['online'], ['order_sync'], ['order_sync']]);
  const online = r.search();
  await r.advance(0);
  expectOpen(online);
  expect(r.transport).toHaveBeenCalledTimes(4);
  expect(r.take).toHaveBeenCalledTimes(4);
});

it('[AC-B1-14d#11] 离线按默认 20 次打开，仍允许在线按登记表时限调用', async () => {
  const r = rig(registry(), fault('server_error'));
  for (let i = 0; i < 6; i += 1) {
    const result = r.search('order_sync');
    await r.advance(600);
    expectFault(result, 'server_error');
  }
  const last = r.search('order_sync');
  await r.advance(600);
  expect(last.error).toBeInstanceOf(GovernanceError);
  expect(last.error).toMatchObject({ code: 'circuit_open', dependency: 'union:pdd:offline' });
  expect(r.transport).toHaveBeenCalledTimes(20);
  expect(r.take).toHaveBeenCalledTimes(20);
  r.upstream.reply = fault('timeout');
  const online = r.search();
  await r.advance(fastPolicy.timeoutMs);
  expectFault(online, 'timeout');
  expect(r.transport).toHaveBeenCalledTimes(21);
  expect(r.take.mock.calls[20]).toEqual(['online']);
  r.upstream.reply = success();
  const recovered = r.search();
  await r.advance(0);
  expect(recovered.settled).toBe('resolved');
  const offline = r.search('order_sync');
  await r.advance(0);
  expect(offline.error).toMatchObject({ code: 'circuit_open', dependency: 'union:pdd:offline' });
  expect(r.transport).toHaveBeenCalledTimes(22);
  expect(r.take).toHaveBeenCalledTimes(22);
});

it('[AC-B1-14d#12] 登记表允许读重试一次时，真实 convert 仍只发一次，读按覆盖退避', async () => {
  const r = rig(
    registry({ retries: { maxRetries: 1 }, breaker: { minRequests: 20 } }),
    fault('server_error'),
  );
  const write = r.convert();
  await r.advance(1000);
  expectFault(write, 'server_error');
  expect(r.transport).toHaveBeenCalledTimes(1);
  expect(JSON.parse(r.transport.mock.calls[0]![0].body!)).toMatchObject({
    type: 'pdd.ddk.goods.promotion.url.generate',
  });
  const read = r.search();
  await r.advance(17);
  expectFault(read, 'server_error');
  expect(r.calledAt).toEqual([0, 1000, 1017]);
  expect(r.take).toHaveBeenCalledTimes(3);
  expect(r.scheduler.pending).toBe(0);
});

it('[AC-B1-14d#13] 业务拒绝不重试、不打开熔断；窗口过期后真正故障按新阈值打开', async () => {
  const r = rig(registry({ retries: { maxRetries: 1 } }), rejected());
  for (let i = 0; i < 3; i += 1) {
    const refusal = r.search();
    await r.advance(0);
    expect(refusal.settled).toBe('rejected');
    expect(refusal.error).toMatchObject({ code: 'upstream_misconfigured' });
    expect(r.transport).toHaveBeenCalledTimes(i + 1);
  }
  r.upstream.reply = success();
  const available = r.search();
  await r.advance(0);
  expect(available.settled).toBe('resolved');
  expect(available.value?.items).toHaveLength(1);
  await r.advance(fastPolicy.breaker.windowMs);
  r.upstream.reply = fault('server_error');
  const failed = r.search();
  await r.advance(17);
  expectFault(failed, 'server_error');
  const blocked = r.search();
  await r.advance(0);
  expectOpen(blocked);
  expect(r.transport).toHaveBeenCalledTimes(6);
  expect(r.take).toHaveBeenCalledTimes(6);
});
