// CT-26zs: the reserved WeChat mini program step on a jump plan (04 §8.4, BR-ATTR-27). Same
// loader and strict Ajv as jump-step.test.ts; the pairing of `mini_program` with
// type=mini_program follows the `sdk` pairing there (no top-level oneOf, held by the server and
// by this consistency check over the contract examples).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { enums, type Schema } from './index.ts';

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

type Document = { components: { schemas: Record<string, object> } };

let contract: Document;
let validateStep: (data: unknown) => boolean;

beforeAll(async () => {
  contract = (await dereference(
    fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url)),
  )) as Document;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  validateStep = ajv.compile(contract.components.schemas['JumpStep']!);
});

const userName = 'gh_0a1b2c3d4e5f';
const step = { type: 'mini_program', value: userName, mini_program: { user_name: userName } };

it('CT-26zs: a mini_program step with user_name, and with path and release, is valid', () => {
  expect(validateStep(step)).toBe(true);
  for (const path of ['', 'pages/item/index?id=7']) {
    const full = {
      ...step,
      mini_program: { user_name: userName, path, mini_program_type: 'release' },
    };
    expect(validateStep(full), path).toBe(true);
  }
});

it('CT-26zs: a mini_program instruction without a gh_ original ID, with app_id or another type, is refused', () => {
  for (const mini_program of [
    {},
    { user_name: '' },
    { user_name: 'gh_' },
    { user_name: 'wx0a1b2c3d4e5f' },
    { user_name: `${userName} ` },
    { user_name: userName, app_id: 'wx0a1b2c3d4e5f' },
    { user_name: userName, mini_program_type: 'preview' },
    { user_name: userName, path: 7 },
  ]) {
    expect(validateStep({ ...step, mini_program }), JSON.stringify(mini_program)).toBe(false);
  }
});

// Like sdk, the schema alone does not pair mini_program with type=mini_program.
it('CT-26zs: the schema alone does not pair mini_program with type=mini_program (server-side guarantee)', () => {
  expect(validateStep({ type: 'mini_program', value: userName })).toBe(true);
  expect(validateStep({ ...step, type: 'h5' })).toBe(true);
});

function jumpSteps(
  node: unknown,
  found: Record<string, unknown>[] = [],
  seen = new WeakSet<object>(),
): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object' || seen.has(node)) return found;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) jumpSteps(item, found, seen);
  } else {
    for (const [key, child] of Object.entries(node)) {
      const steps = key === 'primary' ? [child] : key === 'fallbacks' ? child : [];
      for (const item of Array.isArray(steps) ? steps : []) {
        if (
          item !== null &&
          typeof item === 'object' &&
          (enums.jump_type as readonly unknown[]).includes((item as { type?: unknown }).type) &&
          typeof (item as { value?: unknown }).value === 'string'
        ) {
          found.push(item as Record<string, unknown>);
        }
      }
      jumpSteps(child, found, seen);
    }
  }
  return found;
}

it('CT-26zs: every jump step in the contract examples and this fixture pairs mini_program with type=mini_program', () => {
  for (const item of [...jumpSteps(contract), step]) {
    const isMiniProgram = item['type'] === 'mini_program';
    expect('mini_program' in item, JSON.stringify(item)).toBe(isMiniProgram);
    if (isMiniProgram) {
      expect(item['value']).toBe((item['mini_program'] as { user_name: string }).user_name);
    }
    expect(validateStep(item), JSON.stringify(item)).toBe(true);
  }
});

it('CT-26zs: jump_type lists mini_program next to the five earlier types and the generated type accepts the step', () => {
  const typed: Schema<'JumpStep'> = {
    type: 'mini_program',
    value: userName,
    mini_program: { user_name: userName, path: 'pages/item/index', mini_program_type: 'release' },
  };
  expect(typed.mini_program?.user_name).toBe(userName);
  expect([...enums.jump_type].sort()).toEqual(
    ['copy_tpwd', 'h5', 'mini_program', 'scheme', 'sdk', 'universal_link'].sort(),
  );
});
