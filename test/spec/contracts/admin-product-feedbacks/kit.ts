// CT-26x 商品反馈后台只读列表的契约登记（D10-757、S-16）。独立预期来自任务书第 9 节，不从契约生成；
// 全部静态读 contracts 与 specs，不连库、不 listen。
import { expect } from 'vitest';
import { at, list, object, op, resolve, text, yaml, type Obj } from '../admin-order-actions/kit.ts';

export const path = '/admin/v1/product-feedbacks';
export const operationId = 'adminListProductFeedbacks';
export const permission = 'feedback.view';
export const reasons = ['price', 'rebate', 'info', 'other'];
export const itemKeys = [
  'id',
  'platform',
  'product_key',
  'item_ref',
  'link_id',
  'shown_final_price_fen',
  'shown_rebate_fen',
  'quoted_at',
  'reason',
  'note',
  'user_id',
  'created_at',
];
// 不得出现在列表项里的个人信息与内部字段（手机号、昵称、设备标识、app_id）。
export const forbiddenKey = /phone|mobile|nick|device|app_id|appid/i;
// 提交时间区间的合法与不合法取值。
export const goodTimes = ['2026-11-05T00:00:00+08:00', '2026-11-05T12:30:00Z'];
export const badTimes = ['2026-11-05', '2026-11-05 12:30:00', 'yesterday', 1, null];

export const guestItem = {
  id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f7a01',
  platform: 'pdd',
  product_key: 'pdd:1234567890',
  item_ref: null,
  link_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f7b01',
  shown_final_price_fen: 1990,
  shown_rebate_fen: null,
  quoted_at: '2026-11-05T10:00:00+08:00',
  reason: 'price',
  note: null,
  user_id: null,
  created_at: '2026-11-05T10:01:00+08:00',
};
export const memberItem = {
  ...guestItem,
  id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f7a02',
  platform: 'taobao',
  product_key: 'tb:6543210',
  item_ref: 'opaque-item-ref',
  shown_rebate_fen: 120,
  reason: 'rebate',
  note: '返利和页面上写的不一样',
  user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04',
};

export function operation(doc: Obj): Obj {
  return op(doc, path, 'get');
}

// 原样的参数项（含 path item 级），不解析 $ref；用于核对是否引用了现有组件。
export function rawParams(doc: Obj): Obj[] {
  const pathItem = at(doc, 'paths', path);
  return [...list(pathItem['parameters'] ?? []), ...list(operation(doc)['parameters'] ?? [])].map(
    object,
  );
}

export function param(doc: Obj, name: string): Obj {
  const matches = rawParams(doc)
    .map((raw) => resolve(doc, raw))
    .filter((entry) => entry['name'] === name);
  expect(matches, `参数 ${name}`).toHaveLength(1);
  return matches[0]!;
}

export function permissionEntries(): Obj[] {
  return list(yaml('specs/permissions.yaml')['permissions']).map(object);
}

export function adminPermissionValues(): Obj {
  return at(yaml('contracts/enums/admin.yaml'), 'enums', 'admin_permission', 'values');
}

export function descriptionOf(doc: Obj): string {
  return text(operation(doc)['description']);
}
