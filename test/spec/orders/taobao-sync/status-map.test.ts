// BR-FUND-02 / CAP-TB-07（D10-741 ①）：specs/order-status-map/taobao.csv 恰好四行——12 付款、14 确认收货、
// 3 结算成功、13 关闭（失效），source doc、verified false；11（拍下未付款）只是请求参数，不入表。表外码一律
// 交调用方按「映射表之外」处理：未入账订单状态不变、其余列照写、待处理 UNMAPPED_STATUS（hold 由
// settlement 经端口决定）；已入账订单整条拒收。读的是真实文件、经真实 loadStatusMap。
import { expect, it } from 'vitest';
import { mapPlatformStatus } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { planOrderUpdate } from '../../../../apps/api/src/modules/orders/domain/update-plan.ts';
import { HEADER } from '../status-map/fixtures.ts';
import {
  EARNING_AT,
  TAOBAO_ROWS,
  requiredTaobaoCsv,
  taobaoMap,
  taobaoOrder,
} from './taobao-sync-kit.ts';

it('[AC-B1-04zzb#1] BR-FUND-02：taobao.csv 表头照旧、恰好 12 / 14 / 3 / 13 四行，均为 doc、未实测', () => {
  const csv = requiredTaobaoCsv();
  const [header, ...lines] = csv.trimEnd().split(/\r?\n/);
  expect(header).toBe(HEADER);
  // 独立检查资产本身，避免加载器碰巧给出正确结果时掩盖文件里的错码或错来源。
  expect(lines).toHaveLength(TAOBAO_ROWS.length);
  for (const [code, event] of TAOBAO_ROWS) {
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${code},${event},doc,false,\\S`)),
      ]),
    );
  }
  const map = taobaoMap();
  expect(map.platform).toBe('taobao');
  expect([...map.entries.keys()].sort()).toEqual(TAOBAO_ROWS.map(([code]) => code).sort());
  for (const [code, event] of TAOBAO_ROWS) {
    expect(map.entries.get(code), code).toEqual({
      event,
      source: 'doc',
      verified: false,
      note: expect.stringMatching(/\S/),
    });
  }
});

it.each(TAOBAO_ROWS)(
  '[AC-B1-04zzb#2] BR-FUND-02：淘宝 tk_status %s → %s，保留未验证标记',
  (rawCode, event) => {
    expect(mapPlatformStatus(taobaoMap(), rawCode)).toEqual({
      kind: 'event',
      event,
      verified: false,
    });
  },
);

it('[AC-B1-04zzb#3] CAP-TB-07：11 只是请求取值不入表；表里没有处罚码，只有 3 算已结算、14 不算', () => {
  const map = taobaoMap();
  expect(map.entries.has('11')).toBe(false);
  expect(
    [...map.entries].filter(([, entry]) => entry.event === 'PLATFORM_SETTLED').map(([c]) => c),
  ).toEqual(['3']);
  expect([...map.entries].filter(([, entry]) => entry.event === 'PLATFORM_PUNISH')).toEqual([]);
  expect([...map.entries].filter(([, entry]) => entry.event === 'PLATFORM_RIGHTS')).toEqual([]);
});

it.each(['11', '99', '1', '2', '4', '012', '3.0', ' 3', '', 'PLATFORM_PAID', null])(
  '[AC-B1-04zzb#4] BR-FUND-02：淘宝表外码 %j 不猜事件，保留原码交调用方按 UNMAPPED_STATUS 处理',
  (rawCode) => {
    expect(mapPlatformStatus(taobaoMap(), rawCode)).toEqual({ kind: 'unmapped', rawCode });
  },
);

it.each(['11', '99'])(
  '[AC-B1-04zzb#5] BR-FUND-02：适配器给出的表外码 %s：未入账订单状态不变、待处理 UNMAPPED_STATUS；已入账订单整条拒收',
  async (tkStatus) => {
    const map = taobaoMap();
    const order = await taobaoOrder(tkStatus);
    expect(order.raw_status).toBe(tkStatus);
    for (const rebate of ['ESTIMATED', 'WAITING']) {
      const plan = planOrderUpdate(
        { platform_status: 'PAID', rebate_status: rebate, received_at: null },
        order,
        map,
        false,
      );
      expect(plan, rebate).toMatchObject({
        kind: 'update',
        platform_status: 'PAID',
        pending: 'UNMAPPED_STATUS',
        history: [],
        event: null,
      });
    }
    const booked = planOrderUpdate(
      { platform_status: 'RECEIVED', rebate_status: 'CREDITED', received_at: EARNING_AT },
      order,
      map,
      false,
    );
    expect(booked).toMatchObject({
      kind: 'pending',
      platform_status: 'RECEIVED',
      pending: 'UNMAPPED_STATUS',
      history: [],
    });
  },
);
