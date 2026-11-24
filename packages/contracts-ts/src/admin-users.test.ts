// CT-02j: /admin/v1/users — list, lookup, detail, audited reveal, risk state and the union binding
// reset / disable / enable (04 §6.6, §11.1, §11.2; 05 F1-07). Shape only: x-implementation is not
// asserted, so the F1-07 implementations can drop planned. Reads the dereferenced contract and
// validates every example with the API workspace's strict Ajv (as admin-config.test.ts does).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { enums, errorCodes } from './index.ts';

const testRequire = createRequire(import.meta.url);
const { checkConformance } = testRequire('../scripts/conformance.ts') as {
  checkConformance(enums: unknown, codes: unknown): string[];
};
const { loadEnums, loadErrorCodes } = testRequire('../scripts/catalog.ts') as {
  loadEnums(): unknown;
  loadErrorCodes(): { codes: unknown };
};

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
type Method = 'get' | 'post' | 'put';
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { required: boolean; content: Record<string, Media> };
  responses: Record<
    string,
    { content?: Record<string, Media>; headers?: Record<string, { schema?: { enum?: string[] } }> }
  >;
  'x-auth': string;
  'x-error-codes': number[];
  'x-idempotent'?: boolean;
  'x-step-up'?: string;
};
type Document = {
  paths: Record<string, Partial<Record<Method, Operation>>>;
  components: { schemas: Record<string, object> };
};

const U = '/admin/v1/users';
const B = `${U}/{user_id}/union-bindings/{platform}`;
const READ = [10001, 10403, 20001];
const BINDING = [10001, 10003, 10403, 20001, 20902, 30154];
/** Disable and enable are none (BR-ID-34): no step-up token, no 10003. */
const BINDING_NONE = [10001, 10403, 20001, 20902, 30154];
/** BR-ID-34 sudo list: reveal, unfreeze (risk-state) and the binding reset. */
const SUDO = new Set([
  'adminRevealUserField',
  'adminUpdateUserRiskState',
  'adminResetUserUnionBinding',
]);
/** The eight operations of CT-02j (task §9.2): codes and the permission points named. */
const OPERATIONS = [
  ['get', U, 'adminListUsers', READ, ['user.list']],
  ['get', `${U}/lookup`, 'adminLookupUser', READ, ['user.lookup']],
  ['get', `${U}/{user_id}`, 'adminGetUser', READ, ['user.list', 'user.lookup']],
  [
    'post',
    `${U}/{user_id}/reveal`,
    'adminRevealUserField',
    [10001, 10003, 10403, 20001],
    ['pii.reveal_phone'],
  ],
  [
    'put',
    `${U}/{user_id}/risk-state`,
    'adminUpdateUserRiskState',
    [10001, 10003, 10403, 20001, 20902, 44004],
    ['risk.ban', 'risk.freeze'],
  ],
  ['post', `${B}/reset`, 'adminResetUserUnionBinding', BINDING, ['union.binding_reset']],
  ['post', `${B}/disable`, 'adminDisableUserUnionBinding', BINDING_NONE, ['union.binding_disable']],
  ['post', `${B}/enable`, 'adminEnableUserUnionBinding', BINDING_NONE, ['union.binding_disable']],
] as const;
const WRITES = OPERATIONS.filter(([method]) => method !== 'get');
const SUDO_WRITES = WRITES.filter(([, , operationId]) => SUDO.has(operationId));
const ADMIN_COMMON = [10403, 20001, 42901, 50001];

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

type ErrorExample = { code: number; data?: Record<string, unknown> };
function errorExamples(op: Operation): ErrorExample[] {
  return examplesOf(op.responses['4XX']!.content!['application/json']!).map(
    ([, v]) => v as ErrorExample,
  );
}

const compile = (name: string) => ajv.compile(contract.components.schemas[name]!);
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('user operations (04 §11.1, §11.2)', () => {
  it.each(OPERATIONS)(
    '[CT-02j] %s %s (%s) is an admin operation without Idempotency-Key',
    (method, path, operationId, codes, points) => {
      const op = operation(method, path);
      expect(op.operationId).toBe(operationId);
      expect(op['x-auth']).toBe('admin');
      expect(op.security).toEqual([{ adminBearerAuth: [] }]);
      expect(op.tags).toEqual(['admin-users']);
      expect(op['x-error-codes']).toEqual([...codes]);
      expect(op['x-step-up']).toBe(SUDO.has(operationId) ? 'sudo' : undefined);
      expect(op['x-idempotent']).toBeUndefined();
      const names = (op.parameters ?? []).map((p) => p.name.toLowerCase());
      expect(names).not.toContain('idempotency-key');
      const header = (op.parameters ?? []).find((p) => p.name.toLowerCase() === 'x-step-up-token');
      if (SUDO.has(operationId)) expect(header).toMatchObject({ in: 'header', required: false });
      else expect(header).toBeUndefined();
      for (const point of points) {
        expect(enums.admin_permission).toContain(point);
        expect(op.description, point).toContain(`\`${point}\``);
      }
    },
  );

  it('[CT-02j] lookup accepts user.lookup only; detail accepts either point', () => {
    expect(flat(operation('get', `${U}/lookup`).description)).toContain(
      '`user.list` alone does not allow it',
    );
    expect(flat(operation('get', `${U}/{user_id}`).description)).toContain(
      '`user.list` or `user.lookup` (either is enough',
    );
  });

  it('[CT-02j] every sudo write needs the sudo tier and shows the 10003 sudo example; the others none', () => {
    for (const [method, path] of SUDO_WRITES) {
      const op = operation(method, path);
      expect(flat(op.description), path).toMatch(/Step-up(?: only for `unfreeze`)?: sudo/);
      expect(flat(op.description), path).toContain('`data.tier=sudo`');
      const stepUp = errorExamples(op).filter((e) => e.code === 10003);
      expect(stepUp, path).toEqual([expect.objectContaining({ data: { tier: 'sudo' } })]);
    }
    for (const [method, path, operationId] of WRITES) {
      if (SUDO.has(operationId)) continue;
      const op = operation(method, path);
      const stepUp = errorExamples(op).filter((e) => e.code === 10003);
      expect(stepUp, path).toEqual([]);
      expect(flat(op.description), path).not.toMatch(/X-Step-Up-Token|data\.tier|10003/);
    }
  });

  it('[CT-02j] risk-state maps ban / unban to risk.ban and freeze / unfreeze to risk.freeze', () => {
    const description = flat(operation('put', `${U}/{user_id}/risk-state`).description);
    expect(description).toContain('`ban` and `unban` need `risk.ban`');
    expect(description).toContain('`freeze` and `unfreeze` need `risk.freeze`');
    expect(description).toContain('an appealing user is refused for every action');
    expect(description).toContain('A banned user is not frozen directly');
  });

  it('[CT-02j] the reveal response is never cached', () => {
    const ok = operation('post', `${U}/{user_id}/reveal`).responses['200']!;
    expect(ok.headers?.['Cache-Control']?.schema?.enum).toEqual(['no-store']);
  });

  it('[CT-02j] the real contract still passes conformance', () => {
    expect(checkConformance(loadEnums(), loadErrorCodes().codes)).toEqual([]);
  });
});

describe('error codes and examples', () => {
  it('[CT-02j] 30154 (business, 422) and 44004 (risk segment, 403) are live; 20902 lists the two new resources', () => {
    expect(errorCodes[30154]).toMatchObject({ http: 422, retry_kind: 'never', deprecated: false });
    expect(errorCodes[44004]).toMatchObject({ http: 403, retry_kind: 'never', deprecated: false });
    expect(errorCodes[20902].data.resource).toEqual(
      expect.arrayContaining(['user_risk_state', 'union_binding']),
    );
  });

  it('[CT-02j] request, 200 and error examples satisfy their schemas; errors use listed codes and data', () => {
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

  it('[CT-02j] CAS conflicts carry user_risk_state on risk-state and union_binding on the binding writes', () => {
    for (const [method, path] of WRITES.filter(([, p]) => !p.endsWith('/reveal'))) {
      const resource = path.endsWith('/risk-state') ? 'user_risk_state' : 'union_binding';
      const conflicts = errorExamples(operation(method, path)).filter((e) => e.code === 20902);
      expect(conflicts.length, path).toBeGreaterThan(0);
      for (const conflict of conflicts) {
        expect(conflict, path).toEqual(expect.objectContaining({ data: { resource } }));
      }
      expect(operation(method, path).description, path).toContain(`\`data.resource=${resource}\``);
    }
  });
});

describe('bodies and rows', () => {
  it('[CT-02j] risk-state body: action, reason ≤ 200 and expected_row_version are required', () => {
    const validate = compile('AdminUserRiskStateUpdateRequest');
    const ban = {
      action: 'ban',
      reason_category: 'malicious_rights',
      reason: '原因',
      expected_row_version: 0,
    };
    expect(validate(ban)).toBe(true);
    expect(validate({ action: 'unban', reason: '解封', expected_row_version: 1 })).toBe(true);
    expect(validate({ ...ban, action: 'freeze', frozen_until: '2026-11-30T00:00:00+08:00' })).toBe(
      true,
    );
    expect(validate({ ...ban, action: 'freeze', frozen_until: null })).toBe(true);
    expect(validate({ ...ban, action: 'appeal' })).toBe(false);
    expect(validate({ ...ban, reason_category: 'spam' })).toBe(false);
    expect(validate({ ...ban, reason: '' })).toBe(false);
    expect(validate({ ...ban, reason: 'x'.repeat(201) })).toBe(false);
    expect(validate({ ...ban, expected_row_version: -1 })).toBe(false);
    expect(validate({ ...ban, expected_row_version: null })).toBe(true);
    expect(validate({ ...ban, state: 'banned' })).toBe(false);
    for (const field of ['action', 'reason', 'expected_row_version']) {
      const partial: Record<string, unknown> = { ...ban };
      delete partial[field];
      expect(validate(partial), `missing ${field}`).toBe(false);
    }
  });

  it('[CT-02j] binding and reveal bodies need a reason; reveal only takes field=phone', () => {
    const binding = compile('AdminUserUnionBindingActionRequest');
    expect(binding({ reason: '错绑', expected_row_version: 0 })).toBe(true);
    expect(binding({ reason: '错绑' })).toBe(false);
    expect(binding({ expected_row_version: 0 })).toBe(false);
    expect(binding({ reason: '错绑', expected_row_version: 0, platform: 'taobao' })).toBe(false);
    expect(binding({ reason: '错绑', expected_row_version: null })).toBe(false);
    const reveal = compile('AdminUserRevealRequest');
    expect(reveal({ field: 'phone', reason: '核对' })).toBe(true);
    expect(reveal({ field: 'id_no', reason: '核对' })).toBe(false);
    expect(reveal({ field: 'phone' })).toBe(false);
  });

  it('[CT-02j] list rows have no full phone or identity fields; the phone is masked or null', () => {
    const row = compile('AdminUserListItem');
    const item = {
      user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01',
      nickname: '凑狸用户5678',
      phone_masked: '138****5678',
      level: 'L1',
      risk_state: 'normal',
      created_at: '2026-10-12T09:00:00+08:00',
    };
    expect(row(item)).toBe(true);
    expect(row({ ...item, phone_masked: null })).toBe(true);
    expect(row({ ...item, phone: '13800005678' })).toBe(false);
    expect(row({ ...item, id_no: '1****************X' })).toBe(false);
    expect(row({ ...item, risk_state: 'deleted' })).toBe(false);
  });

  it('[CT-02j] a risk state without a row has row_version null; a row has an integer ≥ 0', () => {
    const state = compile('AdminUserRiskState');
    const none = {
      state: 'normal',
      reason_category: null,
      reason: null,
      frozen_until: null,
      changed_by: null,
      changed_at: null,
      row_version: null,
    };
    expect(state(none)).toBe(true);
    expect(state({ ...none, row_version: 0 })).toBe(true);
    expect(state({ ...none, row_version: -1 })).toBe(false);
    const noVersion: Record<string, unknown> = { ...none };
    delete noVersion['row_version'];
    expect(state(noVersion)).toBe(false);
  });

  it('[CT-02j] a binding row carries blocked_reason only from its enum and its row_version', () => {
    const row = compile('AdminUserUnionBinding');
    const binding = {
      platform: 'taobao',
      status: 'blocked',
      blocked_reason: 'admin_disable',
      bound_at: '2026-10-10T21:00:00+08:00',
      released_at: null,
      cooldown_until: null,
      reason: '停用',
      row_version: 2,
    };
    expect(row(binding)).toBe(true);
    expect(row({ ...binding, status: 'active', blocked_reason: null })).toBe(true);
    expect(row({ ...binding, blocked_reason: 'cooling' })).toBe(false);
    expect(row({ ...binding, relation_id: '123' })).toBe(false);
    expect(row({ ...binding, row_version: null })).toBe(false);
    const noVersion: Record<string, unknown> = { ...binding };
    delete noVersion['row_version'];
    expect(row(noVersion)).toBe(false);
  });
});
