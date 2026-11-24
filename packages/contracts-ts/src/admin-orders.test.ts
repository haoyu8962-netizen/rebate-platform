// CT-24m: GET /admin/v1/orders and GET /admin/v1/orders/{order_id}, the read side of the
// admin order console (01 F-ADM-05; 04 §6.6 orders, §3.2 orders / order_status_history /
// commission_splits / link_logs, §11.1 user.lookup, §11.2 order.view; BR-FUND-01 细则「订单锁定
// （展示标记）」). x-implementation is not asserted, so the implementing task can drop planned.
// Reads the dereferenced contract and validates the examples with the API workspace's strict Ajv
// (same loader as the admin-claims test).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { enums } from './index.ts';

const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
interface Validator {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): (data: unknown) => boolean;
}
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => Validator;
};
const addFormats = apiRequire('ajv-formats') as (ajv: Validator) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};
const { parseYamlLite } = createRequire(import.meta.url)('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

type Media = { schema: object; example?: unknown };
type Parameter = { name: string; in: string; required?: boolean; schema: object };
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-step-up'?: string;
  'x-idempotent'?: boolean;
};
type Schema = {
  required?: string[];
  properties?: Record<string, Schema>;
  description?: string;
  enum?: string[];
  additionalProperties?: boolean;
  maxItems?: number;
};
type Document = {
  paths: Record<string, { get?: Operation }>;
  components: { schemas: Record<string, Schema> };
};
type Row = Record<string, unknown>;

let contract: Document;
let raw: Document;
let ajv: Validator;

beforeAll(async () => {
  const file = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
  contract = (await dereference(file)) as Document;
  raw = parseYamlLite(readFileSync(file, 'utf8')) as Document;
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
});

function op(path: string): Operation {
  const found = contract.paths[path]?.get;
  expect(found, `GET ${path} must exist`).toBeDefined();
  return found!;
}
const list = (): Operation => op('/admin/v1/orders');
const detail = (): Operation => op('/admin/v1/orders/{order_id}');
const okMedia = (o: Operation): Media => o.responses['200']!.content!['application/json']!;
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const schema = (name: string): Schema => contract.components.schemas[name]!;

const LIST_FIELDS = [
  'order_id',
  'sub_order_id',
  'parent_order_id',
  'platform',
  'title',
  'image_url',
  'user',
  'paid_at',
  'pay_amount_fen',
  'est_commission_fen',
  'settle_commission_fen',
  'platform_status',
  'rebate_status',
  'hold_reason',
  'flags',
];

it('[CT-24m] both operations are read only under order.view or user.lookup, without step-up', () => {
  for (const [o, id] of [
    [list(), 'adminListOrders'],
    [detail(), 'adminGetOrder'],
  ] as const) {
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-orders']);
    expect(o['x-error-codes']).toEqual([10001, 10403, 20001]);
    expect(o['x-step-up']).toBeUndefined();
    expect(o['x-idempotent']).toBeUndefined();
    expect((o.parameters ?? []).map((p) => p.name.toLowerCase())).not.toContain('x-step-up-token');
    const text = flat(o.description);
    expect(text).toContain('Permission point `order.view`');
    expect(text).toContain('`user.lookup`');
    expect(text).toContain('10403 with `data.reason=admin_permission_denied`');
    expect(text).toContain('no step-up');
  }
  expect(enums.admin_permission).toContain('order.view');
  expect(enums.admin_permission).toContain('user.lookup');
});

it('[CT-24m] the list filters by platform, both statuses, flag, user_id, q and the paid_at range, page by page', () => {
  const params = list().parameters ?? [];
  expect(params.map((p) => p.name)).toEqual([
    'X-Trace-Id',
    'page',
    'page_size',
    'platform',
    'platform_status',
    'rebate_status',
    'flag',
    'user_id',
    'q',
    'paid_from',
    'paid_to',
    'item_id',
    'order_tail',
    'title_kw',
    'rate_bp_min',
    'rate_bp_max',
    'est_fen_min',
    'est_fen_max',
    'received_from',
    'received_to',
  ]);
  for (const p of params.slice(1)) {
    expect(p.in, p.name).toBe('query');
    expect(p.required ?? false, p.name).toBe(false);
  }
  const pageSize = params.find((p) => p.name === 'page_size')!.schema as { maximum: number };
  expect(pageSize.maximum).toBe(200);
  const byName = (name: string) => ajv.compile(params.find((p) => p.name === name)!.schema);
  for (const v of enums.platform) expect(byName('platform')(v), v).toBe(true);
  for (const v of enums.platform_status) expect(byName('platform_status')(v), v).toBe(true);
  for (const v of enums.rebate_status) expect(byName('rebate_status')(v), v).toBe(true);
  for (const v of enums.admin_order_flag) expect(byName('flag')(v), v).toBe(true);
  expect(byName('rebate_status')('PAID')).toBe(false);
  expect(byName('flag')('attribution_locked')).toBe(false);
  expect(byName('paid_from')('2026-10-01T00:00:00+08:00')).toBe(true);
  expect(byName('paid_to')('2026-10-01')).toBe(false);
  const text = flat(list().description);
  expect(text).toContain('`page` (any positive integer, as AdminPage');
  expect(text).toContain('a `page_size` above 200 is 20001');
  expect(text).toContain('the user filter takes the user_id only');
  expect(text).toContain('matches exactly');
  expect(text).toContain('`paid_from` (inclusive) and `paid_to` (exclusive)');
  expect(text).toContain('20001 with `data.fields=[paid_from, paid_to]`');
  expect(text).toContain('`paid_at` descending');
  expect(text).toContain('may read the list only together with `user_id`');
});

it('[CT-24m] the detail is keyed by order_id; unknown and another user are deliberately the same 20001', () => {
  const params = detail().parameters ?? [];
  expect(params.map((p) => [p.name, p.in, p.required ?? false])).toEqual([
    ['X-Trace-Id', 'header', false],
    ['order_id', 'path', true],
    ['user_id', 'query', false],
  ]);
  const text = flat(detail().description);
  expect(text).toContain('must pass `user_id`');
  expect(text).toContain('20001 with `data.fields=[order_id]`');
  expect(text).toContain('the same as an unknown order_id');
  expect(text).toContain('unknown and not visible deliberately share one code');
  expect(text).toContain('GET /admin/v1/search');
  const idParam = params.find((p) => p.name === 'order_id')!;
  expect(idParam.schema).toEqual(schema('Id'));
  const listed = (okMedia(list()).example as { data: { items: Row[] } }).data.items[0]!;
  expect((okMedia(detail()).example as { data: Row }).data['order_id']).toBe(listed['order_id']);
  expect(text).toContain('no probing');
});

it('[CT-24m] rows carry the spec columns, the user as user_id and masked phone, and the flag group', () => {
  const row = schema('AdminOrderListItem');
  expect(row.required).toEqual(LIST_FIELDS);
  expect(Object.keys(row.properties!)).toEqual([
    ...LIST_FIELDS,
    'item_id',
    'commission_rate_bp',
    'received_at',
  ]);
  expect(schema('AdminOrderUser').required).toEqual(['user_id', 'phone_masked']);
  expect(Object.keys(schema('AdminOrderUser').properties!)).toEqual(['user_id', 'phone_masked']);
  const flags = schema('AdminOrderFlags');
  expect(flags.required).toEqual([...enums.admin_order_flag]);
  expect(Object.keys(flags.properties!)).toEqual([...enums.admin_order_flag]);
  expect([...schema('AdminOrderFlag').enum!]).toEqual([...enums.admin_order_flag]);
  expect(flat(flags.description!)).toContain('locked is orders.locked');
  expect(flat(flags.description!)).toContain('status_locked is derived');
  expect(schema('AdminOrderPage').required).toEqual(['items', 'page', 'page_size', 'total']);
  const rows = (okMedia(list()).example as { data: { items: Row[] } }).data.items;
  expect(rows.some((r) => r['user'] === null)).toBe(true);
  for (const r of rows) {
    const user = r['user'] as Row | null;
    if (user !== null && user['phone_masked'] !== null)
      expect(user['phone_masked']).toMatch(/^\d{3}\*{4}\d{4}$/);
  }
  expect(JSON.stringify(okMedia(detail()).example)).not.toMatch(/1\d{10}/);
});

it('[CT-24m] the detail adds history, commission snapshot and link records, and no raw union payload', () => {
  const d = schema('AdminOrderDetail');
  expect(d.required!.slice(0, LIST_FIELDS.length)).toEqual(LIST_FIELDS);
  for (const name of [
    'display_status',
    'row_version',
    'status_history',
    'commission_split',
    'link_logs',
  ])
    expect(d.required, name).toContain(name);
  expect(Object.keys(d.properties!).some((k) => /raw_payload|payload/.test(k))).toBe(false);
  expect(flat(detail().description)).toContain('raw union payload');
  expect(flat(detail().description)).toContain('pending');
  expect(schema('AdminOrderStatusHistoryEntry').required).toEqual([
    'field',
    'from',
    'to',
    'event',
    'source',
    'at',
  ]);
  expect([...schema('AdminOrderHistoryField').enum!]).toEqual([...enums.admin_order_history_field]);
  expect([...schema('AdminOrderHistorySource').enum!]).toEqual([
    ...enums.admin_order_history_source,
  ]);
  expect(Object.keys(schema('AdminOrderLinkLog').properties!)).toEqual(['at', 'event', 'scene']);
  expect(d.properties!['link_logs']!.maxItems).toBe(50);
  const split = schema('AdminOrderCommissionSplit');
  for (const k of split.required!.filter((k) => k.endsWith('_fen')))
    expect(split.properties![k], k).toMatchObject({ type: 'integer', format: 'int64' });
  expect(schema('AdminOrderBeneficiary').required).toEqual([
    'user_id',
    'role',
    'ratio_bp',
    'forfeit_reason',
  ]);
  expect([...schema('AdminOrderPlatformStatus').enum!]).toEqual([...enums.platform_status]);
  expect([...schema('AdminOrderRebateStatus').enum!]).toEqual([...enums.rebate_status]);
  expect([...schema('AdminOrderHoldReason').enum!]).toEqual([...enums.order_hold_reason]);
  expect([...schema('AdminOrderLinkScene').enum!].sort()).toEqual([...enums.scene].sort());
  for (const [name, s] of Object.entries(raw.components.schemas)) {
    if (!name.startsWith('AdminOrder') || !('properties' in s)) continue;
    expect(s.additionalProperties, name).toBe(false);
  }
});

it('[CT-24m] the admin shapes are their own: they do not reference the user-side order projections', () => {
  const text = JSON.stringify(
    Object.entries(raw.components.schemas).filter(([name]) => name.startsWith('AdminOrder')),
  );
  for (const userSide of ['OrderSummary', 'OrderDetail"', 'OrderClaim'])
    expect(text).not.toContain(`#/components/schemas/${userSide}`);
  for (const [name, s] of Object.entries(raw.components.schemas)) {
    if (!name.startsWith('Order')) continue;
    expect(JSON.stringify(s), name).not.toContain('#/components/schemas/AdminOrder');
  }
});

it('[CT-24m] the examples satisfy the schemas, nulls included; extra fields and bad values fail', () => {
  const listMedia = okMedia(list());
  const validateList = ajv.compile(listMedia.schema);
  expect(validateList(listMedia.example)).toBe(true);
  const empty = {
    code: 0,
    msg: '',
    data: { items: [], page: 3, page_size: 20, total: 0 },
    trace_id: 'x',
  };
  expect(validateList(empty)).toBe(true);
  const fullPhone = structuredClone(listMedia.example) as { data: { items: Row[] } };
  (fullPhone.data.items[0]!['user'] as Row)['phone'] = '13800005678';
  expect(validateList(fullPhone)).toBe(false);
  const floatFen = structuredClone(listMedia.example) as { data: { items: Row[] } };
  floatFen.data.items[0]!['pay_amount_fen'] = 39.9;
  expect(validateList(floatFen)).toBe(false);

  const detailMedia = okMedia(detail());
  const validateDetail = ajv.compile(detailMedia.schema);
  expect(validateDetail(detailMedia.example)).toBe(true);
  const unattributed = structuredClone(detailMedia.example) as { data: Row };
  Object.assign(unattributed.data, {
    user: null,
    user_basis: null,
    display_status: null,
    rebate_status: 'UNATTRIBUTED',
    commission_split: null,
    link_logs: [],
  });
  expect(validateDetail(unattributed)).toBe(true);
  const withPayload = structuredClone(detailMedia.example) as { data: Row };
  withPayload.data['raw_payload'] = '{}';
  expect(validateDetail(withPayload)).toBe(false);
  const rawLink = structuredClone(detailMedia.example) as { data: { link_logs: Row[] } };
  rawLink.data.link_logs[0]!['pid'] = 'mm_1_2_3';
  expect(validateDetail(rawLink)).toBe(false);
  const badHistory = structuredClone(detailMedia.example) as { data: { status_history: Row[] } };
  badHistory.data.status_history[0]!['to'] = 'SHIPPED';
  expect(validateDetail(badHistory)).toBe(false);
  const badRatio = structuredClone(detailMedia.example) as {
    data: { commission_split: { beneficiaries: Row[] } };
  };
  badRatio.data.commission_split.beneficiaries[0]!['ratio_bp'] = 0.6;
  expect(validateDetail(badRatio)).toBe(false);
});

it('[CT-24m] the dashboard claim card opens the console claims page filtered to manual review', () => {
  const dash = op('/admin/v1/dashboard');
  const media = dash.responses['200']!.content!['application/json']! as {
    examples?: Record<string, { value: { data: Record<string, unknown> } }>;
  };
  // Every card of every example: the arrays of data whose entries carry a key.
  const cards = Object.values(media.examples!).flatMap((e) =>
    Object.values(e.value.data)
      .filter((v): v is Row[] => Array.isArray(v))
      .flat(),
  );
  const routes = cards.filter((t) => t['key'] === 'claim_review_pending').map((t) => t['route']);
  expect(routes.length).toBeGreaterThan(0);
  for (const r of routes) expect(r).toBe('/claims?status=manual_review');
  expect(enums.claim_status).toContain('manual_review');
});
