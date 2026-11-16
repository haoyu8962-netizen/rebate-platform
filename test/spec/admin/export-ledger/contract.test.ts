// CT-24zzm · 契约登记：export_resource 加 ledger（余额流水 GET /admin/v1/ledger，权限点 fund.view 或
// user.lookup 任一 + export；filters 同 adminListLedgerEntries 去掉分页的查询参数；导出列 = 其响应
// 字段，没有一列属于 pii，所以不设 unmasked / reason，与 audit_logs 一样恒为脱敏任务）。独立预期来自
// 任务书（D10-1740 / D10-1742）与 04 §11.1，不从契约生成；全部静态读 contracts 与生成物，不连库、
// 不 listen。
import { expect, it } from 'vitest';
import { export_resource } from '../../../../packages/contracts-ts/src/index.ts';
import {
  accepts,
  at,
  body,
  contract,
  description,
  expand,
  list,
  object,
  params,
  resolve,
  text,
  yaml,
  type Obj,
} from '../../contracts/admin-order-actions/kit.ts';

const exportsPath = '/admin/v1/exports';
const ledgerPath = '/admin/v1/ledger';
const user = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
/** adminListLedgerEntries' query parameters without paging (task notes D10-1742). */
const FILTERS = [
  'user_id',
  'ledger_type',
  'sub_type',
  'sub_account',
  'accounting_date_from',
  'accounting_date_to',
  'ref',
];
const PREVIOUS = ['users', 'audit_logs', 'tax_withdrawals'];

function declared(name: string): Obj {
  return at(yaml('contracts/enums/admin.yaml'), 'enums', name, 'values');
}

/** The request branch whose `resource` admits exactly `ledger` (any component name). */
function ledgerBranch(doc: Obj): Obj {
  const request = body(doc, exportsPath);
  const branches = list(request['oneOf']).map((branch) => resolve(doc, branch));
  const found = branches.filter((branch) => {
    const resource = object(branch['properties'] ?? {})['resource'];
    if (resource === undefined) return false;
    const values = resolve(doc, resource)['enum'];
    return Array.isArray(values) && values.length === 1 && values[0] === 'ledger';
  });
  expect(found, 'adminCreateExport 须有且只有一个 resource=ledger 的分支').toHaveLength(1);
  return found[0]!;
}

/** A schema without the keys that only describe it. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['description', 'example', 'examples', 'title'].includes(key))
      .map(([key, child]) => [key, shape(child)]),
  );
}

it('[AC-CT-24zzm#1] enums/admin.yaml 的 export_resource 登记 ledger：写明余额流水来源与两个读权限点，原有值不变', () => {
  const values = declared('export_resource');
  expect(Object.keys(values)).toEqual(expect.arrayContaining([...PREVIOUS, 'ledger']));
  const note = text(values['ledger']);
  expect(note).toContain('/admin/v1/ledger');
  expect(note).toContain('fund.view');
  expect(note).toContain('user.lookup');
  expect(note).toContain('user_id');
});

it('[AC-CT-24zzm#2] 生成的 export_resource 与 openapi AdminExportResource 都含 ledger，且与 enums 登记一致', () => {
  const doc = contract();
  expect([...export_resource]).toEqual(expect.arrayContaining([...PREVIOUS, 'ledger']));
  const listed = params(doc, exportsPath, 'get').find((param) => param['name'] === 'resource');
  expect(listed, 'adminListExports 的 resource 参数').toBeDefined();
  const schema = resolve(doc, at(listed!, 'schema'));
  expect(list(schema['enum']).toSorted()).toEqual(
    Object.keys(declared('export_resource')).toSorted(),
  );
  expect([...export_resource].toSorted()).toEqual(list(schema['enum']).toSorted());
  expect(text(schema['description'])).toContain('ledger');
});

it('[AC-CT-24zzm#3] 创建请求的 ledger 分支：只收 resource、filters，filters 键 = 列表查询参数去分页，user_id 必填', () => {
  const doc = contract();
  const branch = ledgerBranch(doc);
  expect(branch['additionalProperties']).toBe(false);
  expect(Object.keys(at(branch, 'properties')).toSorted()).toEqual(['filters', 'resource']);
  expect(list(branch['required']).toSorted()).toEqual(['filters', 'resource']);
  const filters = resolve(doc, at(branch, 'properties', 'filters'));
  expect(filters['type']).toBe('object');
  expect(filters['additionalProperties']).toBe(false);
  expect(Object.keys(at(filters, 'properties')).toSorted()).toEqual(FILTERS.toSorted());
  expect(list(filters['required'])).toEqual(['user_id']);
});

it('[AC-CT-24zzm#4] filters 各键与 adminListLedgerEntries 同名查询参数同形（同一 schema）', () => {
  const doc = contract();
  const filters = resolve(doc, at(ledgerBranch(doc), 'properties', 'filters'));
  const query = params(doc, ledgerPath, 'get').filter((param) => param['in'] === 'query');
  for (const name of FILTERS) {
    const parameter = query.find((param) => param['name'] === name);
    expect(parameter, `adminListLedgerEntries 查询参数 ${name}`).toBeDefined();
    expect(shape(expand(doc, at(filters, 'properties', name))), name).toEqual(
      shape(expand(doc, at(parameter!, 'schema'))),
    );
  }
  for (const paging of ['page', 'page_size']) {
    expect(at(filters, 'properties')).not.toHaveProperty(paging);
  }
});

it('[AC-CT-24zzm#5] ledger 分支按列表的规则收拒：缺 user_id、枚举外取值、错格式、分页键、unmasked / reason 都拒', () => {
  const doc = contract();
  const branch = ledgerBranch(doc);
  const minimal = { resource: 'ledger', filters: { user_id: user } };
  const full = {
    resource: 'ledger',
    filters: {
      user_id: user,
      ledger_type: 'WITHDRAW_FREEZE',
      sub_type: 'DIRECT',
      sub_account: 'frozen',
      accounting_date_from: '2026-10-01',
      accounting_date_to: '2026-10-31',
      ref: 'taobao:2026103100001',
    },
  };
  accepts(
    doc,
    branch,
    [minimal, full],
    [
      { resource: 'ledger', filters: {} },
      { resource: 'ledger' },
      { resource: 'ledger', filters: { user_id: 'not-a-uuid' } },
      { resource: 'ledger', filters: { user_id: user, ledger_type: 'NOT_A_TYPE' } },
      { resource: 'ledger', filters: { user_id: user, sub_account: 'locked' } },
      { resource: 'ledger', filters: { user_id: user, accounting_date_from: '2026/10/01' } },
      {
        resource: 'ledger',
        filters: { user_id: user, accounting_date_to: '2026-10-31T00:00:00+08:00' },
      },
      { resource: 'ledger', filters: { user_id: user, sub_type: '' } },
      { resource: 'ledger', filters: { user_id: user, ref: '' } },
      { resource: 'ledger', filters: { user_id: user, page_size: '200' } },
      { resource: 'ledger', filters: { user_id: user, risk_state: 'frozen' } },
      { ...minimal, unmasked: true },
      { ...minimal, unmasked: true, reason: '核对用户流水' },
      { ...minimal, reason: '核对用户流水' },
      { ...minimal, note: '多余字段' },
    ],
  );
  // The whole request still takes every earlier branch, and ledger.
  accepts(
    doc,
    body(doc, exportsPath),
    [
      minimal,
      full,
      { resource: 'users', filters: { risk_state: 'frozen' } },
      { resource: 'audit_logs', filters: {} },
      { resource: 'tax_withdrawals', filters: { quarter: '2026-Q4' } },
    ],
    [{ resource: 'ledger', filters: { user_id: user, quarter: '2026-Q4' } }],
  );
});

it('[AC-CT-24zzm#6] adminCreateExport 的描述写明 ledger 的来源、两个读权限点任一与脱敏口径', () => {
  const doc = contract();
  const prose = description(doc, exportsPath);
  expect(prose).toContain('ledger');
  expect(prose).toContain('/admin/v1/ledger');
  expect(prose).toContain('user.lookup');
  expect(prose).toMatch(/ledger[\s\S]*fund\.view|fund\.view[\s\S]*ledger/);
});
