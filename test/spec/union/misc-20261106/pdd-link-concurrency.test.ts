import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { LinkingUnionIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import {
  generatePddAuthorityLink,
  PDD_QUERY_CONCURRENCY,
} from '../../../../apps/api/src/modules/linking/application/pdd-authority.ts';
import type { PddAuthorityUrl } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { demo } from '../../linking/open-pdd-auth/port-kit.ts';
import { occupyQueries, queryClient } from '../../linking/upstream-limits/query-kit.ts';

// Task-local AC labels ([AC-B1-04zzj#n]) identify this task's acceptance points, not business rules.
// D10-692 S2-8：generatePddAuthorityLink 与 queryPddAuthority 共用 PDD_QUERY_CONCURRENCY 的同一个在途
// 计数。名额占满时生成调用等待（不调上游、不当失败），有名额释放后继续；任何时刻在途上游调用不超过上限；
// 生成调用成功、抛错或答非所问都释放名额。查询超额仍按 B1-06za 立即失败。链接与身份都是合成值。

const ANSWER: PddAuthorityUrl = {
  url: 'https://landing.example.invalid/authority/b1-04zzj',
  mobile_short_url: 'https://short.example.invalid/m/b1-04zzj',
};
const LINK = { webUrl: 'https://short.example.invalid/m/b1-04zzj', scheme: null };

type UrlPort = ReturnType<typeof demo>['pddAuthorityUrl'];

function outcome<T>(call: () => Promise<T>): Promise<T | { thrown: unknown }> {
  return Promise.resolve()
    .then(call)
    .catch((thrown: unknown) => ({ thrown }));
}

/** Lets every pending callback and timer-free continuation run. */
async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function linkClient(implementation: UrlPort) {
  const adapter = demo();
  const generate = vi.fn(implementation);
  adapter.pddAuthorityUrl = generate;
  const logger = { warn: vi.fn() };
  const identity = new LinkingUnionIdentity({
    appId: 'synthetic_limit',
    platform: 'pdd',
    promotionSlot: 'synthetic-pid',
    userKey: 'pdd0000a',
    customParameters: { app: 'n', uid: 'pdd0000a', sc: 'self_buy' },
  });
  const call = () =>
    outcome(() =>
      generatePddAuthorityLink(
        { registry: { get: () => adapter }, logger },
        { appId: 'synthetic_limit', identity, traceId: randomUUID(), events: 'linking.test' },
      ),
    );
  return { generate, logger, call };
}

/**
 * A link port whose every call waits on its own gate; counts the calls in flight and the peak.
 * `open(i, answer)` answers call i, `fail(i, error)` makes it reject; `drain()` answers the rest.
 */
function gatedLinks() {
  const gates: PromiseWithResolvers<unknown>[] = [];
  const done = new Set<number>();
  const calls: Promise<unknown>[] = [];
  let inFlight = 0;
  let peak = 0;
  const client = linkClient(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const gate = Promise.withResolvers<unknown>();
    gates.push(gate);
    try {
      return (await gate.promise) as PddAuthorityUrl;
    } finally {
      inFlight -= 1;
    }
  });
  const finish = (index: number, settleGate: (gate: PromiseWithResolvers<unknown>) => void) => {
    const gate = gates[index];
    expect(gate, `link call ${index} reached the port`).toBeDefined();
    if (gate === undefined || done.has(index)) return;
    done.add(index);
    settleGate(gate);
  };
  return {
    client,
    calls,
    start(count: number) {
      for (let i = 0; i < count; i += 1) calls.push(client.call());
    },
    entered: () => gates.length,
    peak: () => peak,
    open(index: number, answer: unknown = ANSWER) {
      finish(index, (gate) => gate.resolve(answer));
    },
    fail(index: number, error: unknown) {
      finish(index, (gate) => gate.reject(error));
    },
    /** Answers every gate (including ones opened while draining) until all calls have ended. */
    async drain() {
      let pending = true;
      const all = Promise.all(calls).finally(() => {
        pending = false;
      });
      while (pending) {
        gates.forEach((gate, index) => {
          if (!done.has(index)) {
            done.add(index);
            gate.resolve(ANSWER);
          }
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      return all;
    },
  };
}

it('[AC-B1-04zzj#20] 拼多多查询占满 8 个名额：生成授权链接等待、不调上游；一个查询结束后它继续并返回链接', async () => {
  const load = await occupyQueries(PDD_QUERY_CONCURRENCY - 1);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const eighth = queryClient(async () => {
    entered.resolve();
    await release.promise;
    return { authorized: true };
  });
  const running = eighth.call();
  const link = linkClient(async () => ANSWER);
  let generated: Promise<unknown> | undefined;
  try {
    await Promise.race([entered.promise, running]);
    expect(load.client.query).toHaveBeenCalledTimes(PDD_QUERY_CONCURRENCY - 1);
    expect(eighth.query).toHaveBeenCalledTimes(1);

    let finished = false;
    generated = link.call().finally(() => {
      finished = true;
    });
    await settle();
    expect(link.generate).not.toHaveBeenCalled();
    expect(finished).toBe(false);

    release.resolve();
    expect(await running).toBe(true);
    expect(await generated).toEqual(LINK);
    expect(link.generate).toHaveBeenCalledTimes(1);
    // Only the eighth query's slot was freed: the seven others are still in flight.
    expect(load.client.query).toHaveBeenCalledTimes(PDD_QUERY_CONCURRENCY - 1);
  } finally {
    release.resolve();
    await running;
    await load.close();
    await generated;
  }
}, 10_000);

it('[AC-B1-04zzj#21] 生成调用自己也受上限：第 9 个等待、在途上游调用从不超过 8；放走一个后第 9 个才调上游；9 个都拿到链接', async () => {
  const links = gatedLinks();
  try {
    links.start(PDD_QUERY_CONCURRENCY + 1);
    await settle();
    expect(links.entered()).toBe(PDD_QUERY_CONCURRENCY);
    expect(links.client.generate).toHaveBeenCalledTimes(PDD_QUERY_CONCURRENCY);
    expect(links.peak()).toBe(PDD_QUERY_CONCURRENCY);

    links.open(0);
    expect(await links.calls[0]).toEqual(LINK);
    await vi.waitFor(
      () => expect(links.client.generate).toHaveBeenCalledTimes(PDD_QUERY_CONCURRENCY + 1),
      { timeout: 2_000, interval: 5 },
    );
    expect(links.peak()).toBe(PDD_QUERY_CONCURRENCY);

    const results = await links.drain();
    expect(results).toEqual(Array.from({ length: PDD_QUERY_CONCURRENCY + 1 }, () => LINK));
    expect(links.peak()).toBe(PDD_QUERY_CONCURRENCY);
  } finally {
    await links.drain();
  }
}, 10_000);

it('[AC-B1-04zzj#22] 共用同一个计数：8 个生成调用在途时，拼多多查询照 B1-06za 立即失败（null、不调上游）；一个生成结束后查询可进', async () => {
  const links = gatedLinks();
  const query = queryClient(async () => ({ authorized: true }));
  try {
    links.start(PDD_QUERY_CONCURRENCY);
    await settle();
    expect(links.entered()).toBe(PDD_QUERY_CONCURRENCY);

    expect(await query.call()).toBeNull();
    expect(query.query).not.toHaveBeenCalled();

    links.open(3);
    expect(await links.calls[3]).toEqual(LINK);
    expect(await query.call()).toBe(true);
    expect(query.query).toHaveBeenCalledTimes(1);
  } finally {
    await links.drain();
  }
}, 10_000);

it('[AC-B1-04zzj#23] 生成失败也释放名额：抛错、答非所问、没有网页地址的 8 个调用都返回 null；之后 8 个查询都能进，第 9 个生成调用仍要等待', async () => {
  const links = gatedLinks();
  let load: Awaited<ReturnType<typeof occupyQueries>> | undefined;
  const waiting = linkClient(async () => ANSWER);
  let generated: Promise<unknown> | undefined;
  try {
    links.start(PDD_QUERY_CONCURRENCY);
    await settle();
    expect(links.entered()).toBe(PDD_QUERY_CONCURRENCY);
    for (let i = 0; i < PDD_QUERY_CONCURRENCY; i += 1) {
      if (i % 3 === 0) {
        links.fail(i, Object.assign(new Error('synthetic link failure'), { code: 'synthetic' }));
      } else if (i % 3 === 1) {
        links.open(i, null);
      } else {
        links.open(i, { short_url: 'https://short.example.invalid/s/b1-04zzj' });
      }
    }
    const results = await Promise.all(links.calls);
    expect(results).toEqual(Array.from({ length: PDD_QUERY_CONCURRENCY }, () => null));

    load = await occupyQueries(PDD_QUERY_CONCURRENCY);
    expect(load.client.query).toHaveBeenCalledTimes(PDD_QUERY_CONCURRENCY);

    generated = waiting.call();
    await settle();
    expect(waiting.generate).not.toHaveBeenCalled();

    await load.close();
    expect(await generated).toEqual(LINK);
    expect(waiting.generate).toHaveBeenCalledTimes(1);
  } finally {
    await load?.close();
    await links.drain();
    await generated;
  }
}, 10_000);
