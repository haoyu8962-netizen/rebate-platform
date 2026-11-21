import { expect, it } from 'vitest';
import { contractRouteSchema } from './contract-routes.ts';
import {
  createValidatorCompiler,
  validationErrorEnvelope,
  type JsonSchema,
  type ValidationIssue,
} from './index.ts';

// The shape of SendSmsCodeRequest (contracts/openapi.yaml): phone required only for login / bind,
// stated with if / then (BR-ID-08, D10-1588 ②).
const conditionalBody = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose'],
  if: {
    type: 'object',
    additionalProperties: true,
    properties: { purpose: { enum: ['login', 'bind'] } },
  },
  then: {
    type: 'object',
    additionalProperties: true,
    properties: { phone: true },
    required: ['phone'],
  },
  properties: {
    phone: { type: 'string' },
    purpose: { type: 'string', enum: ['login', 'bind', 'step_up'] },
  },
};

const fieldsOf = (validation: readonly ValidationIssue[], part = 'body'): readonly string[] =>
  validationErrorEnvelope(
    { code: 'FST_ERR_VALIDATION', validation, validationContext: part },
    'trace-1',
  )?.body.data.fields ?? [];

const errorsOf = (data: unknown): readonly ValidationIssue[] => {
  const validate = createValidatorCompiler()({ schema: conditionalBody, httpPart: 'body' });
  expect(validate(data)).toBe(false);
  return validate.errors ?? [];
};

it('[AC-B1-02zzz-UNIT#9] if/then not met: fields name only the missing field, not the companion if error', () => {
  const errors = errorsOf({ purpose: 'login' });
  expect(errors.map((issue) => issue.keyword)).toEqual(['required', 'if']);
  expect(fieldsOf(errors)).toEqual(['phone']);
  const withExtra = errorsOf({ purpose: 'bind', extra: 1 });
  expect(withExtra.map((issue) => issue.keyword)).toContain('if');
  expect(fieldsOf(withExtra)).toEqual(['phone', 'extra']);
});

it('[AC-B1-02zzz-UNIT#10] only if errors left: they are kept, so fields is never empty', () => {
  const ifAt = (instancePath: string): ValidationIssue => ({
    keyword: 'if',
    instancePath,
    params: { failingKeyword: 'then' },
    message: 'must match "then" schema',
  });
  expect(fieldsOf([ifAt('')])).toEqual(['body']);
  expect(fieldsOf([ifAt('')], 'querystring')).toEqual(['querystring']);
  expect(fieldsOf([ifAt('/items/0'), ifAt('/items/1')])).toEqual(['items.0', 'items.1']);
});

// FU-20001-ONEOF-FIELDS-NOISE r2 (money r1 S2, D10-2348 甲): one combinator instance is its
// schemaPath plus its instancePath, so each array item picks its own branch.
const itemsBody = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        unevaluatedProperties: false,
        anyOf: [
          {
            type: 'object',
            properties: {
              kind: { const: 'link' },
              label: { type: 'string' },
              'link/text~value': { type: 'string', minLength: 1 },
            },
            required: ['kind', 'label', 'link/text~value'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { kind: { const: 'reference' }, item_ref: { type: 'string' } },
            required: ['kind', 'item_ref'],
          },
        ],
      },
    },
  },
};

const errorsFor = (schema: JsonSchema, data: unknown): readonly ValidationIssue[] => {
  const validate = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(validate(data)).toBe(false);
  return validate.errors ?? [];
};

it('[AC-B1-01zzw-UNIT#1] the same anyOf under two array items narrows each item on its own', () => {
  const errors = errorsFor(itemsBody, {
    items: [{ kind: 'link', 'link/text~value': 'ok' }, { kind: 'reference' }],
  });
  expect([...fieldsOf(errors)].sort()).toEqual([
    'items.0',
    'items.0.label',
    'items.1',
    'items.1.item_ref',
  ]);
});

// adminCreateAdjustment: a schema failure always names `body` and more than one field, so the
// admin page's single-field prompts (user_id, reverses_adjust_id in
// apps/admin/src/pages/adjustments/write.ts) never fire on it (D10-2348 ③).
it.each<[string, object]>([
  [
    'new adjustment with amount_fen 0',
    {
      user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02',
      direction: 'increase',
      amount_fen: 0,
      reason_code: 'OTHER',
      note: '更正',
    },
  ],
  [
    'reversal without reverses_adjust_id, carrying new-adjustment fields',
    { note: '红冲', user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02', amount_fen: 100 },
  ],
  [
    'new adjustment with reason_code RESTORE',
    {
      user_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02',
      direction: 'increase',
      amount_fen: 100,
      reason_code: 'RESTORE',
      note: '更正',
    },
  ],
  [
    'reversal carrying direction',
    {
      reverses_adjust_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c03',
      note: '红冲',
      direction: 'decrease',
    },
  ],
])('[AC-B1-01zzw-UNIT#2] adminCreateAdjustment schema failure: %s', (_title, body) => {
  const schema = contractRouteSchema('adminCreateAdjustment').body;
  const fields = fieldsOf(errorsFor(schema, body));
  expect(fields).toContain('body');
  expect(fields.length).toBeGreaterThan(1);
});
