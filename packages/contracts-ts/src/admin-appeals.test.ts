// CT-24r: the admin appeal console — GET / POST /admin/v1/appeals, GET /admin/v1/appeals/{appeal_id},
// POST …/claim, POST …/resolve and GET /admin/v1/blocked-requests (04 §6.6 appeals, §3.2 appeals
// and risk_hits, §11.2 risk.appeal; BR-ID-36, BR-ID-31). x-implementation is not asserted, so the
// implementing task can drop planned. Reads the dereferenced contract and validates the examples
// with the API workspace's strict Ajv (same loader as the admin-risk-rules test).
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

const LIST = '/admin/v1/appeals';
const ONE = '/admin/v1/appeals/{appeal_id}';
const CLAIM = '/admin/v1/appeals/{appeal_id}/claim';
const RESOLVE = '/admin/v1/appeals/{appeal_id}/resolve';
const BLOCKED = '/admin/v1/blocked-requests';

function op(path: string, method: 'get' | 'post'): Operation {
  const found = contract.paths[path]?.[method];
  expect(found, `${method.toUpperCase()} ${path} must exist`).toBeDefined();
  return found!;
}
const okMedia = (o: Operation): Media => o.responses['200']!.content!['application/json']!;
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const schema = (name: string): Schema => contract.components.schemas[name]!;
const names = (o: Operation): string[] => (o.parameters ?? []).map((p) => p.name);
const errors = (o: Operation): Record<string, { value: unknown }> =>
  o.responses['4XX']!.content!['application/json']!.examples!;

it('[CT-24r] six admin operations under risk.appeal with the codes of 04 §6.6', () => {
  const table: [string, 'get' | 'post', string, number[]][] = [
    [LIST, 'get', 'adminListAppeals', [10001, 10403, 20001]],
    [LIST, 'post', 'adminRegisterAppeal', [10001, 10403, 20001, 30418]],
    [ONE, 'get', 'adminGetAppeal', [10001, 10403, 20001]],
    [CLAIM, 'post', 'adminClaimAppeal', [10001, 10403, 20001, 20902]],
    [RESOLVE, 'post', 'adminResolveAppeal', [10001, 10003, 10403, 20001, 20902]],
    [BLOCKED, 'get', 'adminListBlockedRequests', [10001, 10403, 20001]],
  ];
  for (const [path, method, id, codes] of table) {
    const o = op(path, method);
    expect(o.operationId).toBe(id);
    expect(o['x-auth']).toBe('admin');
    expect(o.security).toEqual([{ adminBearerAuth: [] }]);
    expect(o.tags).toEqual(['admin-appeals']);
    expect(o['x-error-codes']).toEqual(codes);
    expect(o['x-step-up'], id).toBe(id === 'adminResolveAppeal' ? 'sudo' : undefined);
    expect(o['x-idempotent']).toBeUndefined();
    expect(names(o)).not.toContain('Idempotency-Key');
    expect(names(o).includes('X-Step-Up-Token'), id).toBe(id === 'adminResolveAppeal');
    const text = flat(o.description);
    expect(text).toContain('`risk.appeal`');
    expect(text).toContain('10403 with `data.reason=admin_permission_denied`');
  }
  expect(raw.tags.map((t) => t.name)).toContain('admin-appeals');
  expect(enums.admin_permission).toEqual(
    expect.arrayContaining(['risk.appeal', 'risk.ban', 'risk.freeze', 'risk.blocklist']),
  );
});

it('[CT-24r] the list filters status, overdue, target_type and q; counts ignore status and overdue', () => {
  const o = op(LIST, 'get');
  expect(names(o)).toEqual([
    'X-Trace-Id',
    'page',
    'page_size',
    'status',
    'overdue',
    'target_type',
    'q',
  ]);
  const page = schema('AdminAppealPage');
  expect(page.required).toEqual(['items', 'page', 'page_size', 'total', 'counts']);
  expect(schema('AdminAppealCounts').required).toEqual(['processing', 'overdue', 'closed', 'all']);
  const text = flat(o.description);
  expect(text).toContain('every filter of the request except `status` and `overdue`');
  expect(text).toContain('20001 with `data.fields=[q]`');
  expect(text).toContain('never the full number');
});

it('[CT-24r] claim and resolve take expected_row_version; a mismatch is 20902 appeal', () => {
  expect(errorCodes[20902].data.resource).toContain('appeal');
  for (const path of [CLAIM, RESOLVE]) {
    const o = op(path, 'post');
    expect(flat(o.description)).toContain('20902 with `data.resource=appeal`');
    expect((errors(o)['conflict']!.value as { data: Row }).data).toEqual({ resource: 'appeal' });
    expect((errors(o)['unknownAppeal']!.value as { data: Row }).data).toEqual({
      fields: ['appeal_id'],
    });
  }
  expect(schema('AdminAppealClaimRequest').required).toEqual(['expected_row_version']);
  expect(flat(op(CLAIM, 'post').description)).toContain('not a lock (编排裁定 D10-158)');
  const body = schema('AdminAppealResolveRequest');
  expect(body.required).toEqual(['decision', 'note', 'expected_row_version']);
  expect(body.additionalProperties).toBe(false);
  expect([...schema('AdminAppealDecision').enum!]).toEqual(['upheld', 'revoked']);
});

it('[CT-24r] revoking a ban, a freeze or a blocklist block needs the extra point; only a freeze needs a sudo step-up', () => {
  const text = flat(op(RESOLVE, 'post').description);
  for (const point of ['`risk.ban`', '`risk.freeze`', '`risk.blocklist`'])
    expect(text).toContain(point);
  expect(text).toContain('Only revoking a freeze also needs step-up: sudo');
  expect(text).toContain('10003 with `data.tier=sudo`');
  expect(text).toContain('Revoking a ban or a blocklist block needs its point but no step-up');
  expect(text).toContain('编排裁定 D10-154');
  expect([...schema('AdminAppealRevokePermission').enum!]).toEqual([
    'risk.ban',
    'risk.freeze',
    'risk.blocklist',
  ]);
  expect((errors(op(RESOLVE, 'post'))['stepUpRequired']!.value as { data: Row }).data).toEqual({
    tier: 'sudo',
  });
});

it('[CT-24r] registering derives the appellant, returns a processing original and refuses with 30418', () => {
  const o = op(LIST, 'post');
  const text = flat(o.description);
  expect(text).toContain('20001 with `data.fields=[user_id]`');
  expect(text).toContain('20001 with `data.fields=[target_id]`');
  expect(text).toContain('returns that original appeal and creates nothing');
  expect(text).toContain('→ 30418');
  const body = schema('AdminAppealRegisterRequest');
  expect(body.required).toEqual(['target_type', 'target_id', 'content', 'reason']);
  expect(Object.keys(body.properties!)).toEqual([
    'target_type',
    'target_id',
    'content',
    'reason',
    'user_id',
  ]);
  const used = errors(o)['attemptsUsedUp']!.value as Row;
  expect(used['code']).toBe(30418);
  expect(used).not.toHaveProperty('data');
});

it('[CT-24r] admin enums mirror contracts/enums; blocked_request_type stays out of the conformance tables', () => {
  expect([...schema('AdminAppealTargetType').enum!]).toEqual([...enums.appeal_target_type]);
  expect([...schema('AdminBlockedRequestType').enum!]).toEqual([...enums.blocked_request_type]);
  expect([...schema('AdminAppealSource').enum!]).toEqual([...enums.appeal_source]);
  expect([...schema('AdminBlockedRequestCause').enum!]).toEqual([...enums.blocked_request_cause]);
  expect([...schema('AdminBlocklistDimension').enum!]).toEqual([...enums.blocklist_dimension]);
  expect([...schema('AdminRiskHitRefType').enum!]).toEqual([...enums.risk_hit_ref_type]);
  expect([...schema('AdminAppealPrevRiskState').enum!]).toEqual(['frozen', 'banned']);
  for (const [name, s] of Object.entries(raw.components.schemas)) {
    if (!/^Admin(Appeal|BlockedRequest)/.test(name) || !('properties' in s)) continue;
    expect(s.additionalProperties, name).toBe(false);
  }
});

it('[CT-24r] the blocked request lookup takes exactly one of phone, user_id and blocked_request_id', () => {
  const o = op(BLOCKED, 'get');
  expect(names(o)).toEqual([
    'X-Trace-Id',
    'page',
    'page_size',
    'phone',
    'user_id',
    'blocked_request_id',
  ]);
  expect((errors(o)['lookupInvalid']!.value as { data: Row }).data).toEqual({
    fields: ['phone', 'user_id', 'blocked_request_id'],
  });
  expect((errors(o)['phoneInvalid']!.value as { data: Row }).data).toEqual({
    fields: ['phone'],
    reason: 'phone_invalid',
  });
  const text = flat(o.description);
  expect(text).toContain('writes an audit record');
  expect(schema('AdminBlockedRequest').required).toEqual([
    'blocked_request_id',
    'request_type',
    'phone_masked',
    'blocked_at',
    'cause',
    'blocklist_dimension',
    'amount_fen',
    'processing_appeal_id',
  ]);
});

it('[CT-24r] the examples satisfy the schemas; full numbers, hit values and bad values fail', () => {
  const listMedia = okMedia(op(LIST, 'get'));
  const validateList = ajv.compile(listMedia.schema);
  expect(validateList(listMedia.example)).toBe(true);
  const withPhone = structuredClone(listMedia.example) as { data: { items: Row[] } };
  withPhone.data.items[0]!['phone'] = '13800005678';
  expect(validateList(withPhone)).toBe(false);
  const badStatus = structuredClone(listMedia.example) as { data: { items: Row[] } };
  badStatus.data.items[0]!['status'] = 'pending';
  expect(validateList(badStatus)).toBe(false);

  const detailOps: Operation[] = [
    op(LIST, 'post'),
    op(ONE, 'get'),
    op(CLAIM, 'post'),
    op(RESOLVE, 'post'),
  ];
  for (const o of detailOps) {
    const ok = okMedia(o);
    const validate = ajv.compile(ok.schema);
    expect(validate(ok.example), o.operationId).toBe(true);
    const leaked = structuredClone(ok.example) as { data: { risk_hits: Row[] } };
    leaked.data.risk_hits[0]!['value_hmac'] = 'a'.repeat(64);
    expect(validate(leaked)).toBe(false);
    const media = o.requestBody?.content['application/json'];
    if (media === undefined) continue;
    const validateBody = ajv.compile(media.schema);
    const bodies =
      media.example !== undefined
        ? [media.example]
        : Object.values(media.examples!).map((e) => e.value);
    for (const b of bodies) expect(validateBody(b), o.operationId).toBe(true);
  }
  const resolve = ajv.compile(op(RESOLVE, 'post').requestBody!.content['application/json']!.schema);
  expect(resolve({ decision: 'processing', note: '维持', expected_row_version: 1 })).toBe(false);
  expect(resolve({ decision: 'upheld', note: 'x'.repeat(201), expected_row_version: 1 })).toBe(
    false,
  );
  expect(resolve({ decision: 'upheld', note: '', expected_row_version: 1 })).toBe(false);
  expect(resolve({ decision: 'upheld', note: '维持' })).toBe(false);
  const register = ajv.compile(op(LIST, 'post').requestBody!.content['application/json']!.schema);
  expect(register({ target_type: 'account', target_id: 'u1', content: '申诉' })).toBe(false);
  expect(
    register({ target_type: 'ticket', target_id: 'u1', content: '申诉', reason: '客服登记' }),
  ).toBe(false);

  const blockedMedia = okMedia(op(BLOCKED, 'get'));
  const validateBlocked = ajv.compile(blockedMedia.schema);
  expect(validateBlocked(blockedMedia.example)).toBe(true);
  const floatAmount = structuredClone(blockedMedia.example) as { data: { items: Row[] } };
  floatAmount.data.items[0]!['amount_fen'] = 50.5;
  expect(validateBlocked(floatAmount)).toBe(false);
  const badCause = structuredClone(blockedMedia.example) as { data: { items: Row[] } };
  badCause.data.items[0]!['cause'] = 'device_limit';
  expect(validateBlocked(badCause)).toBe(false);
});
