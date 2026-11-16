// CT-24k: the admin export tasks — POST /admin/v1/exports, GET /admin/v1/exports,
// GET /admin/v1/exports/{id}/download and POST /admin/v1/exports/{id}/retry (01 F-ADM-03;
// 04 §6.6 exports, §11.1 export; BR-ID-34 细则「后台导出任务」, BR-ID-30 ⑨). x-implementation is
// not asserted, so B1-34 can drop planned. Reads the dereferenced contract and validates the
// examples with the API workspace's strict Ajv (same loader as the admin-audit-logs test).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { enums, errorCodes } from './index.ts';

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

type Media = { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> };
type Parameter = { name: string; in: string; required?: boolean; schema: object };
type Response = { content?: Record<string, Media>; headers?: Record<string, unknown> };
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: Record<string, Media> };
  responses: Record<string, Response>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-step-up'?: string;
  'x-idempotent'?: boolean;
};
type Schema = { required?: string[]; properties?: Record<string, Schema>; enum?: string[] };
type Document = {
  paths: Record<string, { get?: Operation; post?: Operation }>;
  components: { schemas: Record<string, Schema> };
};

let contract: Document;
let ajv: Validator;

beforeAll(async () => {
  contract = (await dereference(
    fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url)),
  )) as Document;
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
});

const BASE = '/admin/v1/exports';
function op(method: 'get' | 'post', path: string): Operation {
  const found = contract.paths[path]?.[method];
  expect(found, `${method.toUpperCase()} ${path} must exist`).toBeDefined();
  return found!;
}
const create = (): Operation => op('post', BASE);
const list = (): Operation => op('get', BASE);
const download = (): Operation => op('get', `${BASE}/{id}/download`);
const retry = (): Operation => op('post', `${BASE}/{id}/retry`);
const json = (o: Operation, status: string): Media =>
  o.responses[status]!.content!['application/json']!;
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const paramNames = (o: Operation): string[] => (o.parameters ?? []).map((p) => p.name);

it('[CT-24k] four admin operations under permission point export, with their error codes', () => {
  const cases = [
    [create(), 'adminCreateExport', [10001, 10003, 10403, 20001]],
    [list(), 'adminListExports', [10001, 10403, 20001]],
    [download(), 'adminDownloadExport', [10001, 10403, 20001, 30417]],
    [retry(), 'adminRetryExport', [10001, 10003, 10403, 20001, 30417]],
  ] as const;
  for (const [o, id, codes] of cases) {
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-exports']);
    expect(o['x-error-codes']).toEqual(codes);
    expect(o['x-step-up']).toBeUndefined();
    expect(o['x-idempotent']).toBeUndefined();
    expect(o.description).toContain('Permission point `export`');
  }
  expect(enums.admin_permission).toContain('export');
  // Step-up only where full values can be generated (create with unmasked, retry of an unmasked task).
  expect(paramNames(create())).toContain('X-Step-Up-Token');
  expect(paramNames(retry())).toContain('X-Step-Up-Token');
  expect(paramNames(list())).not.toContain('X-Step-Up-Token');
  expect(paramNames(download())).not.toContain('X-Step-Up-Token');
});

it('[CT-24k] enums export_status and export_resource match the contract schemas', () => {
  expect(enums.export_status).toEqual([
    'pending',
    'running',
    'done',
    'failed',
    'expired',
    'cancelled',
  ]);
  expect(enums.export_resource).toEqual(['users', 'audit_logs', 'tax_withdrawals', 'ledger']);
  expect(contract.components.schemas['AdminExportStatus']!.enum).toEqual(enums.export_status);
  expect(contract.components.schemas['AdminExportResource']!.enum).toEqual(enums.export_resource);
});

it('[CT-24k] 30417 is the status code of download and retry, with data.status', () => {
  const def = errorCodes[30417];
  expect(def.http).toBe(422);
  expect(def.retry_kind).toBe('never');
  expect(def.data['status']).toEqual(enums.export_status);
  expect(flat(download().description)).toContain('30417 with `data.status`');
  expect(flat(retry().description)).toContain('30417 with `data.status`');
  expect(flat(retry().description)).toContain('Only a failed task can be retried');
  expect(flat(download().description)).toContain('Only a task in status done');
});

it('[CT-24k] create answers 202 with a pending task; its body is one branch per resource', () => {
  const o = create();
  expect(Object.keys(o.responses)).not.toContain('200');
  const accepted = json(o, '202');
  const validate = ajv.compile(accepted.schema);
  expect(validate(accepted.example)).toBe(true);
  expect((accepted.example as { data: { status: string } }).data.status).toBe('pending');

  expect(o.requestBody!.required).toBe(true);
  const body = o.requestBody!.content['application/json']!;
  const validBody = ajv.compile(body.schema);
  for (const [name, ex] of Object.entries(body.examples!)) {
    expect(validBody(ex.value), name).toBe(true);
  }
  // users takes risk_state, audit_logs the audit-log filters; mixing them is refused.
  expect(validBody({ resource: 'users', filters: {} })).toBe(true);
  expect(validBody({ resource: 'users', filters: { actor_id: 'x' } })).toBe(false);
  expect(validBody({ resource: 'audit_logs', filters: { risk_state: 'banned' } })).toBe(false);
  expect(validBody({ resource: 'audit_logs', filters: {}, unmasked: true })).toBe(false);
  expect(validBody({ resource: 'audit_logs', filters: {}, reason: '理由' })).toBe(false);
  expect(validBody({ resource: 'orders', filters: {} })).toBe(false);
  expect(validBody({ resource: 'users' })).toBe(false);
  expect(validBody({ resource: 'users', filters: {}, unmasked: true, reason: '' })).toBe(false);
  expect(
    validBody({ resource: 'users', filters: {}, unmasked: true, reason: 'x'.repeat(201) }),
  ).toBe(false);

  const text = flat(o.description);
  expect(text).toContain('`users` needs `user.list`');
  expect(text).toContain('masked like its source list');
  expect(text).toContain('`pii.reveal_phone`');
  expect(text).toContain('10003 with `data.tier=totp`');
  expect(text).toContain('`data.fields=[reason]`');
  expect(text).toContain('forces `actor_id` to the creator');
  expect(text).toContain('`admin.export.max_rows`');
  expect(text).toContain('`admin.export.max_running_per_admin`');
  expect(text).toContain('There is no cancel operation');
});

it('[CT-24zi] tax_withdrawals takes a required quarter; full values need tax.export_full', () => {
  const o = create();
  const validBody = ajv.compile(o.requestBody!.content['application/json']!.schema);
  const tax = { resource: 'tax_withdrawals', filters: { quarter: '2026-Q4' } };
  expect(validBody(tax)).toBe(true);
  expect(validBody({ ...tax, unmasked: true, reason: '申报' })).toBe(true);
  expect(validBody({ ...tax, filters: {} })).toBe(false);
  expect(validBody({ ...tax, filters: { quarter: '2026-Q5' } })).toBe(false);
  expect(validBody({ ...tax, filters: { quarter: '2026Q4' } })).toBe(false);
  expect(validBody({ ...tax, filters: { quarter: '2026-Q4', from: '2026-10-01' } })).toBe(false);
  expect(validBody({ ...tax, reason: '' })).toBe(false);
  expect(validBody({ resource: 'users', filters: { quarter: '2026-Q4' } })).toBe(false);

  expect(enums.admin_permission).toContain('tax.export_full');
  const text = flat(o.description);
  expect(text).toContain('BR-WDR-21');
  expect(text).toContain('`tax.export_full` alone');
  expect(text).toContain('`export` and `fund.view`');
  expect(text).toContain('export_unmasked (with the row count and the purpose)');
});

it('[CT-24k] the list is own tasks only without audit.view_all; rows carry no link', () => {
  const o = list();
  expect(paramNames(o)).toEqual([
    'X-Trace-Id',
    'page',
    'page_size',
    'status',
    'resource',
    'from',
    'to',
  ]);
  const text = flat(o.description);
  expect(text).toContain('`audit.view_all`');
  expect(text).toContain('only sees the tasks it created');
  expect(text).toContain('downloading and retrying stay limited to the creator');
  const ok = json(o, '200');
  const validate = ajv.compile(ok.schema);
  expect(validate(ok.example)).toBe(true);
  const rows = (ok.example as { data: { items: Record<string, unknown>[] } }).data.items;
  for (const row of rows) {
    expect(row).not.toHaveProperty('url');
    expect(row['id']).toMatch(/^(?![0-9]+$)[A-Za-z0-9_-]{16,64}$/);
  }
  const item = contract.components.schemas['AdminExport']!;
  expect(item.required).toEqual([
    'id',
    'resource',
    'filters_summary',
    'masked',
    'created_by',
    'created_at',
    'status',
    'progress',
    'failure_reason',
    'file_name',
    'row_count',
    'expires_at',
  ]);
  expect(Object.keys(item.properties!)).toContain('created_by_name');
  const numericId = structuredClone(ok.example) as { data: { items: Record<string, unknown>[] } };
  numericId.data.items[0]!['id'] = 1031;
  expect(validate(numericId)).toBe(false);
});

it('[CT-24k] download: creator only, re-checked points, short-lived link, audited, no-store', () => {
  const o = download();
  const text = flat(o.description);
  expect(text).toContain(
    'Only the creator of the task can download it, even with `audit.view_all`',
  );
  expect(text).toContain("min(5 minutes from now, the task's `expires_at`)");
  expect(text).toContain('still holds the permission of the source list');
  expect(text).toContain('20001 with `data.fields=[id]`');
  expect(text).toContain('writes its own audit record');
  const ok = o.responses['200']!;
  expect(ok.headers).toHaveProperty('Cache-Control');
  const media = json(o, '200');
  expect(ajv.compile(media.schema)(media.example)).toBe(true);
  const idParam = ajv.compile(o.parameters!.find((p) => p.name === 'id')!.schema);
  expect(idParam('exp_Kd3Qw8Rt5Ym1Zx7N')).toBe(true);
  expect(idParam('1031')).toBe(false);
});

it('[CT-24k] retry: creator only, failed only, unmasked needs a new step-up and reason', () => {
  const o = retry();
  const text = flat(o.description);
  expect(text).toContain('Only the creator of the task can retry it');
  expect(text).toContain('every generation of a file with full values is verified anew');
  const body = o.requestBody!.content['application/json']!;
  const validBody = ajv.compile(body.schema);
  expect(validBody({})).toBe(true);
  expect(validBody({ reason: '重新导出' })).toBe(true);
  expect(validBody({ reason: '' })).toBe(false);
  expect(validBody({ unmasked: true })).toBe(false);
  const ok = json(o, '200');
  expect(ajv.compile(ok.schema)(ok.example)).toBe(true);
  expect((ok.example as { data: { status: string } }).data.status).toBe('pending');
});
