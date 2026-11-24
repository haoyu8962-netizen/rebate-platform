// CT-24f: GET /admin/v1/risk-rules and POST /admin/v1/risk-rules/{rule_id}/enable | disable, the
// admin risk rule list (04 §6.6 risk-rules, §3.2 risk_rules, §11.2 config.risk; BR-ID-36 细则
// 「规则清单的启停」). x-implementation is not asserted, so the implementing task can drop planned.
// Reads the dereferenced contract and validates the examples with the API workspace's strict Ajv
// (same loader as the admin-orders test).
import { readFileSync } from 'node:fs';
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
const { parseYamlLite } = createRequire(import.meta.url)('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

type Media = { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> };
type Parameter = { name: string; in: string; required?: boolean; schema: object };
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-step-up'?: string;
  'x-idempotent'?: boolean;
};
type PathItem = Partial<Record<'get' | 'put' | 'post' | 'patch' | 'delete', Operation>>;
type Schema = {
  required?: string[];
  properties?: Record<string, Schema>;
  enum?: string[];
  additionalProperties?: boolean;
  maxLength?: number;
  minLength?: number;
};
type Document = {
  tags: { name: string }[];
  paths: Record<string, PathItem>;
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

const LIST = '/admin/v1/risk-rules';
const ENABLE = '/admin/v1/risk-rules/{rule_id}/enable';
const DISABLE = '/admin/v1/risk-rules/{rule_id}/disable';
const ROW_FIELDS = [
  'rule_id',
  'scene',
  'name',
  'risk_action',
  'status',
  'threshold_keys',
  'version',
  'updated_at',
];

function op(path: string, method: 'get' | 'post'): Operation {
  const found = contract.paths[path]?.[method];
  expect(found, `${method.toUpperCase()} ${path} must exist`).toBeDefined();
  return found!;
}
const list = (): Operation => op(LIST, 'get');
const writes = (): [Operation, string, string][] => [
  [op(ENABLE, 'post'), 'adminEnableRiskRule', 'enabled'],
  [op(DISABLE, 'post'), 'adminDisableRiskRule', 'disabled'],
];
const okMedia = (o: Operation): Media => o.responses['200']!.content!['application/json']!;
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const schema = (name: string): Schema => contract.components.schemas[name]!;

it('[CT-24f] the list is read only under config.risk, without step-up, not paged or filtered', () => {
  const o = list();
  expect(o.operationId).toBe('adminListRiskRules');
  expect(o['x-auth']).toBe('admin');
  expect(o.security).toEqual([{ adminBearerAuth: [] }]);
  expect(o.tags).toEqual(['admin-risk']);
  expect(o['x-error-codes']).toEqual([10001, 10403]);
  expect(o['x-step-up']).toBeUndefined();
  expect(o['x-idempotent']).toBeUndefined();
  expect((o.parameters ?? []).map((p) => p.name)).toEqual(['X-Trace-Id']);
  const text = flat(o.description);
  expect(text).toContain('Permission point `config.risk`');
  expect(text).toContain('no step-up');
  expect(text).toContain('10403 with `data.reason=admin_permission_denied`');
  expect(text).toContain('not paged and not filtered');
  expect(text).toContain('The condition JSON is not returned');
  expect(enums.admin_permission).toContain('config.risk');
  expect(raw.tags.map((t) => t.name)).toContain('admin-risk');
});

it('[CT-24f] enable and disable need config.risk without step-up (BR-ID-34: none), CAS and an optional reason', () => {
  for (const [o, id, target] of writes()) {
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-risk']);
    expect(o['x-error-codes']).toEqual([10001, 10403, 20001, 20902]);
    expect(o['x-step-up']).toBeUndefined();
    expect(o['x-idempotent']).toBeUndefined();
    expect((o.parameters ?? []).map((p) => [p.name, p.in, p.required ?? false])).toEqual([
      ['X-Trace-Id', 'header', false],
      ['rule_id', 'path', true],
    ]);
    expect(o.requestBody?.required).toBe(true);
    const text = flat(o.description);
    expect(text).toContain('Permission point `config.risk`');
    expect(text).not.toMatch(/step-up|X-Step-Up-Token|10003|data\.tier/i);
    expect(text).toContain('20001 with `data.fields=[rule_id]`');
    expect(text).toContain('20902 with `data.resource=risk_rule`');
    expect(text).toContain(`sets \`status\` to ${target} and adds 1`);
    expect(text).toContain('succeeds unchanged: `version` stays the same');
    expect(text).toContain('no audit record is written');
    expect(text).toContain('before and after `status`');
    expect(text).toContain('judgements already made are not redone');
    expect(text).toContain('No Idempotency-Key');
    const res = okMedia(o).example as { data: Row };
    expect(res.data['status']).toBe(target);
  }
  expect(flat(op(DISABLE, 'post').description)).toContain('writes no risk_hits');
  const body = schema('AdminRiskRuleStatusChangeRequest');
  expect(body.required).toEqual(['expected_version']);
  expect(Object.keys(body.properties!)).toEqual(['expected_version', 'reason']);
  expect(body.additionalProperties).toBe(false);
  expect(body.properties!['reason']).toMatchObject({ minLength: 1, maxLength: 200 });
});

it('[CT-24f] a row carries the 04 §6.6 fields; status and risk_action mirror the enums', () => {
  const row = schema('AdminRiskRule');
  expect(row.required).toEqual(ROW_FIELDS);
  expect(Object.keys(row.properties!)).toEqual(ROW_FIELDS);
  expect(enums.risk_rule_status).toEqual(['enabled', 'disabled']);
  expect(enums.risk_action).toEqual(['pass', 'manual_review', 'block', 'void_commission']);
  expect([...schema('AdminRiskRuleStatus').enum!]).toEqual([...enums.risk_rule_status]);
  expect([...schema('AdminRiskAction').enum!]).toEqual([...enums.risk_action]);
  expect(schema('AdminRiskRuleList').required).toEqual(['items']);
  expect(Object.keys(schema('AdminRiskRuleList').properties!)).toEqual(['items']);
  for (const [name, s] of Object.entries(raw.components.schemas)) {
    if (!name.startsWith('AdminRiskRule') || !('properties' in s)) continue;
    expect(s.additionalProperties, name).toBe(false);
  }
});

it('[CT-24f] thresholds stay under config-items: only their keys are listed and no second write path exists', () => {
  const row = schema('AdminRiskRule');
  for (const k of Object.keys(row.properties!))
    expect(k, k).not.toMatch(/^(threshold_value|thresholds|range|conditions)$/);
  const keySchema = (row.properties!['threshold_keys'] as unknown as { items: object }).items;
  expect(keySchema).toEqual(schema('AdminConfigKey'));
  const riskPaths = Object.keys(contract.paths).filter((p) => p.startsWith(LIST));
  expect(riskPaths.sort()).toEqual([LIST, DISABLE, ENABLE].sort());
  expect(Object.keys(contract.paths[LIST]!)).toEqual(['get']);
  expect(Object.keys(contract.paths[ENABLE]!)).toEqual(['post']);
  expect(Object.keys(contract.paths[DISABLE]!)).toEqual(['post']);
  expect(flat(list().description)).toContain('PUT /admin/v1/config-items/{key}');
  expect(contract.paths['/admin/v1/config-items/{key}']?.put?.operationId).toBe(
    'adminUpdateConfigItem',
  );
  expect(flat(contract.paths['/admin/v1/config-items/{key}']!.put!.description)).toContain(
    'Every other key needs no step-up (BR-ID-34: none)',
  );
});

it('[CT-24f] 20902 has the risk_rule resource and the conflict example uses it', () => {
  expect(errorCodes[20902].data.resource).toContain('risk_rule');
  for (const [o] of writes()) {
    const errors = o.responses['4XX']!.content!['application/json']!.examples!;
    expect((errors['conflict']!.value as { data: Row }).data).toEqual({ resource: 'risk_rule' });
    expect((errors['unknownRule']!.value as { data: Row }).data).toEqual({ fields: ['rule_id'] });
    expect(errors['stepUpRequired']).toBeUndefined();
  }
});

it('[CT-24f] the examples satisfy the schemas; extra fields and bad values fail', () => {
  const listMedia = okMedia(list());
  const validateList = ajv.compile(listMedia.schema);
  expect(validateList(listMedia.example)).toBe(true);
  const rows = (listMedia.example as { data: { items: Row[] } }).data.items;
  expect(rows.some((r) => (r['threshold_keys'] as unknown[]).length === 0)).toBe(true);
  expect(new Set(rows.map((r) => r['status']))).toEqual(new Set(enums.risk_rule_status));
  expect(validateList({ code: 0, msg: '', data: { items: [] }, trace_id: 'x' })).toBe(true);
  const paged = structuredClone(listMedia.example) as { data: Row };
  paged.data['total'] = 3;
  expect(validateList(paged)).toBe(false);
  const withConditions = structuredClone(listMedia.example) as { data: { items: Row[] } };
  withConditions.data.items[0]!['conditions'] = {};
  expect(validateList(withConditions)).toBe(false);
  const badStatus = structuredClone(listMedia.example) as { data: { items: Row[] } };
  badStatus.data.items[0]!['status'] = 'paused';
  expect(validateList(badStatus)).toBe(false);
  const badAction = structuredClone(listMedia.example) as { data: { items: Row[] } };
  badAction.data.items[0]!['risk_action'] = 'ban';
  expect(validateList(badAction)).toBe(false);
  const oldShape = structuredClone(listMedia.example) as { data: { items: Row[] } };
  oldShape.data.items[0]!['threshold_keys'] = 'risk.device_register_limit';
  expect(validateList(oldShape)).toBe(false);

  for (const [o] of writes()) {
    const media = o.requestBody!.content['application/json']!;
    const validateBody = ajv.compile(media.schema);
    const bodies =
      media.example !== undefined
        ? [media.example]
        : Object.values(media.examples!).map((e) => e.value);
    for (const b of bodies) expect(validateBody(b)).toBe(true);
    expect(validateBody({ expected_version: 1, reason: 'x'.repeat(201) })).toBe(false);
    expect(validateBody({ expected_version: 1, reason: '' })).toBe(false);
    expect(validateBody({ reason: '停用' })).toBe(false);
    expect(validateBody({ expected_version: -1 })).toBe(false);
    expect(validateBody({ expected_version: 1, status: 'enabled' })).toBe(false);
    const ok = okMedia(o);
    expect(ajv.compile(ok.schema)(ok.example)).toBe(true);
  }
  const ruleId = ajv.compile(schema('AdminRiskRuleId'));
  for (const id of ['DEVICE_REGISTER_LIMIT', 'inv_08_self', 'BLACKLIST_PHONE'])
    expect(ruleId(id), id).toBe(true);
  for (const id of ['', '../x', 'a b', '_x']) expect(ruleId(id), id).toBe(false);
});
