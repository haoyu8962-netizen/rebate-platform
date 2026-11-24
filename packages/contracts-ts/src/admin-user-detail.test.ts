// CT-24e: the user detail additions — GET /admin/v1/users/{user_id}/invitees (direct invitees,
// 04 §6.6), POST …/level (user.level, BR-INV-14) and POST …/inviter (user.inviter, BR-INV-10);
// 04 §11.2 (reason; no step-up, BR-ID-34: none). Shape only: x-implementation is not asserted, so the
// implementing task can drop planned. Reads the dereferenced contract and validates every example
// with the API workspace's strict Ajv (as admin-users.test.ts does).
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
type Method = 'get' | 'post';
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { required: boolean; content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-error-codes': number[];
  'x-idempotent'?: boolean;
  'x-step-up'?: string;
};
type Document = {
  paths: Record<string, Partial<Record<Method, Operation>>>;
  components: { schemas: Record<string, object> };
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

const U = '/admin/v1/users/{user_id}';
const OPERATIONS = [
  [
    'get',
    `${U}/invitees`,
    'adminListInvitees',
    [10001, 10403, 20001],
    ['user.lookup', 'user.list'],
  ],
  ['post', `${U}/level`, 'adminChangeUserLevel', [10001, 10403, 20001], ['user.level']],
  [
    'post',
    `${U}/inviter`,
    'adminChangeInviter',
    [10001, 10403, 20001, 30409, 30401, 30403],
    ['user.inviter'],
  ],
] as const;
const ADMIN_COMMON = [10403, 20001, 42901, 50001];
const ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';

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
const compile = (name: string) => ajv.compile(contract.components.schemas[name]!);
const flat = (text: string) => text.replace(/\s+/g, ' ');

it.each(OPERATIONS)(
  '[CT-24e] %s %s (%s) is an admin operation with its codes and permission points',
  (method, path, operationId, codes, points) => {
    const op = operation(method, path);
    expect(op.operationId).toBe(operationId);
    expect(op['x-auth']).toBe('admin');
    expect(op.security).toEqual([{ adminBearerAuth: [] }]);
    expect(op.tags).toEqual(['admin-users']);
    expect(op['x-error-codes']).toEqual([...codes]);
    expect(op['x-step-up']).toBeUndefined();
    expect(op['x-idempotent']).toBeUndefined();
    const names = (op.parameters ?? []).map((p) => p.name.toLowerCase());
    expect(names).not.toContain('idempotency-key');
    const header = (op.parameters ?? []).find((p) => p.name.toLowerCase() === 'x-step-up-token');
    // BR-ID-34: level and inviter changes are none, so no operation takes a step-up token.
    expect(header).toBeUndefined();
    for (const point of points) {
      expect(enums.admin_permission).toContain(point);
      expect(op.description, point).toContain(`\`${point}\``);
    }
    for (const code of codes) expect(errorCodes[code], String(code)).toBeDefined();
  },
);

it('[CT-24e] neither write asks for step-up nor shows a 10003 example (BR-ID-34: none)', () => {
  for (const path of [`${U}/level`, `${U}/inviter`]) {
    const op = operation('post', path);
    expect(flat(op.description), path).not.toMatch(/totp tier|X-Step-Up-Token|data\.tier|10003/);
    expect(
      errorExamples(op).filter((e) => e.code === 10003),
      path,
    ).toEqual([]);
  }
});

it('[CT-24e] request, 200 and error examples satisfy their schemas; errors use listed codes and data', () => {
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

it('[CT-24e] the writes answer with the user detail schema of GET /admin/v1/users/{user_id}', () => {
  const detail = raw.paths[U]!.get!.responses['200']!.content!['application/json']!.schema.$ref;
  expect(detail).toBe('#/components/schemas/AdminUserDetailResponse');
  for (const path of [`${U}/level`, `${U}/inviter`]) {
    expect(raw.paths[path]!.post!.responses['200']!.content!['application/json']!.schema.$ref).toBe(
      detail,
    );
  }
});

it('[CT-24e] the inviter change follows the BR-INV-10 order: 30409, then 30401, then 30403', () => {
  const op = operation('post', `${U}/inviter`);
  const text = flat(op.description);
  const at = (s: string) => text.indexOf(s);
  expect(at('else 30409')).toBeGreaterThan(0);
  expect(at('else 30409')).toBeLessThan(at('else 30401'));
  expect(at('else 30401')).toBeLessThan(at('else 30403'));
  expect(text).toContain('BR-INV-10');
  expect(text).toContain('growth.invite_bind.enabled');
  expect(text).toContain('parent_bind_source = admin');
  expect(text).toContain('self_bind_used = true');
  const codes = errorExamples(op).map((e) => e.code);
  for (const code of [30409, 30401, 30403]) expect(codes).toContain(code);
});

it('[CT-24e] level body: level L1 / L2 / L3 and a 1–200 character reason, nothing else', () => {
  const validate = compile('AdminUserLevelChangeRequest');
  expect(validate({ level: 'L2', reason: '调级' })).toBe(true);
  expect(validate({ level: 'L4', reason: '调级' })).toBe(false);
  expect(validate({ level: 'L2' })).toBe(false);
  expect(validate({ reason: '调级' })).toBe(false);
  expect(validate({ level: 'L2', reason: '' })).toBe(false);
  expect(validate({ level: 'L2', reason: 'x'.repeat(201) })).toBe(false);
  expect(validate({ level: 'L2', reason: '调级', user_id: ID })).toBe(false);
});

it('[CT-24e] inviter body: inviter_user_id (null removes) and a required reason', () => {
  const validate = compile('AdminUserInviterChangeRequest');
  expect(validate({ inviter_user_id: ID, reason: '改正' })).toBe(true);
  expect(validate({ inviter_user_id: null, reason: '解除' })).toBe(true);
  expect(validate({ reason: '改正' })).toBe(false);
  expect(validate({ inviter_user_id: ID })).toBe(false);
  expect(validate({ inviter_user_id: ID, reason: '改正', invite_code: 'K7QX2M' })).toBe(false);
});

it('[CT-24e] invitee rows hold the 04 §6.6 fields only, with the phone masked or null', () => {
  const row = compile('AdminInviteeListItem');
  const item = {
    user_id: ID,
    phone_masked: '138****5678',
    nickname: '凑狸用户5678',
    registered_at: '2026-10-12T09:00:00+08:00',
    level: 'L1',
  };
  expect(row(item)).toBe(true);
  expect(row({ ...item, phone_masked: null })).toBe(true);
  expect(row({ ...item, phone: '13800005678' })).toBe(false);
  expect(row({ ...item, member_tier: 'gold' })).toBe(false);
  for (const field of Object.keys(item)) {
    const partial: Record<string, unknown> = { ...item };
    delete partial[field];
    expect(row(partial), `missing ${field}`).toBe(false);
  }
  const page = compile('AdminInviteePage');
  expect(page({ items: [item], page: 1, page_size: 20, total: 1 })).toBe(true);
  expect(page({ items: [item], page: 1, page_size: 201, total: 1 })).toBe(false);
});
