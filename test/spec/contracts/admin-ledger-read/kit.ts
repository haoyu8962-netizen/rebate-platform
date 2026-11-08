// CT-24zzc 后台用户余额与流水只读接口的契约登记（F-ADM-04；BR-FUND-13、BR-FUND-15、BR-FUND-16、
// BR-FUND-18；D10-1049 ③、D10-1050 ②、D10-1057）。独立预期来自任务书第 9 节，不从契约生成；
// 全部静态读 contracts 与生成物，不连库、不 listen。
import { expect } from 'vitest';
import {
  at,
  check,
  compile,
  list,
  object,
  op,
  resolve,
  response,
  text,
  yaml,
  type Obj,
} from '../admin-order-actions/kit.ts';
import { bindings } from '../order-claims/source-kit.ts';

export const summaryPath = '/admin/v1/users/{user_id}/fund-summary';
export const ledgerPath = '/admin/v1/ledger';
export const summaryId = 'adminGetUserFundSummary';
export const ledgerId = 'adminListLedgerEntries';
export const routes = [
  [summaryPath, summaryId],
  [ledgerPath, ledgerId],
] as const;
export const errorCodes = [10001, 10403, 20001];
export const permissions = ['fund.view', 'user.lookup'];
// D10-1057 ① 选 A：两个接口对谁都不含的键（任意层级）。
export const forbiddenKeys = [
  'memo',
  'operator',
  'note',
  'reject_note',
  'source_ref',
  'created_by',
];

// contracts/enums/fund.yaml 的 ledger_type（BR-FUND-15，13 种）与 withdraw_hold_kind。
export const ledgerTypes = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
];
export const subAccounts = ['available', 'frozen'];
export const holdKinds = ['manual', 'recon_diff', 'ledger_mismatch', 'manual_failed_watch'];
export const linkTypes = ['order', 'withdrawal', 'adjustment', 'writeoff'];

// 后台成功信封（照 AdminUserDevicePageResponse）：最外层同样封闭。
export const envelopeKeys = ['code', 'msg', 'data', 'trace_id'];
export const summaryKeys = [
  'user_id',
  'available_fen',
  'frozen_fen',
  'negative_since',
  'withdrawn_fen',
  'withdraw_block',
];
export const blockKeys = ['blocked', 'hold_kinds'];
export const entryKeys = [
  'entry_id',
  'booked_at',
  'accounting_date',
  'ledger_type',
  'sub_type',
  'sub_account',
  'amount_fen',
  'balance_after_fen',
  'voucher',
  'link',
];
export const voucherKeys = ['voucher_id', 'uniq_key', 'biz_type', 'biz_id'];
export const linkKeys = ['type', 'id'];
export const ledgerFilters = [
  'user_id',
  'ledger_type',
  'sub_type',
  'sub_account',
  'accounting_date_from',
  'accounting_date_to',
  'ref',
];

export const userId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04';
export const negativeSummary = {
  user_id: userId,
  available_fen: -1200,
  frozen_fen: 5000,
  negative_since: '2026-10-30',
  withdrawn_fen: 30000,
  withdraw_block: { blocked: true, hold_kinds: ['manual', 'recon_diff'] },
};
export const plainSummary = {
  user_id: userId,
  available_fen: 1200,
  frozen_fen: 0,
  negative_since: null,
  withdrawn_fen: 0,
  withdraw_block: { blocked: false, hold_kinds: [] },
};

export const creditEntry = {
  entry_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a01',
  booked_at: '2026-11-05T10:00:00+08:00',
  accounting_date: '2026-11-05',
  ledger_type: 'REBATE_CREDIT',
  sub_type: null,
  sub_account: 'available',
  amount_fen: 120,
  balance_after_fen: 1320,
  voucher: {
    voucher_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b01',
    uniq_key: 'REBATE_CREDIT:pdd:231006-1234567890',
    biz_type: 'order_credit',
    biz_id: 'pdd:231006-1234567890',
  },
  link: { type: 'order', id: 'pdd:231006-1234567890' },
};
export const freezeEntry = {
  ...creditEntry,
  entry_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a02',
  ledger_type: 'WITHDRAW_FREEZE',
  sub_account: 'frozen',
  amount_fen: 5000,
  balance_after_fen: null,
  voucher: {
    voucher_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8b02',
    uniq_key: 'WITHDRAW_FREEZE:0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c02',
    biz_type: 'withdrawal',
    biz_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c02',
  },
  link: { type: 'withdrawal', id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c02' },
};
export const adjustEntry = {
  ...creditEntry,
  entry_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a03',
  ledger_type: 'ADMIN_ADJUST',
  sub_type: 'RECON_FIX',
  amount_fen: -300,
  balance_after_fen: -1200,
  link: { type: 'adjustment', id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c03' },
};
export const writeoffEntry = {
  ...creditEntry,
  entry_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a04',
  ledger_type: 'BAD_DEBT_WRITEOFF',
  amount_fen: 1200,
  balance_after_fen: 0,
  link: { type: 'writeoff', id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8c04' },
};
export const unlinkedEntry = {
  ...creditEntry,
  entry_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f8a05',
  ledger_type: 'REWARD',
  sub_type: 'invite',
  link: null,
};
export const entries = [creditEntry, freezeEntry, adjustEntry, writeoffEntry, unlinkedEntry];

export const goodDates = ['2026-11-05', '2026-01-31'];
export const badDates = ['2026-11-05T00:00:00+08:00', '20261105', '2026/11/05', 1, null];
export const goodTimes = ['2026-11-05T10:00:00+08:00', '2026-11-05T02:00:00Z'];
export const badTimes = ['2026-11-05', '2026-11-05 10:00:00', 1, null];

export function operation(doc: Obj, path: string): Obj {
  return op(doc, path, 'get');
}

// 原样的参数项（含 path item 级），不解析 $ref；用于核对是否引用了现有组件。
export function rawParams(doc: Obj, path: string): Obj[] {
  const pathItem = at(doc, 'paths', path);
  return [
    ...list(pathItem['parameters'] ?? []),
    ...list(operation(doc, path)['parameters'] ?? []),
  ].map(object);
}

export function param(doc: Obj, path: string, name: string): Obj {
  const matches = rawParams(doc, path)
    .map((raw) => resolve(doc, raw))
    .filter((entry) => entry['name'] === name);
  expect(matches, `参数 ${name}`).toHaveLength(1);
  return matches[0]!;
}

export function envelopeOf(doc: Obj, path: string): Obj {
  return response(doc, path, 'get');
}

export function dataOf(doc: Obj, path: string): Obj {
  return resolve(doc, at(envelopeOf(doc, path), 'properties', 'data'));
}

export function entrySchema(doc: Obj): Obj {
  return resolve(doc, at(dataOf(doc, ledgerPath), 'properties', 'items', 'items'));
}

export function descriptionOf(doc: Obj, path: string): string {
  return text(operation(doc, path)['description']);
}

function typeList(schema: Obj): unknown[] {
  const type = schema['type'];
  return Array.isArray(type) ? type : [type];
}

// 「对象 | null」里的对象那一支（只用于 link）：type 含 object，或 anyOf / oneOf 里恰有一支对象。
export function objectBranch(doc: Obj, schema: Obj): Obj {
  const resolved = resolve(doc, schema);
  if (typeList(resolved).includes('object')) return resolved;
  const branches = [...list(resolved['anyOf'] ?? []), ...list(resolved['oneOf'] ?? [])]
    .map((branch) => resolve(doc, branch))
    .filter((branch) => typeList(branch).includes('object'));
  expect(branches, '恰有一支对象').toHaveLength(1);
  return branches[0]!;
}

// 封闭的形状：type 含 object，additionalProperties: false，properties 与 required 都恰为 keys。
// 只给可为 null 的 link 对象那一支用；其余对象一律走 closedKeys。
export function closedShape(schema: Obj, keys: string[]): void {
  expect(typeList(schema)).toContain('object');
  expect(schema['additionalProperties']).toBe(false);
  expect(Object.keys(at(schema, 'properties')).toSorted()).toEqual(keys.toSorted());
  expect(list(schema['required']).toSorted()).toEqual(keys.toSorted());
}

// 封闭且不可为 null 的对象：type 恰为 object（不是类型数组），不带 nullable / anyOf / oneOf，
// null 被 schema 拒绝；其余同 closedShape。
export function closedKeys(doc: Obj, schema: Obj, keys: string[]): void {
  expect(schema['type']).toBe('object');
  expect([undefined, false]).toContain(schema['nullable']);
  for (const keyword of ['anyOf', 'oneOf']) expect(schema).not.toHaveProperty(keyword);
  closedShape(schema, keys);
  check(compile(doc, schema), null, false);
}

// 原样（未解析）的 schema 是对 components.schemas 的 $ref，且该组件在 ENUM_BINDINGS 里绑定 enumName。
export function boundRef(raw: unknown, enumName: string): void {
  const ref = text(object(raw)['$ref']);
  const prefix = '#/components/schemas/';
  expect(ref.startsWith(prefix), ref).toBe(true);
  expect(bindings()[ref.slice(prefix.length)], ref).toBe(enumName);
}

export function enumValues(name: string): string[] {
  return Object.keys(at(yaml('contracts/enums/fund.yaml'), 'enums', name, 'values'));
}

// 展开后的 schema 里所有 properties 的键名（不看描述文字）。
export function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(propertyNames);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Obj;
  const own =
    node['properties'] !== null && typeof node['properties'] === 'object'
      ? Object.keys(node['properties'] as Obj)
      : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}
