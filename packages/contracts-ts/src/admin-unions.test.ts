// CT-24h: admin union accounts and PIDs — /admin/v1/union-accounts (list, OAuth
// re-authorization session start / completion / result, manual credential entry, alert phones)
// and /admin/v1/union-pids (list, register, change a pending row, activate with the 花卷云
// ignore confirmation, retire); 04 §6.6, §11.2, BR-ID-24, BR-ATTR-02. Shape only:
// x-implementation is not asserted, so the implementing task can drop planned. Reads the
// dereferenced contract and validates every example with the API workspace's strict Ajv (as
// admin-user-detail.test.ts does).
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
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Parameter = { name: string; in: string; required?: boolean };
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-idempotent'?: boolean;
  'x-step-up'?: string;
};
type Schema = {
  type?: string | string[];
  enum?: string[];
  required?: string[];
  properties?: Record<string, Schema & { writeOnly?: boolean }>;
  additionalProperties?: boolean;
};
type Document = {
  paths: Record<string, Partial<Record<Method, Operation>>>;
  components: { schemas: Record<string, Schema> };
};
type Ref = { $ref: string };
type RawDocument = {
  paths: Record<
    string,
    Partial<
      Record<Method, { responses: Record<string, { content?: Record<string, { schema: Ref }> }> }>
    >
  >;
};
type ErrorExample = { code: number; data?: Record<string, unknown> };

const A = '/admin/v1/union-accounts';
const P = '/admin/v1/union-pids';
const ACCOUNT = 'union.account_auth';
const PID = 'union.pid';
const READ = [10001, 10403];
const WRITE = [10001, 10003, 10403, 20001];
const OPERATIONS = [
  ['get', A, 'adminListUnionAccounts', READ, ACCOUNT, false],
  [
    'post',
    `${A}/{union_account_id}/reauthorize`,
    'adminStartUnionReauthorization',
    WRITE,
    ACCOUNT,
    true,
  ],
  [
    'get',
    `${A}/{union_account_id}/reauthorize/{session_id}`,
    'adminGetUnionReauthorization',
    [...READ, 20001],
    ACCOUNT,
    false,
  ],
  [
    'post',
    `${A}/oauth/callback`,
    'adminCompleteUnionReauthorization',
    [...READ, 20001],
    ACCOUNT,
    false,
  ],
  ['put', `${A}/{union_account_id}/credential`, 'adminPutUnionCredential', WRITE, ACCOUNT, true],
  ['get', `${A}/alert-phones`, 'adminListUnionAlertPhones', READ, ACCOUNT, false],
  // BR-ID-34: the alert phones are none (no step-up token, no 10003).
  [
    'post',
    `${A}/alert-phones`,
    'adminAddUnionAlertPhone',
    [10001, 10403, 20001, 20902],
    ACCOUNT,
    false,
  ],
  [
    'delete',
    `${A}/alert-phones`,
    'adminRemoveUnionAlertPhone',
    [10001, 10403, 20001, 20902],
    ACCOUNT,
    false,
  ],
  ['get', P, 'adminListUnionPids', READ, PID, false],
  ['post', P, 'adminCreateUnionPid', WRITE, PID, true],
  ['patch', `${P}/{pid_id}`, 'adminUpdateUnionPid', [...WRITE, 20902], PID, true],
  ['post', `${P}/{pid_id}/activate`, 'adminActivateUnionPid', [...WRITE, 20902, 30155], PID, true],
  ['post', `${P}/{pid_id}/retire`, 'adminRetireUnionPid', [...WRITE, 20902], PID, true],
] as const;
const ADMIN_COMMON = [10403, 20001, 42901, 50001];
const ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';

let contract: Document;
let raw: RawDocument;
let ajv: Validator;

beforeAll(async () => {
  const file = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
  contract = (await dereference(file)) as Document;
  raw = parseYamlLite(readFileSync(file, 'utf8')) as RawDocument;
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
});

function operation(method: Method, path: string): Operation {
  const op = contract.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} must exist`).toBeDefined();
  return op!;
}
function examplesOf(media: Media): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (media.example !== undefined) out.push(['example', media.example]);
  for (const [name, ex] of Object.entries(media.examples ?? {})) out.push([name, ex.value]);
  return out;
}
const errorExamples = (op: Operation): ErrorExample[] =>
  examplesOf(op.responses['4XX']!.content!['application/json']!).map(([, v]) => v as ErrorExample);
const schema = (name: string): Schema => contract.components.schemas[name]!;
const compile = (name: string) => ajv.compile(schema(name));
const flat = (text: string) => text.replace(/\s+/g, ' ');
const okSchemaRef = (method: Method, path: string) =>
  raw.paths[path]![method]!.responses['200']!.content!['application/json']!.schema.$ref;

it.each(OPERATIONS)(
  '[CT-24h] %s %s (%s) is an admin operation with its codes and permission point',
  (method, path, operationId, codes, point, stepUp) => {
    const op = operation(method, path);
    expect(op.operationId).toBe(operationId);
    expect(op['x-auth']).toBe('admin');
    expect(op.security).toEqual([{ adminBearerAuth: [] }]);
    expect(op.tags).toEqual(['admin-unions']);
    expect(op['x-error-codes']).toEqual([...codes]);
    // BR-ID-34 sudo list「换绑或重置联盟账号」「改推广位 PID」: the writes with a token are sudo.
    expect(op['x-step-up']).toBe(stepUp ? 'sudo' : undefined);
    expect(op['x-idempotent']).toBeUndefined();
    const names = (op.parameters ?? []).map((p) => p.name.toLowerCase());
    expect(names).not.toContain('idempotency-key');
    const header = (op.parameters ?? []).find((p) => p.name.toLowerCase() === 'x-step-up-token');
    if (stepUp) expect(header).toMatchObject({ in: 'header', required: false });
    else expect(header).toBeUndefined();
    expect(enums.admin_permission).toContain(point);
    expect(op.description).toContain(`\`${point}\``);
    for (const code of codes)
      expect(errorCodes[code as keyof typeof errorCodes], String(code)).toBeDefined();
  },
);

it('[CT-24h] every write with step-up needs the sudo tier and shows the 10003 sudo example', () => {
  for (const [method, path, , , , stepUp] of OPERATIONS) {
    if (!stepUp) continue;
    const op = operation(method, path);
    expect(flat(op.description), path).toContain('Step-up: sudo');
    expect(flat(op.description), path).toContain('`data.tier=sudo`');
    expect(
      errorExamples(op).filter((e) => e.code === 10003),
      path,
    ).toEqual([expect.objectContaining({ data: { tier: 'sudo' } })]);
  }
});

it('[CT-24h] request, 200 and error examples satisfy their schemas; errors use listed codes and data', () => {
  for (const [method, path] of OPERATIONS) {
    const op = operation(method, path);
    const json = op.requestBody?.content['application/json'];
    if (json !== undefined) {
      const validate = ajv.compile(json.schema);
      expect(examplesOf(json).length, path).toBeGreaterThan(0);
      for (const [name, value] of examplesOf(json)) {
        expect(validate(value), `${path} request ${name}`).toBe(true);
      }
    }
    const ok = op.responses['200']!.content!['application/json']!;
    const validateOk = ajv.compile(ok.schema);
    expect(examplesOf(ok).length, path).toBeGreaterThan(0);
    for (const [name, value] of examplesOf(ok)) {
      expect(validateOk(value), `${path} 200 ${name}`).toBe(true);
    }
    const allowed = new Set([...op['x-error-codes'], ...ADMIN_COMMON]);
    const media = op.responses['4XX']!.content!['application/json']!;
    const validate = ajv.compile(media.schema);
    for (const [name, value] of examplesOf(media)) {
      expect(validate(value), `${path} 4XX ${name}`).toBe(true);
      const { code, data } = value as ErrorExample;
      expect(allowed.has(code), `${path} ${name} ${code}`).toBe(true);
      const def = errorCodes[code as keyof typeof errorCodes];
      for (const [field, v] of Object.entries(data ?? {})) {
        const listed = (def.data as Record<string, readonly string[] | null>)[field];
        expect(listed, `${path} ${name} data.${field}`).not.toBeUndefined();
        if (Array.isArray(listed)) expect(listed, `${path} ${name}`).toContain(v);
      }
    }
  }
});

it('[CT-24h] 200 examples never carry a full phone number or a long digit token', () => {
  for (const [method, path] of OPERATIONS) {
    const ok = operation(method, path).responses['200']!.content!['application/json']!;
    for (const [name, value] of examplesOf(ok)) {
      expect(JSON.stringify(value), `${path} ${name}`).not.toMatch(/\d{11,}/);
    }
  }
});

it('[CT-24h] the new enums match their contract schemas', () => {
  expect(enums.union_auth_status).toEqual(['active', 'expiring', 'expired']);
  expect(enums.union_reauth_mode).toEqual(['oauth', 'manual', 'none']);
  expect(enums.admin_union_auth_session_status).toEqual([
    'pending',
    'succeeded',
    'failed',
    'expired',
  ]);
  expect(enums.union_pid_status).toEqual(['pending', 'active', 'retired']);
  expect(schema('AdminUnionAuthStatus').enum).toEqual(enums.union_auth_status);
  expect(schema('AdminUnionReauthMode').enum).toEqual(enums.union_reauth_mode);
  expect(schema('AdminUnionAuthSessionStatus').enum).toEqual(enums.admin_union_auth_session_status);
  expect(schema('AdminUnionPidStatus').enum).toEqual(enums.union_pid_status);
  expect(schema('AdminUnionPidScene').enum).toEqual(enums.pid_scene);
});

it('[CT-24h] an account row has the 04 §6.6 fields and never alert_stage or a credential', () => {
  const account = schema('AdminUnionAccount');
  expect(account.additionalProperties).toBe(false);
  expect([...account.required!].sort()).toEqual(
    [
      'union_account_id',
      'platform',
      'account_name',
      'status',
      'sync_start_at',
      'auth_expires_at',
      'auth_expires_estimated',
      'auth_status',
      'auth_renewed_at',
      'auth_renewed_by',
      'last_probe_at',
      'last_probe_ok',
      'last_probe_error',
      'alert_phones_configured',
      'reauth_mode',
    ].sort(),
  );
  for (const name of ['alert_stage', 'credential', 'access_token', 'refresh_token']) {
    expect(account.properties![name], name).toBeUndefined();
  }
  const row = compile('AdminUnionAccount');
  const item = {
    union_account_id: ID,
    platform: 'taobao',
    account_name: '凑狸淘宝联盟',
    status: 'active',
    sync_start_at: null,
    auth_expires_at: null,
    auth_expires_estimated: false,
    auth_status: 'expired',
    auth_renewed_at: null,
    auth_renewed_by: null,
    last_probe_at: null,
    last_probe_ok: null,
    last_probe_error: null,
    alert_phones_configured: false,
    reauth_mode: 'none',
  };
  expect(row(item)).toBe(true);
  expect(row({ ...item, alert_stage: 'd7' })).toBe(false);
  expect(row({ ...item, auth_status: 'd7' })).toBe(false);
  expect(row({ ...item, reauth_mode: 'sms' })).toBe(false);
});

it('[CT-24h] the credential and the OAuth result go in, never come back out', () => {
  expect(schema('AdminUnionCredentialRequest').properties!['credential']!.writeOnly).toBe(true);
  const credential = compile('AdminUnionCredentialRequest');
  expect(credential({ credential: 'demo-key' })).toBe(true);
  expect(
    credential({ credential: 'demo-key', expires_at: '2027-01-20T00:00:00+08:00', reason: '换' }),
  ).toBe(true);
  expect(credential({ credential: '' })).toBe(false);
  expect(credential({ credential: ' demo-key' })).toBe(false);
  expect(credential({ credential: 'x'.repeat(513) })).toBe(false);
  expect(credential({ expires_at: '2027-01-20T00:00:00+08:00' })).toBe(false);
  expect(credential({ credential: 'demo-key', reason: '' })).toBe(false);
  expect(okSchemaRef('put', `${A}/{union_account_id}/credential`)).toBe(
    '#/components/schemas/AdminUnionAccountResponse',
  );

  expect(schema('AdminUnionOAuthCallbackRequest').properties!['code']!.writeOnly).toBe(true);
  const callback = compile('AdminUnionOAuthCallbackRequest');
  expect(callback({ state: 's', code: 'c' })).toBe(true);
  expect(callback({ state: 's', error: 'access_denied' })).toBe(true);
  expect(callback({ state: 's' })).toBe(false);
  expect(callback({ state: 's', code: 'c', error: 'access_denied' })).toBe(false);
  expect(callback({ code: 'c' })).toBe(false);
  const result = '#/components/schemas/AdminUnionReauthResultResponse';
  expect(okSchemaRef('post', `${A}/oauth/callback`)).toBe(result);
  expect(okSchemaRef('get', `${A}/{union_account_id}/reauthorize/{session_id}`)).toBe(result);
  const session = schema('AdminUnionReauthResult');
  for (const name of ['state', 'code', 'credential']) {
    expect(session.properties![name], name).toBeUndefined();
  }
});

it('[CT-24h] re-authorization starts with an optional reason and answers session, address and expiry', () => {
  const start = compile('AdminUnionReauthorizeRequest');
  expect(start({})).toBe(true);
  expect(start({ reason: '提前续期' })).toBe(true);
  expect(start({ reason: 'x'.repeat(201) })).toBe(false);
  expect(start({ union_account_id: ID })).toBe(false);
  expect([...schema('AdminUnionReauthSession').required!].sort()).toEqual([
    'auth_url',
    'expires_at',
    'session_id',
  ]);
  const text = flat(operation('post', `${A}/{union_account_id}/reauthorize`).description);
  expect(text).toContain('`reauth_mode=none`');
  expect(text).toContain('`reauth_mode=manual`');
  expect(text).toContain('valid 10 minutes');
  expect(text).toContain('`data.reason=manual_mode`');
});

it('[CT-24h] a manual account calling reauthorize is 20001 with data.reason=manual_mode (D10-176)', () => {
  expect(errorCodes[20001].data.reason).toContain('manual_mode');
  const examples = errorExamples(operation('post', `${A}/{union_account_id}/reauthorize`));
  expect(examples).toContainEqual(
    expect.objectContaining({
      code: 20001,
      data: { fields: ['union_account_id'], reason: 'manual_mode' },
    }),
  );
  // reauth_mode=none and an unknown account stay 20001 without a reason.
  expect(examples).toContainEqual(
    expect.objectContaining({ code: 20001, data: { fields: ['union_account_id'] } }),
  );
});

it('[CT-24h] alert phones: masked only, removed by phone_id and expected_version in the query', () => {
  const phone = schema('AdminUnionAlertPhone');
  expect([...phone.required!].sort()).toEqual(['phone_id', 'phone_masked']);
  expect(phone.additionalProperties).toBe(false);
  const list = compile('AdminUnionAlertPhones');
  const item = { phone_id: 'hm-7c1e9a3f5b2d4e6a8c0b', phone_masked: '138****5678' };
  expect(list({ version: 0, items: [] })).toBe(true);
  expect(list({ version: 3, items: [item] })).toBe(true);
  expect(list({ version: 3, items: [{ ...item, phone: '13800005678' }] })).toBe(false);
  expect(list({ version: 3, items: Array.from({ length: 11 }, () => item) })).toBe(false);

  const add = compile('AdminUnionAlertPhoneAddRequest');
  expect(add({ phone: '13900002222', expected_version: 3 })).toBe(true);
  expect(add({ phone: '13900002222' })).toBe(false);
  expect(add({ phone: '13900002222', expected_version: -1 })).toBe(false);

  const remove = operation('delete', `${A}/alert-phones`);
  expect(remove.requestBody).toBeUndefined();
  const query = (remove.parameters ?? []).filter((p) => p.in === 'query');
  expect(query.map((p) => [p.name, p.required])).toEqual([
    ['phone_id', true],
    ['expected_version', true],
  ]);
  for (const path of Object.keys(contract.paths)) {
    expect(path.startsWith(`${A}/alert-phones/`), path).toBe(false);
  }
  for (const method of ['post', 'delete'] as const) {
    const text = flat(operation(method, `${A}/alert-phones`).description);
    expect(text).toContain('`data.resource=config_item`');
    expect(
      errorExamples(operation(method, `${A}/alert-phones`)).some(
        (e) => e.code === 20902 && e.data?.['resource'] === 'config_item',
      ),
    ).toBe(true);
  }
  expect(errorCodes[20001].data.reason).toContain('phone_invalid');
});

it('[CT-24h] PID rows and requests: pending-only change, multipart activation, retire', () => {
  const row = compile('AdminUnionPid');
  const pid = {
    pid_id: ID,
    platform: 'jd',
    union_account_id: ID,
    site_id: null,
    pid: '4002',
    pid_scene: 'share',
    status: 'pending',
    hjy_ignore_confirmed_at: null,
    hjy_ignore_evidence_path: null,
    row_version: 0,
    created_at: '2026-10-20T11:00:00+08:00',
  };
  expect(row(pid)).toBe(true);
  expect(row({ ...pid, status: 'deleted' })).toBe(false);
  expect(row({ ...pid, pid_scene: 'search' })).toBe(false);

  const create = compile('AdminUnionPidCreateRequest');
  const body = { platform: 'jd', union_account_id: ID, pid: '4002', pid_scene: 'share' };
  expect(create(body)).toBe(true);
  expect(create({ ...body, site_id: null })).toBe(true);
  expect(create({ ...body, pid: '' })).toBe(false);
  expect(create({ ...body, pid: '40 02' })).toBe(false);
  expect(create({ ...body, status: 'active' })).toBe(false);
  expect(create({ platform: 'jd', union_account_id: ID, pid: '4002' })).toBe(false);

  const update = compile('AdminUnionPidUpdateRequest');
  expect(update({ pid: '4003', expected_row_version: 0 })).toBe(true);
  expect(update({ expected_row_version: 0 })).toBe(false);
  expect(update({ pid: '4003' })).toBe(false);
  expect(update({ status: 'active', expected_row_version: 0 })).toBe(false);

  const activate = operation('post', `${P}/{pid_id}/activate`);
  expect(Object.keys(activate.requestBody!.content)).toEqual(['multipart/form-data']);
  expect([...schema('AdminUnionPidActivateRequest').required!].sort()).toEqual([
    'expected_row_version',
    'hjy_ignore_confirmed_at',
    'hjy_ignore_evidence',
  ]);
  expect(flat(activate.description)).toContain('PNG or JPEG, at most 5 MB');

  const retire = compile('AdminUnionPidRetireRequest');
  expect(retire({ expected_row_version: 1 })).toBe(true);
  expect(retire({})).toBe(false);

  for (const path of [P, `${P}/{pid_id}`]) {
    expect(contract.paths[path]?.delete, path).toBeUndefined();
  }
  for (const [method, path] of [
    ['patch', `${P}/{pid_id}`],
    ['post', `${P}/{pid_id}/activate`],
    ['post', `${P}/{pid_id}/retire`],
  ] as const) {
    expect(okSchemaRef(method, path)).toBe('#/components/schemas/AdminUnionPidResponse');
    expect(
      errorExamples(operation(method, path)).some(
        (e) => e.code === 20902 && e.data?.['resource'] === 'union_pid',
      ),
      path,
    ).toBe(true);
  }
});

it('[CT-24h] 30155 is the one-active-per-scene refusal of activation only; 20902 adds union_pid', () => {
  expect(errorCodes[30155]).toMatchObject({ http: 422, retry_kind: 'never', deprecated: false });
  expect(errorCodes[30155].sources).toContain('BR-ATTR-02');
  expect(errorCodes[20902].data.resource).toContain('union_pid');
  const activate = operation('post', `${P}/{pid_id}/activate`);
  expect(errorExamples(activate).map((e) => e.code)).toContain(30155);
  const text = flat(activate.description);
  expect(text.indexOf('`data.resource=union_pid`')).toBeLessThan(text.indexOf('30155'));
  for (const [path, item] of Object.entries(contract.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'post' && path === `${P}/{pid_id}/activate`) continue;
      expect(op['x-error-codes'] ?? [], `${method} ${path}`).not.toContain(30155);
    }
  }
});
