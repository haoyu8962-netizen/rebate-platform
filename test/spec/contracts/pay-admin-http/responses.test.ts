import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  data,
  endpoints,
  expand,
  lists,
  object,
  operation,
  prop,
  refunds,
  required,
  resolve,
  resolveEndpoint,
  response,
  values,
} from './kit.ts';
import type { Obj } from './kit.ts';

function row(doc: Obj, schema: Obj): Obj {
  return resolve(doc, at(prop(doc, schema, 'items'), 'items'));
}
function examples(doc: Obj, media: Obj): Obj[] {
  const result: Obj[] = [];
  if (media['example'] !== undefined) result.push(object(media['example']));
  for (const entry of Object.values(object(media['examples'] ?? {}))) {
    result.push(at(resolve(doc, entry), 'value'));
  }
  return result;
}
function money(doc: Obj, schema: Obj, names: string[]): void {
  for (const name of names)
    expect(prop(doc, schema, name)).toMatchObject({ type: 'integer', format: 'int64' });
}
function payOrder(doc: Obj, schema: Obj): void {
  required(schema, [
    'pay_order_id',
    'user_id',
    'biz_type',
    'biz_ref',
    'pay_channel',
    'amount_fen',
    'refunded_fen',
    'status',
    'out_trade_no',
    'needs_manual',
    'closing',
  ]);
  expect(values(prop(doc, schema, 'status')).toSorted()).toEqual(['CLOSED', 'PAID', 'PENDING']);
  expect(values(prop(doc, schema, 'pay_channel')).toSorted()).toEqual(['alipay', 'wechat_pay']);
  money(doc, schema, ['amount_fen', 'refunded_fen']);
  for (const name of ['needs_manual', 'closing'])
    expect(prop(doc, schema, name)).toMatchObject({ type: 'boolean' });
}
function refund(doc: Obj, schema: Obj): void {
  required(schema, [
    'pay_refund_id',
    'target_type',
    'target_id',
    'out_refund_no',
    'amount_fen',
    'reason_code',
    'status',
    'operator',
    'created_at',
  ]);
  expect(values(prop(doc, schema, 'status')).toSorted()).toEqual([
    'FAILED',
    'PROCESSING',
    'SUCCESS',
  ]);
  expect(values(prop(doc, schema, 'target_type')).toSorted()).toEqual(['pay_anomaly', 'pay_order']);
  money(doc, schema, ['amount_fen']);
}

it.each(lists)('[AC-CT-21e#9] %s %s 响应为后台分页信封', (...endpoint) => {
  const doc = contract();
  const schema = data(doc, endpoint);
  required(schema, ['items', 'page', 'page_size', 'total']);
  expect(prop(doc, schema, 'items')['type']).toBe('array');
  for (const name of ['page', 'page_size', 'total'])
    expect(prop(doc, schema, name)['type']).toBe('integer');
});

it('[AC-CT-21e#10] 支付单列表包含退款累计金额、关闭中及人工处置标记', () => {
  const doc = contract();
  payOrder(doc, row(doc, data(doc, endpoints[0])));
});

it('[AC-CT-21e#11] 支付单详情包含退款单和最近查询摘要，不回传原始请求响应', () => {
  const doc = contract();
  const detail = data(doc, endpoints[1]);
  // 允许详情平铺或以 pay_order 包装；未规定的列表属性名按结构定位。
  const fields = at(detail, 'properties');
  payOrder(doc, fields['pay_order'] === undefined ? detail : prop(doc, detail, 'pay_order'));
  const arrays = Object.entries(fields)
    .map(([name, value]) => [name, resolve(doc, value)] as const)
    .filter(([, value]) => value['type'] === 'array')
    .map(([name, value]) => [name, resolve(doc, at(value, 'items'))] as const);
  const refundLists = arrays.filter(
    ([, schema]) => object(schema['properties'] ?? {})['out_refund_no'] !== undefined,
  );
  expect(refundLists).toHaveLength(1);
  refund(doc, refundLists[0]![1]);
  const attempts = arrays.filter(
    ([, schema]) => object(schema['properties'] ?? {})['kind'] !== undefined,
  );
  expect(attempts).toHaveLength(1);
  required(detail, [refundLists[0]![0], attempts[0]![0]]);
  const attempt = attempts[0]![1];
  required(attempt, ['kind', 'result', 'at']);
  expect(Object.keys(at(attempt, 'properties')).toSorted()).toEqual(['at', 'kind', 'result']);
  expect(prop(doc, attempt, 'at')).toMatchObject({ type: 'string', format: 'date-time' });
});

it('[AC-CT-21e#12] 处置返回支付单与查询结果，仍未知时允许支付单保持 PENDING', () => {
  const doc = contract();
  const schema = data(doc, resolveEndpoint);
  required(schema, ['pay_order', 'channel_result']);
  payOrder(doc, prop(doc, schema, 'pay_order'));
  expect(prop(doc, schema, 'channel_result')).not.toEqual({});
});

it.each([endpoints[4], endpoints[5], ...refunds])(
  '[AC-CT-21e#13] %s %s 返回可追踪的退款单及三态',
  (...endpoint) => {
    const doc = contract();
    const schema = data(doc, endpoint);
    refund(doc, endpoint[2] === 'listAdminPayRefunds' ? row(doc, schema) : schema);
  },
);

it('[AC-CT-21e#14] 异常收款保留渠道交易号、关联和可退金额', () => {
  const doc = contract();
  const schema = row(doc, data(doc, endpoints[6]));
  required(schema, [
    'pay_anomaly_id',
    'pay_channel',
    'channel_trade_no',
    'out_trade_no',
    'pay_order_id',
    'amount_fen',
    'refunded_fen',
    'status',
  ]);
  money(doc, schema, ['amount_fen', 'refunded_fen']);
  for (const name of ['out_trade_no', 'pay_order_id']) {
    expect(JSON.stringify(prop(doc, schema, name))).toContain('null');
  }
});

it('[AC-CT-21e#15] 收款对账仅列 R4 的 pay_mismatch / pay_anomaly 并保留金额三列', () => {
  const doc = contract();
  const endpoint = endpoints[8];
  const schema = row(doc, data(doc, endpoint));
  required(schema, [
    'recon_diff_id',
    'type',
    'period',
    'ref_type',
    'ref_id',
    'expected_fen',
    'actual_fen',
    'diff_fen',
    'status',
  ]);
  expect(values(prop(doc, schema, 'type')).toSorted()).toEqual(['pay_anomaly', 'pay_mismatch']);
  money(doc, schema, ['expected_fen', 'actual_fen', 'diff_fen']);
  expect(String(operation(doc, endpoint)['description'])).toContain('R4');
  if (at(schema, 'properties')['source'] !== undefined)
    expect(values(prop(doc, schema, 'source'))).toEqual(['R4']);
});

it.each(endpoints)('[AC-CT-21e#16] %s %s 响应字段不暴露渠道侧用户标识或查询原文', (...endpoint) => {
  const doc = contract();
  const schema = object(
    expand(doc, at(response(doc, endpoint), 'content', 'application/json', 'schema')),
  );
  const forbidden =
    /openid|buyer_id|buyer_logon|user_id_alipay|alipay_user|payer|^(?:open_id|unionid|union_id|channel_user_id|channel_user_token|raw_request|raw_response|raw_payload)$/i;
  function inspect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Obj;
    for (const name of Object.keys(object(node['properties'] ?? {})))
      expect(name).not.toMatch(forbidden);
    Object.values(node).forEach(inspect);
  }
  inspect(schema);
  expect(schema).toHaveProperty('properties.data');
});

it.each(endpoints)(
  '[AC-CT-21e#18] %s %s 成功示例通过严格响应校验且不可省略信封字段',
  (...endpoint) => {
    const doc = contract();
    const media = at(response(doc, endpoint), 'content', 'application/json');
    const validate = compile(doc, at(media, 'schema'));
    const samples = examples(doc, media);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      check(validate, sample, true);
      expect(sample['code']).toBe(0);
      for (const key of ['code', 'msg', 'data', 'trace_id']) {
        const missing = { ...sample };
        delete missing[key];
        check(validate, missing, false);
      }
    }
  },
);

it.each([resolveEndpoint, ...refunds])(
  '[AC-CT-21e#19] %s %s 错误示例给出字段与资源定位',
  (...endpoint) => {
    const doc = contract();
    const op = operation(doc, endpoint);
    const errors: Obj[] = [];
    for (const [status, value] of Object.entries(at(op, 'responses'))) {
      if (!status.startsWith('4')) continue;
      const responseSchema = resolve(doc, value);
      const media = at(responseSchema, 'content', 'application/json');
      errors.push(...examples(doc, media));
    }
    if (endpoint[3] === 'pay.refund') {
      expect(errors).toContainEqual(expect.objectContaining({ code: 20901 }));
      expect(errors).toContainEqual(
        expect.objectContaining({
          code: 20001,
          data: expect.objectContaining({ fields: ['amount_fen'] }),
        }),
      );
    }
    if (endpoint[2] !== 'createAdminPayAnomalyRefund') {
      expect(errors).toContainEqual(
        expect.objectContaining({
          code: 20902,
          data: expect.objectContaining({ resource: 'pay_order' }),
        }),
      );
    }
    if (endpoint[3] === 'pay.resolve') {
      expect(errors).not.toContainEqual(expect.objectContaining({ code: 10003 }));
    }
  },
);
