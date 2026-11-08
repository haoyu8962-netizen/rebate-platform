import { expect, it, vi } from 'vitest';
import type {
  QuotaLimiter,
  QuotaPurpose,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { governAdapter } from '../../../../apps/api/src/modules/union/application/governed-adapter.ts';
import {
  UnionError,
  type CallCtx,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { outcome, scheduler } from '../cred-class/cred-kit.ts';
import { endpoint as jdEndpoint, response } from '../jd-core/kit.ts';
import * as jdGoods from '../jd-goods/kit.ts';
import { endpoint as pddEndpoint } from '../pdd-core/kit.ts';
import * as pddGoods from '../pdd-goods/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzc#n]) name this task's acceptance points, not business rules.
// D10-1073 / 编排者补充第 6 点：经治理层，京东内层 403 与拼多多 20031 是业务拒绝——幂等读只发 1 次、只扣
// 1 个令牌；同平台同类连续多次也不打开熔断，同平台其他方法照常发请求。每条先跑对照组（upstream_unavailable
// 会重试、会打开熔断），证明计数与熔断在这套装配里确实生效。写法照 cred-class/governance.test.ts。

type Kind = 'refused' | 'down';

interface Harness {
  readonly adapter: UnionAdapter;
  /** Upstream requests of the failing method (getItem) and of the other method (searchItems). */
  readonly failingSent: () => number;
  readonly otherSent: () => number;
}

interface Probe {
  readonly name: string;
  readonly endpoint: UnionEndpoint;
  readonly build: (kind: Kind) => Harness;
  readonly call: (adapter: UnionAdapter, ctx: CallCtx) => Promise<unknown>;
  readonly other: (adapter: UnionAdapter, ctx: CallCtx) => Promise<unknown>;
  readonly baseCtx: CallCtx;
}

/** JD goods.query: the detail (itemIds) answers inner 403 or HTTP 503; the search answers a row. */
function jdHarness(kind: Kind): Harness {
  let detail = 0;
  let search = 0;
  const h = jdGoods.wire((body) => {
    if (body.itemIds !== undefined) {
      detail += 1;
      return kind === 'refused' ? jdGoods.reply(jdGoods.failure('403')) : response({}, 503);
    }
    search += 1;
    return jdGoods.listing([jdGoods.row()]);
  });
  return { adapter: h.adapter, failingSent: () => detail, otherSent: () => search };
}

/** PDD: goods.detail answers 20031 or 52102 (upstream_unavailable); goods.search answers a row. */
function pddHarness(kind: Kind): Harness {
  let detail = 0;
  let search = 0;
  const h = pddGoods.setup((body) => {
    if (body.type === pddGoods.detail) {
      detail += 1;
      return { error_response: { error_code: kind === 'refused' ? 20031 : 52102 } };
    }
    search += 1;
    return pddGoods.envelope(body.type, [pddGoods.row()]);
  });
  return { adapter: h.adapter, failingSent: () => detail, otherSent: () => search };
}

const PROBES: readonly Probe[] = [
  {
    name: '京东 getItem 遇内层 403',
    endpoint: jdEndpoint,
    build: jdHarness,
    call: (adapter, ctx) => adapter.getItem(jdGoods.itemRef, ctx),
    other: (adapter, ctx) => adapter.searchItems({ keyword: '合成关键词' }, ctx),
    baseCtx: jdGoods.ctx,
  },
  {
    name: '拼多多 getItem 遇 20031',
    endpoint: pddEndpoint,
    build: pddHarness,
    call: (adapter, ctx) => adapter.getItem(pddGoods.ref, ctx),
    other: (adapter, ctx) => adapter.searchItems({ keyword: '合成关键词' }, ctx),
    baseCtx: pddGoods.ctx,
  },
];

const PURPOSES: readonly QuotaPurpose[] = ['online', 'pool_refresh'];
const ROWS = PROBES.flatMap((probe) => PURPOSES.map((purpose) => ({ ...probe, purpose })));
const CODE: UnionErrorCode = 'upstream_misconfigured';

function govern(row: Probe, adapter: UnionAdapter, take: QuotaLimiter['tryAcquire'] = () => true) {
  return governAdapter(adapter, {
    endpoint: row.endpoint,
    scheduler,
    quota: { bucketKey: row.endpoint.quotaKey, tryAcquire: take },
  });
}

it.each(ROWS)(
  '[AC-B1-04zzzzc#19] 治理后 $name（purpose $purpose）→ upstream_misconfigured：不重试，只发 1 次上游请求、只扣 1 个令牌（对照：upstream_unavailable 重试两次）',
  async (row) => {
    const ctx: CallCtx = { ...row.baseCtx, purpose: row.purpose };

    const h = row.build('refused');
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const error = await outcome(() => row.call(govern(row, h.adapter, take).adapter, ctx));
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: CODE });
    expect(h.failingSent()).toBe(1);
    expect(take.mock.calls).toEqual([[row.purpose]]);

    const control = row.build('down');
    const controlTake = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const unavailable = await outcome(() =>
      row.call(govern(row, control.adapter, controlTake).adapter, ctx),
    );
    expect(unavailable).toMatchObject({ code: 'upstream_unavailable' });
    expect(control.failingSent()).toBe(3);
    expect(controlTake.mock.calls).toEqual([[row.purpose], [row.purpose], [row.purpose]]);
  },
);

/** Calls in a row: above the breaker's minimum attempts (20) of the online and offline policies. */
const STREAK = 25;

it.each(ROWS)(
  '[AC-B1-04zzzzc#20] 熔断：$purpose 连续 25 次「$name」后熔断仍 closed、同平台其他方法照常发请求；对照组同样 25 次 upstream_unavailable 打开熔断',
  async (row) => {
    const ctx: CallCtx = { ...row.baseCtx, purpose: row.purpose };
    const kind = row.purpose === 'online' ? 'online' : 'offline';

    const h = row.build('refused');
    const governed = govern(row, h.adapter);
    const codes: unknown[] = [];
    for (let i = 0; i < STREAK; i += 1) {
      const error = await outcome(() => row.call(governed.adapter, ctx));
      codes.push((error as { code?: unknown } | null)?.code);
    }
    expect(codes).toEqual(Array.from({ length: STREAK }, () => CODE));
    expect(h.failingSent()).toBe(STREAK);
    expect(governed.governors[kind].breakerState()).toBe('closed');
    const before = h.otherSent();
    const answer = await outcome(() => row.other(governed.adapter, ctx));
    expect(answer).not.toBeInstanceOf(Error);
    expect(h.otherSent()).toBe(before + 1);

    const control = row.build('down');
    const controlled = govern(row, control.adapter);
    for (let i = 0; i < STREAK; i += 1) await outcome(() => row.call(controlled.adapter, ctx));
    expect(controlled.governors[kind].breakerState()).toBe('open');
    const controlBefore = control.otherSent();
    expect(await outcome(() => row.other(controlled.adapter, ctx))).toMatchObject({
      code: 'circuit_open',
    });
    expect(control.otherSent()).toBe(controlBefore);
  },
);
