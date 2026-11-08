import { expect, it, vi } from 'vitest';
import type {
  QuotaLimiter,
  QuotaPurpose,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  classifyUnionError,
  UnionError,
  type CallCtx,
  type UnionAdapter,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { DETAIL } from '../taobao-goods/kit.ts';
import * as refunds from '../taobao-refunds/kit.ts';
import {
  dataokeOuter,
  govern,
  ITEM,
  json,
  KEYWORD,
  LINK,
  live,
  onlineCtx,
  outcome,
  PERMISSION_SUB_CODE,
  topFailure,
  topOk,
  unionFailure,
  type Live,
  type LiveAnswers,
} from './cred-kit.ts';

// 编排者补充第 5–7、9 条：经治理层，两个新码是业务拒绝——幂等读与按次计量路径都只发 1 次上游请求、只扣
// 1 个令牌；同平台同类连续多次也不打开熔断，同类其他方法照常发请求。每条都先跑对照组（upstream_unavailable
// 会重试、会打开熔断），证明计数与熔断在这套装配里确实生效。

type Call = (adapter: UnionAdapter, ctx: CallCtx) => Promise<unknown>;
type Sent = (h: Live) => Live['topTransport'];

const getItem: Call = (adapter, ctx) => adapter.getItem(ITEM, ctx);
const search: Call = (adapter, ctx) => adapter.searchItems({ keyword: KEYWORD }, ctx);
const shareCode: Call = (adapter, ctx) => {
  expect(adapter.taobaoShareCode, 'taobaoShareCode is offered').toBeTypeOf('function');
  return adapter.taobaoShareCode!(LINK, ctx);
};
const viaTop: Sent = (h) => h.topTransport;
const viaDataoke: Sent = (h) => h.dataokeTransport;

const outage = (): ReturnType<typeof json> => json('synthetic outage', 503);
const detailRefused = (method: string) =>
  method === DETAIL ? topFailure(11, PERMISSION_SUB_CODE) : topOk(method);
const detailDown = (method: string) => (method === DETAIL ? outage() : topOk(method));

interface Probe {
  readonly name: string;
  readonly code: UnionErrorCode;
  readonly failing: Partial<LiveAnswers>;
  readonly down: Partial<LiveAnswers>;
  readonly call: Call;
  readonly sent: Sent;
  /** Another method of the same platform, answered by the other gateway or another TOP method. */
  readonly other: Call;
  readonly otherSent: Sent;
}

const PROBES: readonly Probe[] = [
  {
    name: 'getItem 遇 TOP code 11',
    code: 'upstream_misconfigured',
    failing: { top: detailRefused },
    down: { top: detailDown },
    call: getItem,
    sent: viaTop,
    other: shareCode,
    otherSent: viaTop,
  },
  ...(
    [
      [10021, 'upstream_misconfigured'],
      [401, 'upstream_misconfigured'],
      [10072, 'site_auth_invalid'],
      [10211, 'site_auth_invalid'],
    ] as const
  ).map(([code, expected]): Probe => ({
    name: `searchItems 遇大淘客外层 ${code}`,
    code: expected,
    failing: { dataoke: () => dataokeOuter(code) },
    down: { dataoke: outage },
    call: search,
    sent: viaDataoke,
    other: getItem,
    otherSent: viaTop,
  })),
];

const PURPOSES: readonly QuotaPurpose[] = ['online', 'pool_refresh'];
const ROWS = PROBES.flatMap((probe) => PURPOSES.map((purpose) => ({ ...probe, purpose })));

it.each(ROWS)(
  '[AC-B1-04zzzx#8] 治理后 $name（purpose $purpose）→ $code：不重试，只发 1 次上游请求、只扣 1 个令牌（对照：503 重试两次）',
  async (row) => {
    const ctx = onlineCtx(row.purpose);

    const control = live(row.down);
    const controlTake = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    await unionFailure(
      () => row.call(govern(control.adapter, controlTake).adapter, ctx),
      'upstream_unavailable',
    );
    expect(row.sent(control)).toHaveBeenCalledTimes(3);
    expect(controlTake.mock.calls).toEqual([[row.purpose], [row.purpose], [row.purpose]]);

    const h = live(row.failing);
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const error = await outcome(() => row.call(govern(h.adapter, take).adapter, ctx));
    expect(row.sent(h)).toHaveBeenCalledTimes(1);
    expect(take.mock.calls).toEqual([[row.purpose]]);
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: row.code, platform: 'taobao' });
  },
);

it.each([
  [10021, 'upstream_misconfigured'],
  [401, 'upstream_misconfigured'],
  [10072, 'site_auth_invalid'],
  [10210, 'site_auth_invalid'],
] as const)(
  '[AC-B1-04zzzx#9] 按次计量路径（listRefunds 经 gateUpstream）遇大淘客外层 %s → %s：只发 1 次请求、只扣 1 个令牌（对照：503 重试两次）',
  async (code, expected) => {
    const control = refunds.setup(() => refunds.failureReply(503));
    const controlTake = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    await refunds.rejection(
      () => refunds.govern(control.adapter, controlTake).listRefunds?.(refunds.win, refunds.ctx),
      'upstream_unavailable',
    );
    expect(control.transport).toHaveBeenCalledTimes(3);
    expect(controlTake.mock.calls).toEqual([['order_sync'], ['order_sync'], ['order_sync']]);

    const h = refunds.setup(() => dataokeOuter(code));
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const error = await outcome(() =>
      refunds.govern(h.adapter, take).listRefunds?.(refunds.win, refunds.ctx),
    );
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.taobaoTransport).not.toHaveBeenCalled();
    expect(take.mock.calls).toEqual([['order_sync']]);
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: expected, platform: 'taobao' });
  },
);

/** Calls in a row: above the breaker's minimum attempts (20) of the online and offline policies. */
const STREAK = 25;

it.each(ROWS)(
  '[AC-B1-04zzzx#10] 熔断：$purpose 同类连续 25 次「$name」后熔断仍 closed、同平台其他方法照常发请求；对照组同样 25 次 upstream_unavailable 打开熔断',
  async (row) => {
    const ctx = onlineCtx(row.purpose);
    const kind = row.purpose === 'online' ? 'online' : 'offline';

    const control = live(row.down);
    const controlled = govern(control.adapter);
    for (let i = 0; i < STREAK; i += 1) await outcome(() => row.call(controlled.adapter, ctx));
    expect(controlled.governors[kind].breakerState()).toBe('open');
    const controlBefore = row.otherSent(control).mock.calls.length;
    expect(await outcome(() => row.other(controlled.adapter, ctx))).toMatchObject({
      code: 'circuit_open',
    });
    expect(row.otherSent(control).mock.calls.length).toBe(controlBefore);

    const h = live(row.failing);
    const governed = govern(h.adapter);
    const codes: unknown[] = [];
    for (let i = 0; i < STREAK; i += 1) {
      const error = await outcome(() => row.call(governed.adapter, ctx));
      codes.push((error as { code?: unknown } | null)?.code);
    }
    expect(governed.governors[kind].breakerState()).toBe('closed');
    const before = row.otherSent(h).mock.calls.length;
    const answer = await outcome(() => row.other(governed.adapter, ctx));
    expect(answer).not.toBeInstanceOf(Error);
    expect(row.otherSent(h).mock.calls.length).toBe(before + 1);
    expect(codes).toEqual(Array.from({ length: STREAK }, () => row.code));
  },
);

it('[AC-B1-04zzzx#11] classifyUnionError：适配器给出的两个新码归业务拒绝（与 upstream_rejected 同类），upstream_unavailable / rate_limited 仍是故障', async () => {
  const ctx = onlineCtx();
  const searchOver = (dataoke: LiveAnswers['dataoke']) => () =>
    search(live({ dataoke }).adapter, ctx);
  const rejected = await unionFailure(
    searchOver(() => dataokeOuter(10071)),
    'upstream_rejected',
  );
  expect(classifyUnionError(rejected)).toBe('rejected');
  const unavailable = await unionFailure(searchOver(outage), 'upstream_unavailable');
  expect(classifyUnionError(unavailable)).toBe('failure');
  const limited = await unionFailure(
    searchOver(() => dataokeOuter(10013)),
    'rate_limited',
  );
  expect(classifyUnionError(limited)).toBe('failure');

  const misconfigured = await outcome(() =>
    live({ top: detailRefused }).adapter.getItem(ITEM, ctx),
  );
  expect(classifyUnionError(misconfigured)).toBe('rejected');
  expect(misconfigured).toMatchObject({ code: 'upstream_misconfigured' });
  const siteAuth = await outcome(searchOver(() => dataokeOuter(10072)));
  expect(classifyUnionError(siteAuth)).toBe('rejected');
  expect(siteAuth).toMatchObject({ code: 'site_auth_invalid' });
  for (const code of ['upstream_misconfigured', 'site_auth_invalid'] as const) {
    expect(classifyUnionError(new UnionError(code, 'synthetic refusal', 'taobao'))).toBe(
      classifyUnionError(new UnionError('upstream_rejected', 'synthetic refusal', 'taobao')),
    );
  }
});
