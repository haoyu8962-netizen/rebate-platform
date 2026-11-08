// B1-14d / D10-10：进程内组合验收，不是平台录制或 WireMock 演练。
// QA-05a 仅提供故障；成功、业务拒绝及成功延迟均为明确标注的独立合成夹具。
// 登记表的工厂和类型都只从 platform 公共出口取；不替换 governor 或 PddUnionAdapter。
import { expect, vi } from 'vitest';
import {
  createResilienceRegistry,
  FixedClock,
  GovernanceError,
  type PolicyOverride,
  type QuotaPurpose,
  type ResilienceRegistry,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  UnionError,
  type GovernedAdapterOptions,
  type UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { buildMappings, type StubResponse } from '../../../../infra/fault/fault.ts';
import { ManualScheduler, observe, type Observed } from '../../platform/http/kit.ts';
import { envelope, row, instant, identity as queryIdentity } from '../pdd-goods/kit.ts';
import { ctx, endpoint, identity, req } from '../pdd-convert/kit.ts';

export { observe, GovernanceError };
export type { Observed };
export type Fault = 'timeout' | 'rate_limited' | 'server_error' | 'connection_reset';
export type Reply =
  | { readonly kind: 'fault'; readonly response: StubResponse }
  | { readonly kind: 'success'; readonly delayMs: number }
  | { readonly kind: 'business_rejected' };

export function fault(scenario: Fault): Reply {
  const mapping = buildMappings('union.pdd').find(
    (entry) => entry.name === `union.pdd.${scenario}.header`,
  );
  expect(mapping, `QA-05a 缺少 union.pdd.${scenario}`).toBeDefined();
  return { kind: 'fault', response: mapping!.response };
}

/** 独立合成成功信封，沿用 pdd-goods 已有字段；不冒称 QA-05a 有成功场景。 */
export function success(delayMs = 0): Reply {
  return { kind: 'success', delayMs };
}

/** 合成业务拒绝：20031 属业务拒绝类（不重试、不计熔断） */
export function rejected(): Reply {
  return { kind: 'business_rejected' };
}

export const fastPolicy = {
  timeoutMs: 80,
  retries: { maxRetries: 0, baseDelayMs: 17, maxDelayMs: 25 },
  breaker: { windowMs: 600, minRequests: 2, failureRatePercent: 50, openMs: 120 },
} as const;

export function registry(override: PolicyOverride = {}): ResilienceRegistry {
  return createResilienceRegistry({
    'union.search': {
      timeoutMs: override.timeoutMs ?? fastPolicy.timeoutMs,
      retries: { ...fastPolicy.retries, ...override.retries },
      breaker: { ...fastPolicy.breaker, ...override.breaker },
    },
    // 故意与 search 不同，防止误取 tpwd_parse 行。
    'union.tpwd_parse': { timeoutMs: 41, retries: { maxRetries: 1 } },
  });
}

export function rig(resilience: ResilienceRegistry | undefined, initial: Reply) {
  const scheduler = new ManualScheduler();
  const clock = new FixedClock(instant);
  const upstream = { reply: initial };
  const calledAt: number[] = [];
  const take = vi.fn<(purpose: QuotaPurpose) => boolean>(() => true);
  const transport = vi.fn<UnionTransport>(async (request) => {
    calledAt.push(scheduler.now());
    const reply = upstream.reply;
    if (reply.kind === 'fault') {
      const response = reply.response;
      if (response.fault !== undefined) {
        expect(response.fault).toBe('CONNECTION_RESET_BY_PEER');
        throw new UnionError('upstream_unavailable', 'synthetic connection reset', 'pdd');
      }
      if (response.fixedDelayMilliseconds !== undefined) {
        await scheduler.sleep(response.fixedDelayMilliseconds, request.signal);
      }
      // 429 / 5xx 原样交给真实适配器；不捏造平台错误信封替换 QA-05a 的空响应。
      return {
        status: response.status ?? 200,
        headers: response.headers ?? {},
        body:
          response.jsonBody === undefined
            ? (response.body ?? '')
            : JSON.stringify(response.jsonBody),
      };
    }
    if (reply.kind === 'business_rejected') {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ error_response: { error_code: 20031 } }),
      };
    }
    if (reply.delayMs > 0) await scheduler.sleep(reply.delayMs, request.signal);
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    return { status: 200, headers: {}, body: JSON.stringify(envelope(body.type, [row()])) };
  });
  const adapter = new PddUnionAdapter({
    clock,
    endpoint,
    transport,
    credentials: async () => ({ clientId: 'fake-client', clientSecret: 'fake-value' }),
    queryIdentity: async () => queryIdentity,
  });
  // 结构类型让旧接口忽略新增可选参数后自然断言红，不修改已有实现来制造红。
  // 实现阶段应把 resilience?: ResilienceRegistry 加入 GovernedAdapterOptions。
  const options: GovernedAdapterOptions & { readonly resilience?: ResilienceRegistry } = {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
    ...(resilience === undefined ? {} : { resilience }),
  };
  const governed = createGovernedAdapter(adapter, options);
  return {
    scheduler,
    clock,
    upstream,
    transport,
    take,
    calledAt,
    async advance(ms: number) {
      await scheduler.advance(ms);
      clock.advanceMs(ms);
    },
    search(purpose: QuotaPurpose = 'online') {
      return observe(
        Promise.resolve().then(() =>
          governed.searchItems({ keyword: '合成商品' }, { ...ctx, purpose }),
        ),
      );
    },
    convert() {
      return observe(Promise.resolve().then(() => governed.convert(req, identity, ctx)));
    },
  };
}

export type Rig = ReturnType<typeof rig>;

export function expectFault(result: Observed<unknown>, scenario: Fault): void {
  expect(result.settled).toBe('rejected');
  if (scenario === 'timeout') {
    expect(result.error).toBeInstanceOf(GovernanceError);
    expect(result.error).toMatchObject({ code: 'timeout' });
  } else {
    expect(result.error).toBeInstanceOf(UnionError);
    // 当前 PDD 解包器把 QA-05a 空体 429 归为 upstream_unavailable；两者都计入熔断。
    const allowed =
      scenario === 'rate_limited'
        ? ['rate_limited', 'upstream_unavailable']
        : ['upstream_unavailable'];
    expect(allowed).toContain((result.error as UnionError).code);
  }
}

export function expectOpen(result: Observed<unknown>): void {
  expect(result.settled).toBe('rejected');
  expect(result.error).toBeInstanceOf(GovernanceError);
  expect(result.error).toMatchObject({ code: 'circuit_open', dependency: 'union:pdd:online' });
}

export async function trip(r: Rig, scenario: Fault = 'server_error'): Promise<void> {
  r.upstream.reply = fault(scenario);
  for (let attempt = 0; attempt < fastPolicy.breaker.minRequests; attempt += 1) {
    const result = r.search();
    await r.advance(scenario === 'timeout' ? fastPolicy.timeoutMs : 0);
    expectFault(result, scenario);
  }
  const before = r.transport.mock.calls.length;
  const quotaBefore = r.take.mock.calls.length;
  const blocked = r.search();
  await r.advance(0);
  expectOpen(blocked);
  expect(r.transport).toHaveBeenCalledTimes(before);
  expect(r.take).toHaveBeenCalledTimes(quotaBefore);
}
