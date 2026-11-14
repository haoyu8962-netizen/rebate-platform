import { expect, it } from 'vitest';
import { createValidatorCompiler, validationErrorEnvelope, type ValidationIssue } from './index.ts';

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
