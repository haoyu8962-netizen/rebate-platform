import { expect, it } from 'vitest';
import {
  at,
  body,
  check,
  compile,
  contract,
  op,
  params,
  response,
  text,
  without,
  yaml,
  type Obj,
} from '../admin-order-actions/kit.ts';

const ordersPath = '/admin/v1/orders';
const countsPath = `${ordersPath}/status-counts`;
const summaryPath = `${ordersPath}/summary`;
const exportsPath = '/admin/v1/exports';
const orderId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';
const userId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const from = '2026-11-20T00:00:00+08:00';
const to = '2026-11-21T00:00:00Z';

type Samples = { good: readonly unknown[]; bad: readonly unknown[] };

const dateSamples = { good: [from, to], bad: ['2026-11-20', '2026-11-20T00:00:00', null] };
const rateSamples = { good: [0, 500, 10000], bad: [-1, 10001, 0.5, '500'] };
const fenSamples = { good: [0, 500], bad: [-1, 0.5, '500'] };
const newFilters = {
  item_id: { good: ['A', 'A'.repeat(64)], bad: ['', 'A'.repeat(65), 123] },
  order_tail: {
    good: ['aZ0129', '012345'],
    bad: ['aZ012', 'aZ01290', 'aZ0-29', 'aZ0中29', 123456],
  },
  title_kw: { good: ['抽纸', '纸'.repeat(32)], bad: ['', '纸', '纸'.repeat(33), 123] },
  rate_bp_min: rateSamples,
  rate_bp_max: rateSamples,
  est_fen_min: fenSamples,
  est_fen_max: fenSamples,
  received_from: dateSamples,
  received_to: dateSamples,
} satisfies Record<string, Samples>;

const rebateStatuses = ['UNATTRIBUTED', 'ESTIMATED', 'WAITING', 'CREDITED', 'VOID', 'CLAWED_BACK'];
const commonFilters = {
  platform: { good: ['pdd', 'taobao'], bad: ['unknown'] },
  platform_status: { good: ['PAID', 'RECEIVED'], bad: ['ESTIMATED'] },
  flag: { good: ['locked', 'status_locked', 'rights_pending', 'hold'], bad: ['unknown'] },
  user_id: { good: [userId], bad: ['', 123] },
  q: { good: ['231006-1234567891'], bad: [123] },
  paid_from: dateSamples,
  paid_to: dateSamples,
};
const listFilters = {
  ...commonFilters,
  rebate_status: { good: rebateStatuses, bad: ['PAID', 'unknown'] },
  ...newFilters,
};
const pagination = {
  page: { good: [1, 2], bad: [0, 1.5] },
  page_size: { good: [1, 200], bad: [0, 201, 1.5] },
};

const oldRow = {
  order_id: orderId,
  sub_order_id: '231006-1234567891',
  parent_order_id: '231006-1234567890',
  platform: 'pdd',
  title: '抽纸',
  image_url: 'https://img.example.com/p/a1.jpg',
  user: { user_id: userId, phone_masked: '138****5678' },
  paid_at: from,
  pay_amount_fen: 3990,
  est_commission_fen: 500,
  settle_commission_fen: null,
  platform_status: 'RECEIVED',
  rebate_status: 'WAITING',
  hold_reason: null,
  flags: { locked: false, status_locked: false, rights_pending: false, hold: false },
};

function envelope(data: unknown): Obj {
  return { code: 0, msg: '', data, trace_id: 'ct-24x-orders' };
}

function checkQuery(doc: Obj, path: string, samples: Record<string, Samples>): void {
  const query = new Map(
    params(doc, path, 'get')
      .filter((parameter) => parameter['in'] === 'query')
      .map((parameter) => [text(parameter['name']), parameter]),
  );
  expect([...query.keys()].toSorted(), `${path} 的查询参数`).toEqual(
    Object.keys(samples).toSorted(),
  );
  for (const [name, { good, bad }] of Object.entries(samples)) {
    const parameter = query.get(name);
    expect(parameter?.['required'], `${path} 的 ${name} 可省略`).not.toBe(true);
    const validate = compile(doc, at(parameter, 'schema'));
    for (const value of good) {
      expect(validate(value), `${name}=${JSON.stringify(value)}`).toBe(true);
    }
    for (const value of bad) {
      expect(validate(value), `${name}=${JSON.stringify(value)}`).toBe(false);
    }
  }
}

function checkPlannedOperation(doc: Obj, path: string, operationId: string): void {
  expect(op(doc, path, 'get')).toMatchObject({
    operationId,
    'x-auth': 'admin',
    'x-implementation': 'planned',
  });
}

it('[AC-CT-24x-FILTER#1] 列表筛选的边界、可选性和错误码', () => {
  const doc = contract();
  const operation = op(doc, ordersPath, 'get');
  expect(operation['operationId']).toBe('adminListOrders');
  expect(operation['x-error-codes']).toContain(20001);
  expect(params(doc, ordersPath, 'get')).toContainEqual(
    expect.objectContaining({ name: 'X-Trace-Id', in: 'header' }),
  );
  checkQuery(doc, ordersPath, { ...listFilters, ...pagination });
});

it('[AC-CT-24x-ROW#1] 保留旧订单行，新增字段可省略', () => {
  const doc = contract();
  const validateRow = compile(doc, at(doc, 'components', 'schemas', 'AdminOrderListItem'));
  const validateResponse = compile(doc, response(doc, ordersPath, 'get'));
  const newFields = { item_id: 'product-123', commission_rate_bp: 500, received_at: to };
  const nullableFields = { commission_rate_bp: null, received_at: null };
  const extended = { ...oldRow, ...newFields };

  check(validateRow, oldRow, true);
  check(validateRow, extended, true);
  check(validateRow, { ...extended, ...nullableFields }, true);
  for (const key of Object.keys(newFields)) check(validateRow, without(extended, key), true);
  for (const key of Object.keys(oldRow)) check(validateRow, without(extended, key), false);

  const listBody = (items: Obj[]) =>
    envelope({ items, page: 1, page_size: 20, total: items.length });
  check(validateResponse, listBody([oldRow, extended]), true);
  for (const badFields of [
    { item_id: 123 },
    { item_id: null },
    { commission_rate_bp: '500' },
    { commission_rate_bp: 0.5 },
    { received_at: '2026-11-21' },
  ]) {
    const invalid = { ...extended, ...badFields };
    check(validateRow, invalid, false);
    check(validateResponse, listBody([oldRow, invalid]), false);
  }
});

it('[AC-CT-24x-SCOPE#1] 列表支持商品筛选和商品 ID，排除店铺和标签', () => {
  const doc = contract();
  const names = params(doc, ordersPath, 'get').map((parameter) => parameter['name']);
  expect(names).toContain('item_id');
  expect(names).not.toContain('shop_kw');
  expect(names).not.toContain('shop_name');

  const validate = compile(doc, at(doc, 'components', 'schemas', 'AdminOrderListItem'));
  const row = { ...oldRow, item_id: 'product-123' };
  check(validate, row, true);
  check(validate, { ...row, shop_name: '示例店铺' }, false);
  check(validate, { ...row, tags: ['示例标签'] }, false);
});

it('[AC-CT-24x-COUNT#1] 状态计数的计划标记、鉴权和筛选', () => {
  const doc = contract();
  checkPlannedOperation(doc, countsPath, 'adminCountOrdersByStatus');
  checkQuery(doc, countsPath, { ...commonFilters, ...newFilters });
});

it('[AC-CT-24x-COUNT#2] 状态计数接受列表返利状态与非负整数', () => {
  const doc = contract();
  const validate = compile(doc, response(doc, countsPath, 'get'));
  const items = rebateStatuses.map((rebate_status, count) => ({ rebate_status, count }));
  const item = { rebate_status: 'WAITING', count: 2 };
  const data = { items: [item], total: 2 };

  check(validate, envelope({ items, total: 15 }), true);
  check(validate, envelope({ items: [], total: 0 }), true);
  check(validate, without(envelope(data), 'data'), false);
  check(validate, envelope({ ...data, items: item }), false);
  for (const value of [-1, 0.5, '2', null]) {
    check(validate, envelope({ ...data, total: value }), false);
    check(validate, envelope({ ...data, items: [item, { ...item, count: value }] }), false);
  }
  for (const value of ['PAID', 'unknown', null]) {
    check(validate, envelope({ ...data, items: [{ ...item, rebate_status: value }] }), false);
  }
  for (const key of Object.keys(data)) check(validate, envelope(without(data, key)), false);
  for (const key of Object.keys(item)) {
    check(validate, envelope({ ...data, items: [without(item, key)] }), false);
  }
});

it('[AC-CT-24x-SUMMARY#1] 汇总的计划标记、鉴权和筛选', () => {
  const doc = contract();
  checkPlannedOperation(doc, summaryPath, 'adminSummarizeOrders');
  checkQuery(doc, summaryPath, listFilters);
});

it('[AC-CT-24x-SUMMARY#2] 汇总只接受规定的五个非负整数', () => {
  const doc = contract();
  const validate = compile(doc, response(doc, summaryPath, 'get'));
  const data = {
    sub_order_count: 3,
    pay_amount_fen: 5490,
    est_commission_fen: 680,
    platform_retain_fen: 120,
    buyer_count: 2,
  };
  check(validate, envelope(data), true);
  check(validate, envelope(Object.fromEntries(Object.keys(data).map((key) => [key, 0]))), true);
  check(validate, without(envelope(data), 'data'), false);
  for (const key of Object.keys(data)) {
    check(validate, envelope(without(data, key)), false);
    for (const value of [-1, 0.5, '1', null]) {
      check(validate, envelope({ ...data, [key]: value }), false);
    }
  }
  for (const key of ['effective_pay_amount_fen', 'est_profit_fen', 'unexpected']) {
    check(validate, envelope({ ...data, [key]: 1 }), false);
  }
});

it('[AC-CT-24x-EXPORT#1] 导出来源枚举登记 orders', () => {
  const adminEnums = yaml('contracts/enums/admin.yaml');
  expect(at(adminEnums, 'enums', 'export_resource', 'values')).toHaveProperty('orders');
});

it('[AC-CT-24x-EXPORT#2] 订单导出沿用列表筛选且不分页', () => {
  const doc = contract();
  expect(op(doc, exportsPath)['operationId']).toBe('adminCreateExport');
  const validate = compile(doc, body(doc, exportsPath));
  const request = (filters: Obj) => ({ resource: 'orders', filters });
  check(validate, request({}), true);
  for (const [name, { good, bad }] of Object.entries(listFilters)) {
    for (const value of good) check(validate, request({ [name]: value }), true);
    for (const value of bad) check(validate, request({ [name]: value }), false);
  }
  for (const key of Object.keys(pagination)) {
    check(validate, request({ [key]: 1 }), false);
  }
});

it('[AC-CT-24x-EXPORT#3] 订单导出可附带 1–200 个 UUID', () => {
  const doc = contract();
  const validate = compile(doc, body(doc, exportsPath));
  const ids = Array.from(
    { length: 201 },
    (_, index) => `0199a3b4-5c6d-7e8f-9a0b-${String(index).padStart(12, '0')}`,
  );
  const request = (order_ids: unknown) => ({
    resource: 'orders',
    filters: { order_ids, order_tail: 'aZ0129', rebate_status: 'WAITING' },
  });

  check(validate, request([orderId]), true);
  check(validate, request(ids.slice(0, 200)), true);
  for (const value of [[], ids, [orderId, 'not-a-uuid'], orderId]) {
    check(validate, request(value), false);
  }
});
