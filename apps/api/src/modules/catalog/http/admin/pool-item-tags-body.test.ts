// CT-07e (D10-1777 / D10-1784): the outer edge of `tags` in the request bodies of adminAddPoolItem
// and adminUpdatePoolItem, as the generated route schema declares it (AdminPoolItemTagsInput: at
// most 100 items of at most 256 characters). The real bounds after normalization are another layer
// (the server's 20001 data.fields=[tags]) and are not tested here. Compiled with the same strict
// Ajv2020 options as the body validator (platform/validation createValidatorCompiler).
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import { contractRouteSchema } from '../../../platform/index.ts';

type Validate = ((data: unknown) => boolean) & {
  errors?: readonly { keyword: string; instancePath: string }[] | null;
};

let validateAdd: Validate;
let validateUpdate: Validate;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  const bodyOf = (operationId: 'adminAddPoolItem' | 'adminUpdatePoolItem'): object =>
    (contractRouteSchema(operationId) as { body: object }).body;
  validateAdd = ajv.compile(bodyOf('adminAddPoolItem'));
  validateUpdate = ajv.compile(bodyOf('adminUpdatePoolItem'));
});

const ADD_BASE = { item_ref: 'demo-item-ref-0001', sort: 10, start_at: null, end_at: null };
const UPDATE_BASE = { sort: 10 };
const tagsOf = (count: number, length = 1): string[] =>
  Array.from({ length: count }, (_, i) => String(i % 10).repeat(length));

const cases = [
  ['adminAddPoolItem', () => validateAdd, ADD_BASE],
  ['adminUpdatePoolItem', () => validateUpdate, UPDATE_BASE],
] as const;

for (const [operationId, validator, base] of cases) {
  it(`[CT-07e][D10-1784#1] ${operationId}: exactly 100 tags pass the body schema; 101 are refused at /tags`, () => {
    const validate = validator();
    expect(validate({ ...base, tags: tagsOf(100) })).toBe(true);
    expect(validate({ ...base, tags: tagsOf(101) })).toBe(false);
    expect(validate.errors).toContainEqual(
      expect.objectContaining({ keyword: 'maxItems', instancePath: '/tags' }),
    );
  });

  it(`[CT-07e][D10-1784#2] ${operationId}: a tag of 256 characters passes the body schema; 257 is refused at /tags/0`, () => {
    const validate = validator();
    expect(validate({ ...base, tags: ['a'.repeat(256)] })).toBe(true);
    expect(validate({ ...base, tags: ['a'.repeat(257)] })).toBe(false);
    expect(validate.errors).toContainEqual(
      expect.objectContaining({ keyword: 'maxLength', instancePath: '/tags/0' }),
    );
  });

  it(`[CT-07e][D10-1784#3] ${operationId}: both edges at once (100 tags of 256 characters) pass; lengths count code points`, () => {
    const validate = validator();
    expect(validate({ ...base, tags: tagsOf(100, 256) })).toBe(true);
    // 256 astral characters are 512 UTF-16 units; Ajv's maxLength counts code points.
    expect(validate({ ...base, tags: ['😀'.repeat(256)] })).toBe(true);
    expect(validate({ ...base, tags: ['😀'.repeat(257)] })).toBe(false);
  });
}
