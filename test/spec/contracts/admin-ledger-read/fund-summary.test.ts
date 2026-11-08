// CT-24zzc GET /admin/v1/users/{user_id}/fund-summary（adminGetUserFundSummary）的契约形状
// （任务书第 9 节第 1 项；BR-FUND-13、BR-FUND-18）。独立预期，不从契约生成；静态读 contracts。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  contract,
  field,
  list,
  missingRejected,
  resolve,
  text,
  type Obj,
} from '../admin-order-actions/kit.ts';
import {
  blockKeys,
  boundRef,
  closedKeys,
  dataOf,
  descriptionOf,
  enumValues,
  envelopeOf,
  holdKinds,
  negativeSummary,
  param,
  plainSummary,
  rawParams,
  summaryKeys,
  summaryPath,
  userId,
} from './kit.ts';

function summary(doc: Obj): Obj {
  return dataOf(doc, summaryPath);
}

// withdraw_block 本身就是对象（不可为 null），不从 anyOf / oneOf 里挑一支。
function block(doc: Obj): Obj {
  return field(doc, summary(doc), 'withdraw_block');
}

it('[AC-CT-24zzc#8] 参数恰为 X-Trace-Id 与路径 user_id，分别引用 TraceId、AdminUserIdPath', () => {
  const doc = contract();
  const raws = rawParams(doc, summaryPath);
  for (const name of ['TraceId', 'AdminUserIdPath'])
    expect(raws, name).toContainEqual({ $ref: `#/components/parameters/${name}` });
  expect(raws.map((raw) => text(resolve(doc, raw)['name'])).toSorted()).toEqual(
    ['X-Trace-Id', 'user_id'].toSorted(),
  );
  const user = param(doc, summaryPath, 'user_id');
  expect(user['in']).toBe('path');
  expect(user['required']).toBe(true);
  expect(param(doc, summaryPath, 'X-Trace-Id')['in']).toBe('header');
});

it('[AC-CT-24zzc#9] 200 是后台信封 code/msg/data/trace_id；data（AdminUserFundSummary）封闭且恰为 6 个必填字段', () => {
  const doc = contract();
  const envelope = envelopeOf(doc, summaryPath);
  expect(list(envelope['required'])).toEqual(
    expect.arrayContaining(['code', 'msg', 'data', 'trace_id']),
  );
  accepts(doc, at(envelope, 'properties', 'code'), [0], [1, '0', null]);
  expect(at(envelope, 'properties', 'data')['$ref']).toBe(
    '#/components/schemas/AdminUserFundSummary',
  );
  const schema = summary(doc);
  closedKeys(doc, schema, summaryKeys);
  missingRejected(doc, schema, negativeSummary, summaryKeys);
  accepts(
    doc,
    schema,
    [negativeSummary, plainSummary],
    [{ ...plainSummary, extra: 1 }, { ...plainSummary, balance_fen: 0 }, null, []],
  );
});

it('[AC-CT-24zzc#10] 字段取值：available_fen 可为负，frozen_fen / withdrawn_fen 为整数分，negative_since 为日期或 null', () => {
  const doc = contract();
  const schema = summary(doc);
  accepts(doc, field(doc, schema, 'user_id'), [userId], [null, 1, {}]);
  accepts(
    doc,
    field(doc, schema, 'available_fen'),
    [-1200, -1, 0, 1200, 9_007_199_254_740_991],
    [1.5, '1200', null],
  );
  for (const name of ['frozen_fen', 'withdrawn_fen']) {
    const amount = field(doc, schema, name);
    expect(amount['type'], name).toBe('integer');
    expect(amount['format'], name).toBe('int64');
    accepts(doc, amount, [0, 5000, 30000], [1.5, '5000', null]);
  }
  accepts(
    doc,
    field(doc, schema, 'negative_since'),
    [null, '2026-10-30'],
    ['2026-10-30T00:00:00+08:00', '20261030', 1, ''],
  );
});

it('[AC-CT-24zzc#11] withdraw_block 封闭且恰为 blocked、hold_kinds；hold_kinds 元素 $ref withdraw_hold_kind 枚举', () => {
  const doc = contract();
  const schema = block(doc);
  closedKeys(doc, schema, blockKeys);
  accepts(doc, field(doc, schema, 'blocked'), [true, false], [null, 'true', 0]);
  const kinds = field(doc, schema, 'hold_kinds');
  expect(kinds['type']).toBe('array');
  boundRef(at(kinds, 'items'), 'withdraw_hold_kind');
  expect(holdKinds.toSorted()).toEqual(enumValues('withdraw_hold_kind').toSorted());
  expect(list(resolve(doc, at(kinds, 'items'))['enum']).toSorted()).toEqual(holdKinds.toSorted());
  accepts(doc, kinds, [[], holdKinds, ['manual']], [null, ['unknown'], [''], [1], 'manual']);
  accepts(
    doc,
    summary(doc),
    [{ ...plainSummary, withdraw_block: { blocked: true, hold_kinds: ['ledger_mismatch'] } }],
    [
      { ...plainSummary, withdraw_block: null },
      { ...plainSummary, withdraw_block: { blocked: false } },
      { ...plainSummary, withdraw_block: { hold_kinds: [] } },
      { ...plainSummary, withdraw_block: { blocked: false, hold_kinds: [], reason: 'x' } },
    ],
  );
});

it('[AC-CT-24zzc#12] withdrawn_fen 按 BR-FUND-18 口径：写明只计 PAID_API、PAID_MANUAL 提现单的 amount_fen', () => {
  const doc = contract();
  const withdrawn = field(doc, summary(doc), 'withdrawn_fen');
  const own = withdrawn['description'];
  const words = `${descriptionOf(doc, summaryPath)}\n${typeof own === 'string' ? own : ''}`;
  for (const word of ['BR-FUND-18', 'PAID_API', 'PAID_MANUAL', 'amount_fen'])
    expect(words, word).toContain(word);
});
