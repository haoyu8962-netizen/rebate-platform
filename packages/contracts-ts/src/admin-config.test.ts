// CT-02i: /admin/v1/kill-switches and /admin/v1/config-items, the admin configuration center and
// emergency switches (04 §10, §10.2, §11.2; 05 F1-10). x-implementation is not asserted, so the
// F1-10d / F1-10e implementations can drop planned. Reads the dereferenced contract and validates
// every example with the API workspace's strict Ajv (same loader as admin-platform-icons.test.ts).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { enums, errorCodes, type Schema } from './index.ts';

// scripts/ is outside this package's rootDir, so it is loaded at run time (as in openapi.test.ts).
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
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Operation = {
  operationId: string;
  description: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { required: boolean; content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
  'x-auth': string;
  'x-implementation'?: string;
  'x-error-codes': number[];
  'x-idempotent'?: boolean;
  'x-step-up'?: string;
};
type Document = {
  paths: Record<string, Partial<Record<Method, Operation>>>;
  components: { schemas: Record<string, object & { required?: string[] }> };
};

const SW = '/admin/v1/kill-switches';
const CI = '/admin/v1/config-items';
const READ = [10001, 10403];
const WRITE = [10001, 10003, 10403, 20001, 20902];
/** The eight operations of CT-02i (task §9.2) and the codes each must list. */
const OPERATIONS = [
  ['get', SW, 'adminListKillSwitches', READ],
  ['put', `${SW}/{key}`, 'adminUpdateKillSwitch', WRITE],
  ['get', CI, 'adminListConfigItems', READ],
  ['get', `${CI}/{key}`, 'adminGetConfigItem', [10001, 10403, 20001]],
  ['get', `${CI}/{key}/versions`, 'adminListConfigItemVersions', [10001, 10403, 20001]],
  ['put', `${CI}/{key}`, 'adminUpdateConfigItem', WRITE],
  ['post', `${CI}/batch`, 'adminBatchUpdateConfigItems', WRITE],
  ['post', `${CI}/{key}/rollback`, 'adminRollbackConfigItem', WRITE],
] as const;
const WRITES = OPERATIONS.filter(([method]) => method !== 'get');

/** Codes every admin operation may return without listing them (openapi info.description). */
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

function errorExamples(op: Operation): { code: number; data?: Record<string, unknown> }[] {
  const media = op.responses['4XX']!.content!['application/json']!;
  return examplesOf(media).map(([, v]) => v as { code: number; data?: Record<string, unknown> });
}

const compile = (name: string) => ajv.compile(contract.components.schemas[name]!);

describe('configuration center and emergency switch operations (04 §10.2, §11.2)', () => {
  it.each(OPERATIONS)(
    '[CT-02i] %s %s (%s) is an admin operation without Idempotency-Key',
    (method, path, operationId, codes) => {
      const op = operation(method, path);
      expect(op.operationId).toBe(operationId);
      expect(op['x-auth']).toBe('admin');
      expect(op.security).toEqual([{ adminBearerAuth: [] }]);
      expect(op.tags).toEqual(['admin-config']);
      expect(op['x-error-codes']).toEqual([...codes]);
      // BR-ID-34 strict list「改自动到账开关与上限」: the writes are marked strict (by key, see below).
      expect(op['x-step-up']).toBe(method === 'get' ? undefined : 'strict');
      expect(op['x-idempotent']).toBeUndefined();
      const names = (op.parameters ?? []).map((p) => p.name.toLowerCase());
      expect(names).not.toContain('idempotency-key');
      // Reads never take a step-up token; every write lists the optional admin header.
      expect(names.includes('x-step-up-token')).toBe(method !== 'get');
    },
  );

  it('[CT-02i] the permission points named in the descriptions are listed admin_permission values', () => {
    for (const point of ['switch.all', 'switch.payout', 'switch.pay']) {
      expect(enums.admin_permission).toContain(point);
      expect(operation('get', SW).description).toContain(`\`${point}\``);
    }
    for (const point of ['config.general', 'config.risk', 'config.business']) {
      expect(enums.admin_permission).toContain(point);
      expect(operation('get', CI).description).toContain(`\`${point}\``);
    }
  });

  it('[CT-02i] switch writes map payout keys to switch.payout, pay keys to switch.pay, the rest to switch.all', () => {
    const description = operation('put', `${SW}/{key}`).description.replace(/\s+/g, ' ');
    expect(description).toContain(
      '`payout.channel_enabled.<channel>` and `payout.channel_paused.<channel>` need `switch.all` or `switch.payout`',
    );
    expect(description).toContain(
      '`pay.enabled` and `pay.channel_enabled.<pay_channel>` need `switch.all` or `switch.pay`',
    );
    expect(description).toContain('`withdraw.auto_payout.enabled` included, needs `switch.all`');
    expect(description).toContain('only `withdraw.auto_payout.enabled` is strict');
    expect(description).toContain('`data.tier=strict`');
    expect(description).toContain('needs no step-up (BR-ID-34: none)');
    expect(description).toContain('within 10 seconds');
  });

  it('[CT-02i] config writes are strict for the auto-payout and payout caps, none for every other key', () => {
    for (const [method, path] of [
      ['put', `${CI}/{key}`],
      ['post', `${CI}/batch`],
      ['post', `${CI}/{key}/rollback`],
    ] as const) {
      const description = operation(method, path).description.replace(/\s+/g, ' ');
      expect(description, path).toContain('`config.general`, `config.risk` or `config.business`');
      expect(description, path).toContain('BR-ID-34 strict list「改自动到账开关与上限」');
      expect(description, path).toContain('`payout.single_cap_fen`');
      expect(description, path).toContain('`data.tier=strict`');
      expect(description, path).toMatch(/no step-up \(BR-ID-34: none\)|none for every other key/);
    }
  });

  it('[CT-02i] the admin step-up header is optional, distinct from the app one, and only on these admin writes', () => {
    const header = (op: Operation) =>
      (op.parameters ?? []).find((p) => p.name.toLowerCase() === 'x-step-up-token');
    for (const [method, path] of WRITES) {
      expect(header(operation(method, path))).toMatchObject({ in: 'header', required: false });
    }
    // Raw contract: within the switch and config paths the writes reference AdminStepUpToken,
    // never the app StepUpToken (other admin writes, such as CT-02j's, reference it too).
    const raw = readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8');
    const block = raw.slice(raw.indexOf(`  ${SW}:\n`), raw.indexOf(`  /v1/agent/sessions:\n`));
    const admin = block.match(/#\/components\/parameters\/AdminStepUpToken'/g) ?? [];
    expect(admin.length).toBe(WRITES.length);
    expect(block).not.toContain("parameters/StepUpToken'");
  });

  it('[CT-02i] the real contract still passes conformance', () => {
    expect(checkConformance(loadEnums(), loadErrorCodes().codes)).toEqual([]);
  });
});

describe('examples', () => {
  it('[CT-02i] request, 200 and error examples satisfy their schemas; errors use listed codes and data', () => {
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
        const { code, data } = value as { code: number; data?: Record<string, unknown> };
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

  it('[CT-02i] 20902 carries resource kill_switch on the switch write and config_item on the config writes', () => {
    expect(errorCodes[20902].data.resource).toEqual(
      expect.arrayContaining(['config_item', 'kill_switch']),
    );
    for (const [method, path] of WRITES) {
      const conflicts = errorExamples(operation(method, path)).filter((e) => e.code === 20902);
      const resource = path.startsWith(SW) ? 'kill_switch' : 'config_item';
      expect(conflicts, path).toEqual([expect.objectContaining({ data: { resource } })]);
      expect(operation(method, path).description, path).toContain(`\`data.resource=${resource}\``);
    }
  });

  it('[CT-02i] every write shows the 10003 strict example', () => {
    for (const [method, path] of WRITES) {
      const stepUp = errorExamples(operation(method, path)).filter((e) => e.code === 10003);
      expect(stepUp, path).toEqual([expect.objectContaining({ data: { tier: 'strict' } })]);
    }
  });

  it('[CT-02i] batch errors: failing keys listed in fields, mixed points as [items]', () => {
    const fields = errorExamples(operation('post', `${CI}/batch`))
      .filter((e) => e.code === 20001)
      .map((e) => e.data?.['fields']);
    expect(fields).toContainEqual(['items']);
    expect(fields).toContainEqual([
      'withdraw.daily_count_per_user',
      'withdraw.monthly_count_per_user',
    ]);
    const description = operation('post', `${CI}/batch`).description.replace(/\s+/g, ' ');
    expect(description).toContain('takes effect or nothing does');
    expect(description).toContain('only then are the versions compared');
  });

  it('[CT-02i] withdraw.auto_payout.enabled can only be turned off: true is 20001 [value] (BR-WDR-30)', () => {
    const op = operation('put', `${SW}/{key}`);
    const description = op.description.replace(/\s+/g, ' ');
    expect(description).toContain(
      '`withdraw.auto_payout.enabled` can only be turned off from the console',
    );
    expect(description).toContain('`true` is 20001 with `data.fields=[value]`');
    const raw = op.responses['4XX']!.content!['application/json']!.examples!;
    expect(raw['autoPayoutEnableRefused']?.value).toMatchObject({
      code: 20001,
      data: { fields: ['value'] },
    });
    const list = operation('get', SW).description.replace(/\s+/g, ' ');
    expect(list).toContain('`withdraw.auto_payout.enabled` means it can only be turned off');
    const editable = (
      contract.components.schemas['AdminKillSwitch'] as {
        properties: Record<string, { description: string }>;
      }
    ).properties['admin_editable']!.description.replace(/\s+/g, ' ');
    expect(editable).toContain(
      '`withdraw.auto_payout.enabled` true means it can only be turned off',
    );
  });

  it('[CT-02i] rollback rejects an unknown version as [to_version]', () => {
    const fields = errorExamples(operation('post', `${CI}/{key}/rollback`))
      .filter((e) => e.code === 20001)
      .map((e) => e.data?.['fields']);
    expect(fields).toContainEqual(['to_version']);
  });
});

describe('bodies and rows', () => {
  it('[CT-02i] switch and item writes need value and expected_version; reason is optional, at most 200', () => {
    for (const name of ['AdminKillSwitchUpdateRequest', 'AdminConfigItemUpdateRequest']) {
      const validate = compile(name);
      expect(validate({ value: false, expected_version: 0 }), name).toBe(true);
      expect(validate({ value: { a: [1] }, expected_version: 3, reason: '原因' }), name).toBe(true);
      expect(validate({ value: 'maintenance', expected_version: 1 }), name).toBe(true);
      expect(validate({ expected_version: 1 }), name).toBe(false);
      expect(validate({ value: true }), name).toBe(false);
      expect(validate({ value: true, expected_version: -1 }), name).toBe(false);
      expect(validate({ value: true, expected_version: 1, reason: '' }), name).toBe(false);
      expect(validate({ value: true, expected_version: 1, reason: 'x'.repeat(201) }), name).toBe(
        false,
      );
      expect(validate({ value: true, expected_version: 1, key: 'withdraw.enabled' }), name).toBe(
        false,
      );
    }
  });

  it('[CT-02i] a batch has 1 to 200 entries, each with key, value and expected_version', () => {
    const validate = compile('AdminConfigItemBatchRequest');
    const entry = { key: 'favorites.max_per_user', value: 200, expected_version: 2 };
    expect(validate({ items: [entry] })).toBe(true);
    expect(validate({ items: [entry], reason: '批量' })).toBe(true);
    expect(validate({ items: [] })).toBe(false);
    expect(validate({ items: Array.from({ length: 201 }, () => entry) })).toBe(false);
    expect(validate({ items: [{ key: entry.key, value: 1 }] })).toBe(false);
    expect(validate({ items: [{ ...entry, key: 'Bad Key' }] })).toBe(false);
    expect(validate({ items: [{ ...entry, permission: 'config.general' }] })).toBe(false);
  });

  it('[CT-02i] rollback names a stored version and the current version (both ≥ 1)', () => {
    const validate = compile('AdminConfigItemRollbackRequest');
    expect(validate({ to_version: 1, expected_version: 3 })).toBe(true);
    expect(validate({ to_version: 1, expected_version: 3, reason: '回滚' })).toBe(true);
    expect(validate({ to_version: 0, expected_version: 3 })).toBe(false);
    expect(validate({ to_version: 1, expected_version: 0 })).toBe(false);
    expect(validate({ to_version: 1 })).toBe(false);
    expect(validate({ to_version: 1, expected_version: 3, value: 1 })).toBe(false);
  });

  it('[CT-02i] keys are dotted and concrete', () => {
    const validate = compile('AdminConfigKey');
    for (const key of [
      'withdraw.enabled',
      'convert.enabled.taobao',
      'pay.channel_enabled.wechat_pay',
      'agent.tools.get_my_earnings.enabled',
      'tax.SERVICE_FEE.rate_bp',
    ]) {
      expect(validate(key), key).toBe(true);
    }
    for (const key of ['', 'convert.enabled.<platform>', 'Withdraw.enabled', 'a..b', 'a.', 'a/b']) {
      expect(validate(key), key).toBe(false);
    }
  });

  it('[CT-02i] a switch row carries default, permissions and version; an unset switch has value null', () => {
    const row = compile('AdminKillSwitch');
    const unset = {
      key: 'convert.off_reason.pdd',
      value: null,
      default: 'not_launched',
      value_type: 'enum',
      options: ['not_launched', 'maintenance'],
      permissions: ['switch.all'],
      admin_editable: true,
      version: 0,
      updated_by: null,
      updated_at: null,
    };
    expect(row(unset)).toBe(true);
    expect(row({ ...unset, permissions: [] })).toBe(false);
    expect(row({ ...unset, value_type: 'array' })).toBe(false);
    expect(row({ ...unset, version: -1 })).toBe(false);
    for (const field of Object.keys(unset)) {
      const partial: Record<string, unknown> = { ...unset };
      delete partial[field];
      expect(row(partial), `missing ${field}`).toBe(false);
    }
    expectTypeOf<Schema<'AdminKillSwitch'>['version']>().toEqualTypeOf<number>();
    expectTypeOf<Schema<'AdminKillSwitch'>['permissions']>().toEqualTypeOf<string[]>();
  });

  it('[CT-02i] a config row names its single permission point; versions list value, author and reason', () => {
    const row = compile('AdminConfigItem');
    const item = {
      key: 'withdraw.daily_count_per_user',
      value: 1,
      value_type: 'number',
      options: null,
      permission: 'config.business',
      admin_editable: true,
      version: 1,
      updated_by: 'ops-yi',
      updated_at: '2026-10-09T10:05:00+08:00',
    };
    expect(row(item)).toBe(true);
    expect(row({ ...item, permissions: ['config.business'] })).toBe(false);
    const version = compile('AdminConfigItemVersion');
    const v = {
      version: 1,
      value: 1,
      updated_by: null,
      reason: null,
      created_at: '2026-10-09T10:05:00+08:00',
    };
    expect(version(v)).toBe(true);
    expect(version({ ...v, version: 0 })).toBe(false);
    expect(version({ ...v, reason: 'x'.repeat(201) })).toBe(false);
    expectTypeOf<Schema<'AdminConfigItem'>['permission']>().toEqualTypeOf<string>();
  });
});
