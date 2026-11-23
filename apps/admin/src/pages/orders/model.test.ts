// Unit tests of the order helpers (F1-07e): Beijing day bounds, request parameters, basis-point
// percentages, admin amounts and the router state of 【返回】.
import { expect, it } from 'vitest';
import {
  backQueryOf,
  beijingTime,
  dayEnd,
  dayStart,
  dayOf,
  money,
  percent,
  queryFromSearch,
  requestQuery,
  showsPager,
  withoutBackState,
} from './model.ts';

it('[AC-F1-07e-UNIT#1] 付款日期按北京时间：起始日零点含，结束日次日零点不含，跨月跨年', () => {
  expect(dayStart('2026-10-01')).toBe('2026-10-01T00:00:00+08:00');
  expect(dayEnd('2026-10-07')).toBe('2026-10-08T00:00:00+08:00');
  expect(dayEnd('2026-10-31')).toBe('2026-11-01T00:00:00+08:00');
  expect(dayEnd('2026-12-31')).toBe('2027-01-01T00:00:00+08:00');
});

it('[AC-F1-07e-UNIT#2] 请求参数只带已填条件，名称与契约一致', () => {
  expect(requestQuery({ page: 1 })).toEqual({ page: 1, page_size: 20 });
  expect(
    requestQuery({ page: 2, platformStatus: 'SETTLED', flag: 'locked', paidTo: '2026-10-07' }),
  ).toEqual({
    page: 2,
    page_size: 20,
    platform_status: 'SETTLED',
    flag: 'locked',
    paid_to: '2026-10-08T00:00:00+08:00',
  });
});

it('[AC-F1-07e-UNIT#3] 万分之一比例两位百分比、金额后台格式、空值显示短横', () => {
  expect(percent(1234)).toBe('12.34%');
  expect(percent(6000)).toBe('60.00%');
  expect(percent(5)).toBe('0.05%');
  expect(percent(null)).toBe('—');
  expect(money(1234567)).toBe('¥12,345.67');
  expect(money(0)).toBe('¥0.00');
  expect(money(null)).toBe('—');
  expect(beijingTime('2026-10-06T17:05:12Z')).toBe('2026-10-07 01:05:12');
});

it('[AC-F1-07e-UNIT#4] 返回时的路由状态只恢复合法条件', () => {
  expect(backQueryOf(null)).toBeUndefined();
  expect(
    backQueryOf({
      ordersQuery: { page: 3, platform: 'pdd', flag: 'nope', paidFrom: 'x', q: 'A1' },
    }),
  ).toEqual({
    page: 3,
    platform: 'pdd',
    platformStatus: undefined,
    rebateStatus: undefined,
    flag: undefined,
    q: 'A1',
    userId: undefined,
    paidFrom: undefined,
    paidTo: undefined,
  });
});

it('[AC-F1-07ed-UNIT#1] 写地址时去掉旧返回 state，其余历史状态原样保留', () => {
  const back = { usr: { ordersQuery: { page: 2, platform: 'pdd' } }, key: 'k1', idx: 3 };
  expect(withoutBackState(back)).toEqual({ usr: undefined, key: 'k1', idx: 3 });
  expect(withoutBackState({ usr: { ordersQuery: { page: 1 }, other: 1 }, key: 'k2' })).toEqual({
    usr: { other: 1 },
    key: 'k2',
  });
  const plain = { usr: { other: 1 }, key: 'k3' };
  expect(withoutBackState(plain)).toBe(plain);
  expect(withoutBackState(null)).toBeNull();
});

it('[AC-F1-07ed-UNIT#2] 页码超出最后一页（无行但 total>0）时仍显示分页器；没有匹配订单时不显示', () => {
  expect(showsPager({ total: 18 })).toBe(true);
  expect(showsPager({ total: 1 })).toBe(true);
  expect(showsPager({ total: 0 })).toBe(false);
});

it('[AC-F1-07ed-UNIT#3] 地址里的日期只认真实日历日，非法日期忽略、不进请求，其余条件保留', () => {
  expect(dayOf('2026-02-28')).toBe('2026-02-28');
  expect(dayOf('2028-02-29')).toBe('2028-02-29');
  expect(dayOf('2000-02-29')).toBe('2000-02-29');
  expect(dayOf('2026-12-31')).toBe('2026-12-31');
  for (const bad of [
    '2026-13-01',
    '2026-00-10',
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-01-00',
    '2026-01-32',
    '0000-01-01',
    '2026-1-01',
  ])
    expect(dayOf(bad)).toBeUndefined();
  const query = queryFromSearch('?platform=pdd&paid_from=2026-13-01&paid_to=2026-02-30');
  expect(query.platform).toBe('pdd');
  expect(query.paidFrom).toBeUndefined();
  expect(query.paidTo).toBeUndefined();
  expect(requestQuery(query)).toEqual({ page: 1, page_size: 20, platform: 'pdd' });
});
