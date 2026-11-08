import { expect, it, vi } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import { unwrapPddResponse } from './response.ts';

const method = 'pdd.ddk.order.detail.get';

function wire(body: unknown, status = 200) {
  return { status, headers: {}, body: JSON.stringify(body) };
}

function failure(run: () => unknown): UnionError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04g-UNIT#4] 按登记的外层键解包，不看别的键', () => {
  expect(unwrapPddResponse(method, wire({ order_detail_response: { a: 1 } }))).toEqual({ a: 1 });
  expect(failure(() => unwrapPddResponse(method, wire({ x_response: {} }))).code).toBe(
    'upstream_unavailable',
  );
});

it('[AC-B1-04g-UNIT#5] 未登记接口与原型链上的名字都是 adapter_unimplemented', () => {
  for (const name of ['pdd.ddk.goods.unregistered.example', 'constructor', '__proto__']) {
    expect(failure(() => unwrapPddResponse(name, wire({}))).code).toBe('adapter_unimplemented');
  }
});

it('[AC-B1-04g-UNIT#6] error_response 分类且错误信息不带 error_msg / sub_msg', () => {
  const warn = vi.fn();
  const error = failure(() =>
    unwrapPddResponse(
      method,
      wire({
        error_response: { error_code: '20005', sub_code: 'S1', error_msg: 'm-x', sub_msg: 's-x' },
      }),
      warn,
    ),
  );
  expect(error).toMatchObject({ code: 'upstream_misconfigured', platform: 'pdd' });
  expect(error.message).toContain('20005');
  expect(error.message).toContain('S1');
  expect(error.message).not.toContain('m-x');
  expect(error.message).not.toContain('s-x');
  expect(warn).toHaveBeenCalledWith({ error_code: '20005', type: method });
  expect(
    failure(() => unwrapPddResponse(method, wire({ error_response: { error_code: 70031 } }))).code,
  ).toBe('rate_limited');
  expect(failure(() => unwrapPddResponse(method, wire({ error_response: null }))).code).toBe(
    'upstream_rejected',
  );
});

it('[AC-B1-04g-UNIT#7] HTTP 5xx 与非 JSON 都是 upstream_unavailable', () => {
  expect(
    failure(() => unwrapPddResponse(method, wire({ order_detail_response: {} }, 502))).code,
  ).toBe('upstream_unavailable');
  expect(
    failure(() => unwrapPddResponse(method, { status: 200, headers: {}, body: '<html>' })).code,
  ).toBe('upstream_unavailable');
});
