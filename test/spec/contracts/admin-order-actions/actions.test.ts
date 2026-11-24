import { expect, it } from 'vitest';
import {
  accepts,
  at,
  body,
  check,
  compile,
  contract,
  data,
  description,
  errorWith,
  expand,
  field,
  from,
  id,
  list,
  missingRejected,
  op,
  orderPath,
  required,
} from './kit.ts';

it.each(['hold', 'unhold'])('[AC-CT-24n#14] %s 必填说明与版本，原因码只收 RISK、CS', (action) => {
  const doc = contract();
  const path = `${orderPath}/${action}`;
  const schema = body(doc, path);
  const request = { reason_code: 'CS', note: '客服核实后处理', expected_row_version: 0 };
  missingRejected(doc, schema, request, [
    'note',
    'expected_row_version',
    ...(action === 'unhold' ? ['reason_code'] : []),
  ]);
  const validate = compile(doc, schema);
  for (const note of ['核', '核'.repeat(200)]) check(validate, { ...request, note }, true);
  for (const patch of [
    { note: '' },
    { note: '核'.repeat(201) },
    { note: null },
    { expected_row_version: -1 },
    { expected_row_version: 1.5 },
    { expected_row_version: '1' },
    { expected_row_version: null },
    { reason_code: 'OTHER' },
    { reason_code: 'UNMAPPED_STATUS' },
    { reason_code: null },
    { app_id: id },
    { step_up_token: 'unexpected' },
  ])
    check(validate, { ...request, ...patch }, false);
  for (const reason_code of ['RISK', 'CS']) check(validate, { ...request, reason_code }, true);
  if (action === 'hold') check(validate, { note: request.note, expected_row_version: 0 }, true);
  expect(list(op(doc, path)['x-error-codes'])).toEqual(expect.arrayContaining([20001, 20902]));
  errorWith(doc, path, 20902, { resource: 'order' });
  errorWith(doc, path, 20001, { fields: ['note'] });
  errorWith(doc, path, 20001, { fields: ['reason_code'] });
  errorWith(doc, path, 20001, { fields: ['order_id'] });
  const desc = description(doc, path);
  expect(desc).toContain('expected_row_version');
  expect(desc).toMatch(/R11/);
  if (action === 'hold') expect(desc).toMatch(/deriv|infer|推导/i);
  else {
    expect(desc).toContain('UNMAPPED_STATUS');
    expect(desc).toMatch(/open|未关闭/);
  }
  expect(data(doc, path)).toEqual(data(doc, orderPath, 'get'));
});

it('[AC-CT-24n#15] 指派只收 expected_user_id=null，锁定期望为布尔，原因 5–200 字', () => {
  const doc = contract();
  const schema = body(doc, `${orderPath}/reassign`);
  const request = {
    user_id: id,
    expected_user_id: null,
    expected_locked: false,
    reason: '核实后指派此单',
  };
  missingRejected(doc, schema, request, [
    'user_id',
    'expected_user_id',
    'expected_locked',
    'reason',
  ]);
  const validate = compile(doc, schema);
  for (const expected_locked of [true, false]) {
    for (const reason of ['核'.repeat(5), '核'.repeat(200)])
      check(validate, { ...request, expected_locked, reason }, true);
  }
  for (const patch of [
    { expected_user_id: id },
    { expected_user_id: '' },
    { expected_locked: null },
    { expected_locked: 0 },
    { expected_locked: 'false' },
    { user_id: null },
    { user_id: '' },
    { reason: '' },
    { reason: '核'.repeat(4) },
    { reason: '核'.repeat(201) },
    { reason: null },
    { app_id: id },
    { step_up_token: 'unexpected' },
  ])
    check(validate, { ...request, ...patch }, false);
  expect(data(doc, `${orderPath}/reassign`)).toEqual(data(doc, orderPath, 'get'));
});

it('[AC-CT-24n#16] 指派并发与已归属返回 order_attribution 冲突，不合格目标沿用 20001', () => {
  const doc = contract();
  const path = `${orderPath}/reassign`;
  const codes = list(op(doc, path)['x-error-codes']);
  expect(codes).toEqual(expect.arrayContaining([20001, 20902]));
  expect(codes).not.toContain(10003);
  errorWith(doc, path, 20902, { resource: 'order_attribution' });
  for (const name of ['order_id', 'user_id', 'reason'])
    errorWith(doc, path, 20001, { fields: [name] });
  for (const reason of ['target_banned', 'target_deleting', 'target_deleted'])
    errorWith(doc, path, 20001, { reason });
  const desc = description(doc, path);
  expect(desc).toContain('expected_user_id');
  expect(desc).toContain('expected_locked');
  expect(desc).toMatch(/already.attributed|已归属|user_id.*non.null/i);
  expect(desc).toMatch(/frozen|冻结/i);
  expect(at(op(doc, path), 'responses')).not.toHaveProperty('404');
});

it('[AC-CT-24n#17] 详情增加派生未映射标记和四个可空人工暂停审计字段', () => {
  const doc = contract();
  const schema = data(doc, orderPath, 'get');
  required(schema, [
    'unmapped_pending_open',
    'last_hold_by',
    'last_hold_by_name',
    'last_hold_note',
    'last_hold_at',
  ]);
  accepts(doc, field(doc, schema, 'unmapped_pending_open'), [true, false], [null, 0, 'true']);
  accepts(doc, field(doc, schema, 'last_hold_by'), [id, null], [1, {}]);
  accepts(doc, field(doc, schema, 'last_hold_by_name'), ['客服甲', 'ops01', null], [1, {}]);
  accepts(
    doc,
    field(doc, schema, 'last_hold_note'),
    ['核实订单', '核'.repeat(200), null],
    [1, '核'.repeat(201)],
  );
  accepts(doc, field(doc, schema, 'last_hold_at'), [from, null], [1, 'yesterday']);
  const desc = description(doc, orderPath, 'get') + JSON.stringify(expand(doc, schema));
  expect(desc).toContain('UNMAPPED_STATUS');
  expect(desc).toMatch(/\bopen\b/);
  expect(desc).toMatch(/derived|派生/i);
  expect(desc).toMatch(/audit|审计/i);
  expect(desc).toMatch(/manual|人工/i);
  expect(desc).toMatch(/system|系统/i);
});
