// B2-09zc · Contract validation of the batch approval / rejection bodies, run after the guard at
// the point of the contract's order of checks (CT-24zv: `fund.settle_adjust` → step-up → body →
// batch_id; precedent B1-12z notify-channels.validation.ts). The two write routes therefore mount
// the contract's path and header schemas only; the body schema comes from the generated route
// schemas of the same operations (platform contractRouteSchema), compiled the way platform's
// validator compiler does it: Ajv 2020, strict, all errors, the body not coerced; int32 / int64 as
// platform's. Field names follow platform's validationErrorEnvelope.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';
import { contractRouteSchema } from '../../../platform/index.ts';

/** null: valid; otherwise the offending fields (data.fields of 20001). */
export type BodyValidator = (value: unknown) => string[] | null;

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv;
}

function invalidFields(errors: readonly ErrorObject[]): string[] {
  const fields = new Set<string>();
  for (const error of errors) {
    const segments =
      error.instancePath === ''
        ? []
        : error.instancePath
            .slice(1)
            .split('/')
            .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    const property: unknown =
      error.keyword === 'required'
        ? error.params['missingProperty']
        : error.keyword === 'additionalProperties'
          ? error.params['additionalProperty']
          : undefined;
    if (typeof property === 'string') segments.push(property);
    fields.add(segments.length > 0 ? segments.join('.') : 'body');
  }
  return [...fields];
}

function validator(compiled: ValidateFunction): BodyValidator {
  return (value) => (compiled(value) ? null : invalidFields(compiled.errors ?? []));
}

export interface SettleAdjustBodyValidators {
  readonly approve: BodyValidator;
  readonly reject: BodyValidator;
}

/** Built once per entry: compiling at startup makes a bad contract fail there, not per request. */
export function createSettleAdjustBodyValidators(): SettleAdjustBodyValidators {
  const ajv = createAjv();
  return {
    approve: validator(ajv.compile(contractRouteSchema('adminApproveSettleAdjustBatch').body)),
    reject: validator(ajv.compile(contractRouteSchema('adminRejectSettleAdjustBatch').body)),
  };
}

/** The route schema of a write without its body (the body is checked after the guard). */
export function withoutBody(
  operationId: 'adminApproveSettleAdjustBatch' | 'adminRejectSettleAdjustBatch',
): object {
  const schema = contractRouteSchema(operationId);
  return { params: schema.params, headers: schema.headers };
}
